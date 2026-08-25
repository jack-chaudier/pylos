//! The Pylos shell.
//!
//! The window is the transcript; everything else lives in `@pylos/server`,
//! which this shell starts as a sidecar and stops on exit. The webview reveals
//! the window itself once `/api/health` answers, so a slow first start never
//! shows an empty frame.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tauri::{Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct Sidecar(Mutex<Option<CommandChild>>);

const DEFAULT_PORT: &str = "7334";
const REVEAL_AFTER_MS: u64 = 9_000;
const IO_CHUNK: usize = 32 * 1024;
const SOCKET_TIMEOUT_MS: u64 = 250;
const MAX_COMPAT_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PASSPHRASE_BYTES: usize = 12 * 1024;
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const MAX_RESPONSE_HEADERS: usize = 64 * 1024;
const RAW_IMPORT_CONTENT_TYPE: &str = "application/octet-stream";
const RAW_IMPORT_PASSPHRASE_HEADER: &str = "X-Pylos-Passphrase";

type TransferTable = Mutex<HashMap<String, Arc<AtomicBool>>>;

fn transfers() -> &'static TransferTable {
    static TABLE: OnceLock<TransferTable> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn begin_transfer(id: &str) -> Result<Arc<AtomicBool>, String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("invalid transfer id".to_string());
    }
    let mut table = transfers()
        .lock()
        .map_err(|_| "transfer table is unavailable".to_string())?;
    if table.contains_key(id) {
        return Err("transfer id is already active".to_string());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    table.insert(id.to_string(), cancelled.clone());
    Ok(cancelled)
}

fn end_transfer(id: &str) {
    if let Ok(mut table) = transfers().lock() {
        table.remove(id);
    }
}

fn cancelled(flag: &AtomicBool) -> Result<(), String> {
    if flag.load(Ordering::Relaxed) {
        Err("bundle transfer cancelled".to_string())
    } else {
        Ok(())
    }
}

fn socket_timeout() -> Duration {
    Duration::from_millis(SOCKET_TIMEOUT_MS)
}

fn retryable_io(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
    )
}

fn read_cancelled(
    reader: &mut impl Read,
    output: &mut [u8],
    flag: &AtomicBool,
) -> Result<usize, String> {
    loop {
        cancelled(flag)?;
        match reader.read(output) {
            Ok(read) => return Ok(read),
            Err(error) if retryable_io(&error) => continue,
            Err(error) => return Err(format!("could not read sidecar response: {error}")),
        }
    }
}

fn read_exact_cancelled(
    reader: &mut impl Read,
    output: &mut [u8],
    flag: &AtomicBool,
    context: &str,
) -> Result<(), String> {
    let mut offset = 0;
    while offset < output.len() {
        let read = read_cancelled(reader, &mut output[offset..], flag)?;
        if read == 0 {
            return Err(format!("sidecar closed the {context} early"));
        }
        offset += read;
    }
    Ok(())
}

fn write_all_cancelled(
    stream: &mut TcpStream,
    bytes: &[u8],
    flag: &AtomicBool,
    context: &str,
) -> Result<(), String> {
    let mut offset = 0;
    while offset < bytes.len() {
        cancelled(flag)?;
        match stream.write(&bytes[offset..]) {
            Ok(0) => return Err(format!("sidecar closed while {context}")),
            Ok(written) => offset += written,
            Err(error) if retryable_io(&error) => continue,
            Err(error) => return Err(format!("could not {context}: {error}")),
        }
    }
    Ok(())
}

#[tauri::command]
fn pylos_port() -> String {
    std::env::var("PYLOS_PORT").unwrap_or_else(|_| DEFAULT_PORT.to_string())
}

/// Writes a user-chosen path. The path comes from the native save dialog, so no
/// filesystem scope has to be opened to the webview.
#[tauri::command]
fn write_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    if contents.len() as u64 > MAX_COMPAT_BUNDLE_BYTES {
        return Err(
            "this compatibility write is capped at 64 MiB; use desktop bundle streaming"
                .to_string(),
        );
    }
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target, contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    let target = PathBuf::from(&path);
    let size = fs::metadata(&target)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_COMPAT_BUNDLE_BYTES {
        return Err(
            "this compatibility read is capped at 64 MiB; use desktop bundle streaming".to_string(),
        );
    }
    let mut file = File::open(target).map_err(|error| error.to_string())?;
    let mut bytes = Vec::with_capacity(size as usize);
    Read::by_ref(&mut file)
        .take(MAX_COMPAT_BUNDLE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_COMPAT_BUNDLE_BYTES {
        return Err(
            "this compatibility read is capped at 64 MiB; use desktop bundle streaming".to_string(),
        );
    }
    Ok(bytes)
}

#[derive(Debug)]
struct HttpTarget {
    host: String,
    port: u16,
    authority: String,
    path: String,
}

fn http_target(url: &str) -> Result<HttpTarget, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| "desktop bundle streaming requires the local HTTP sidecar".to_string())?;
    let (authority, suffix) = rest.split_once('/').unwrap_or((rest, ""));
    if authority.is_empty()
        || authority.bytes().any(|byte| byte == b'\r' || byte == b'\n')
        || suffix.bytes().any(|byte| byte == b'\r' || byte == b'\n')
    {
        return Err("invalid sidecar URL".to_string());
    }
    let (host, port) = if let Some((host, port)) = authority.rsplit_once(':') {
        if host.is_empty() || port.is_empty() {
            return Err("invalid sidecar authority".to_string());
        }
        (
            host.trim_matches(['[', ']']).to_string(),
            port.parse::<u16>()
                .map_err(|_| "invalid sidecar port".to_string())?,
        )
    } else {
        (authority.to_string(), 80)
    };
    if host.is_empty() || host.bytes().any(|byte| byte == b'\r' || byte == b'\n') {
        return Err("invalid sidecar host".to_string());
    }
    if host != "127.0.0.1" && host != "localhost" && host != "::1" {
        return Err("desktop bundle streaming is restricted to the loopback sidecar".to_string());
    }
    Ok(HttpTarget {
        host,
        port,
        authority: authority.to_string(),
        path: format!("/{}", suffix),
    })
}

fn connect(target: &HttpTarget) -> Result<TcpStream, String> {
    let addresses = (target.host.as_str(), target.port)
        .to_socket_addrs()
        .map_err(|error| format!("could not resolve sidecar: {error}"))?;
    let mut tried = false;
    let mut last_error = None;
    for address in addresses {
        tried = true;
        match TcpStream::connect_timeout(&address, Duration::from_secs(10)) {
            Ok(stream) => {
                stream
                    .set_nodelay(true)
                    .map_err(|error| format!("could not configure sidecar connection: {error}"))?;
                stream
                    .set_read_timeout(Some(socket_timeout()))
                    .map_err(|error| {
                        format!("could not configure sidecar read timeout: {error}")
                    })?;
                stream
                    .set_write_timeout(Some(socket_timeout()))
                    .map_err(|error| {
                        format!("could not configure sidecar write timeout: {error}")
                    })?;
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }
    if !tried {
        return Err("the sidecar address has no endpoints".to_string());
    }
    Err(format!(
        "could not connect to sidecar: {}",
        last_error.map_or_else(
            || "unknown connection error".to_string(),
            |error| error.to_string()
        )
    ))
}

fn header_value(value: &str) -> Result<(), String> {
    if value.bytes().any(|byte| byte == b'\r' || byte == b'\n') {
        Err("header value contains a line break".to_string())
    } else {
        Ok(())
    }
}

fn validate_passphrase(passphrase: &str) -> Result<(), String> {
    header_value(passphrase)?;
    if passphrase.len() > MAX_PASSPHRASE_BYTES {
        return Err("passphrase is too large".to_string());
    }
    Ok(())
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut index = 0;
    while index < bytes.len() {
        let first = bytes[index] as u32;
        let second = bytes.get(index + 1).copied().unwrap_or(0) as u32;
        let third = bytes.get(index + 2).copied().unwrap_or(0) as u32;
        let value = (first << 16) | (second << 8) | third;
        output.push(ALPHABET[((value >> 18) & 63) as usize] as char);
        output.push(ALPHABET[((value >> 12) & 63) as usize] as char);
        if index + 1 < bytes.len() {
            output.push(ALPHABET[((value >> 6) & 63) as usize] as char);
        }
        if index + 2 < bytes.len() {
            output.push(ALPHABET[(value & 63) as usize] as char);
        }
        index += 3;
    }
    output
}

fn bearer_header(authorization: &Option<String>) -> Result<String, String> {
    let Some(value) = authorization else {
        return Ok(String::new());
    };
    header_value(value)?;
    Ok(format!("Authorization: {value}\r\n"))
}

fn write_export_request(
    stream: &mut TcpStream,
    target: &HttpTarget,
    passphrase: &str,
    authorization: &Option<String>,
    cancelled_flag: &AtomicBool,
) -> Result<(), String> {
    validate_passphrase(passphrase)?;
    let encoded = serde_json::to_vec(&serde_json::json!({ "passphrase": passphrase }))
        .map_err(|error| format!("could not encode export request: {error}"))?;
    let auth = bearer_header(authorization)?;
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept: application/octet-stream\r\nContent-Type: application/json\r\n{}Content-Length: {}\r\n\r\n",
        target.path,
        target.authority,
        auth,
        encoded.len(),
    );
    write_all_cancelled(
        stream,
        request.as_bytes(),
        cancelled_flag,
        "send export request",
    )?;
    write_all_cancelled(stream, &encoded, cancelled_flag, "send export request")
}

fn write_import_request(
    stream: &mut TcpStream,
    target: &HttpTarget,
    path: &Path,
    passphrase: &str,
    authorization: &Option<String>,
    cancelled_flag: &AtomicBool,
) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| format!("could not open bundle: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("could not inspect bundle: {error}"))?
        .len();
    validate_passphrase(passphrase)?;
    let encoded_passphrase = base64url(passphrase.as_bytes());
    let auth = bearer_header(authorization)?;
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept: application/json\r\nContent-Type: {RAW_IMPORT_CONTENT_TYPE}\r\n{RAW_IMPORT_PASSPHRASE_HEADER}: {encoded_passphrase}\r\n{}Content-Length: {length}\r\n\r\n",
        target.path, target.authority, auth,
    );
    write_all_cancelled(
        stream,
        request.as_bytes(),
        cancelled_flag,
        "send import request",
    )?;
    copy_file_to_stream(&mut file, stream, length, cancelled_flag)?;
    cancelled(cancelled_flag)
}

fn copy_file_to_stream(
    file: &mut File,
    stream: &mut TcpStream,
    mut remaining: u64,
    cancelled_flag: &AtomicBool,
) -> Result<(), String> {
    let mut buffer = [0_u8; IO_CHUNK];
    while remaining > 0 {
        cancelled(cancelled_flag)?;
        let wanted = remaining.min(buffer.len() as u64) as usize;
        let read = file
            .read(&mut buffer[..wanted])
            .map_err(|error| format!("could not read bundle: {error}"))?;
        if read == 0 {
            return Err("bundle changed while it was being uploaded".to_string());
        }
        write_all_cancelled(stream, &buffer[..read], cancelled_flag, "send bundle")?;
        remaining -= read as u64;
    }
    Ok(())
}

#[derive(Debug)]
enum BodyMode {
    Length(u64),
    Chunked,
    Close,
}

#[derive(Debug)]
struct ResponseHead {
    status: u16,
    mode: BodyMode,
    initial: Vec<u8>,
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn response_head(
    stream: &mut TcpStream,
    cancelled_flag: &AtomicBool,
) -> Result<ResponseHead, String> {
    let mut bytes = Vec::with_capacity(8192);
    let mut chunk = [0_u8; IO_CHUNK];
    let end = loop {
        let read = read_cancelled(stream, &mut chunk, cancelled_flag)?;
        if read == 0 {
            return Err("sidecar closed the connection before response headers".to_string());
        }
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(end) = find_header_end(&bytes) {
            break end;
        }
        if bytes.len() > MAX_RESPONSE_HEADERS {
            return Err("sidecar response headers are too large".to_string());
        }
    };
    let header_bytes = &bytes[..end];
    let text = std::str::from_utf8(header_bytes)
        .map_err(|_| "sidecar response headers are not UTF-8".to_string())?;
    let mut lines = text.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "sidecar returned an invalid HTTP status".to_string())?;
    let mut content_length = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err("sidecar returned a malformed HTTP header".to_string());
        };
        if name.eq_ignore_ascii_case("content-length") {
            content_length = Some(
                value
                    .trim()
                    .parse::<u64>()
                    .map_err(|_| "sidecar returned an invalid content length".to_string())?,
            );
        }
        if name.eq_ignore_ascii_case("transfer-encoding")
            && value
                .split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("chunked"))
        {
            chunked = true;
        }
    }
    Ok(ResponseHead {
        status,
        mode: if chunked {
            BodyMode::Chunked
        } else if let Some(length) = content_length {
            BodyMode::Length(length)
        } else {
            BodyMode::Close
        },
        initial: bytes[end + 4..].to_vec(),
    })
}

struct PrefixedReader<'a> {
    stream: &'a mut TcpStream,
    prefix: Vec<u8>,
    offset: usize,
}

impl Read for PrefixedReader<'_> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if self.offset < self.prefix.len() {
            let length = output.len().min(self.prefix.len() - self.offset);
            output[..length].copy_from_slice(&self.prefix[self.offset..self.offset + length]);
            self.offset += length;
            return Ok(length);
        }
        self.stream.read(output)
    }
}

fn copy_exact<W: Write>(
    reader: &mut impl Read,
    sink: &mut W,
    mut remaining: u64,
    cancelled_flag: &AtomicBool,
    limit: Option<u64>,
    written: &mut u64,
) -> Result<(), String> {
    let mut buffer = [0_u8; IO_CHUNK];
    while remaining > 0 {
        cancelled(cancelled_flag)?;
        let wanted = remaining.min(buffer.len() as u64) as usize;
        let read = read_cancelled(reader, &mut buffer[..wanted], cancelled_flag)?;
        if read == 0 {
            return Err("sidecar closed the response body early".to_string());
        }
        *written += read as u64;
        if let Some(max) = limit {
            if *written > max {
                return Err("sidecar response is too large".to_string());
            }
        }
        sink.write_all(&buffer[..read])
            .map_err(|error| format!("could not write bundle: {error}"))?;
        remaining -= read as u64;
    }
    Ok(())
}

fn read_line(reader: &mut impl Read, cancelled_flag: &AtomicBool) -> Result<Vec<u8>, String> {
    let mut line = Vec::with_capacity(64);
    let mut byte = [0_u8; 1];
    loop {
        let read = read_cancelled(reader, &mut byte, cancelled_flag)?;
        if read == 0 {
            return Err("sidecar closed a chunked response early".to_string());
        }
        line.push(byte[0]);
        if line.ends_with(b"\r\n") {
            line.truncate(line.len() - 2);
            return Ok(line);
        }
        if line.len() > 16 * 1024 {
            return Err("sidecar chunk header is too large".to_string());
        }
    }
}

fn copy_response<W: Write>(
    stream: &mut TcpStream,
    head: ResponseHead,
    sink: &mut W,
    cancelled_flag: &AtomicBool,
    limit: Option<u64>,
) -> Result<u64, String> {
    let mut reader = PrefixedReader {
        stream,
        prefix: head.initial,
        offset: 0,
    };
    let mut written = 0;
    match head.mode {
        BodyMode::Length(length) => copy_exact(
            &mut reader,
            sink,
            length,
            cancelled_flag,
            limit,
            &mut written,
        )?,
        BodyMode::Close => {
            let mut buffer = [0_u8; IO_CHUNK];
            loop {
                cancelled(cancelled_flag)?;
                let read = read_cancelled(&mut reader, &mut buffer, cancelled_flag)?;
                if read == 0 {
                    break;
                }
                written += read as u64;
                if let Some(max) = limit {
                    if written > max {
                        return Err("sidecar response is too large".to_string());
                    }
                }
                sink.write_all(&buffer[..read])
                    .map_err(|error| format!("could not write bundle: {error}"))?;
            }
        }
        BodyMode::Chunked => loop {
            let line = read_line(&mut reader, cancelled_flag)?;
            let size_text = line
                .split(|byte| *byte == b';')
                .next()
                .ok_or_else(|| "sidecar returned an invalid chunk size".to_string())?;
            let size_text = std::str::from_utf8(size_text)
                .map_err(|_| "sidecar returned an invalid chunk size".to_string())?;
            let size = u64::from_str_radix(size_text.trim(), 16)
                .map_err(|_| "sidecar returned an invalid chunk size".to_string())?;
            if size == 0 {
                loop {
                    if read_line(&mut reader, cancelled_flag)?.is_empty() {
                        break;
                    }
                }
                break;
            }
            copy_exact(&mut reader, sink, size, cancelled_flag, limit, &mut written)?;
            let mut crlf = [0_u8; 2];
            read_exact_cancelled(&mut reader, &mut crlf, cancelled_flag, "chunk terminator")?;
            if crlf != *b"\r\n" {
                return Err("sidecar returned an invalid chunk terminator".to_string());
            }
        },
    }
    Ok(written)
}

fn response_error(
    stream: &mut TcpStream,
    head: ResponseHead,
    cancelled_flag: &AtomicBool,
) -> String {
    let mut body = Vec::new();
    let message = copy_response(
        stream,
        head,
        &mut body,
        cancelled_flag,
        Some(MAX_RESPONSE_BYTES),
    )
    .err()
    .unwrap_or_default();
    if !message.is_empty() {
        return message;
    }
    let text = String::from_utf8_lossy(&body).trim().to_string();
    if text.is_empty() {
        "sidecar rejected the bundle transfer".to_string()
    } else {
        text.chars().take(512).collect()
    }
}

fn temporary_path(path: &Path, transfer_id: &str) -> PathBuf {
    PathBuf::from(format!("{}.pylos-part-{transfer_id}", path.display()))
}

fn cleanup_partial(path: &Path) {
    let _ = fs::remove_file(path);
}

#[tauri::command(rename_all = "camelCase")]
fn cancel_bundle_transfer(transfer_id: String) -> bool {
    let Ok(table) = transfers().lock() else {
        return false;
    };
    let Some(flag) = table.get(&transfer_id) else {
        return false;
    };
    flag.store(true, Ordering::Relaxed);
    true
}

#[tauri::command(rename_all = "camelCase")]
fn export_bundle_to_file(
    transfer_id: String,
    url: String,
    path: String,
    passphrase: String,
    authorization: Option<String>,
) -> Result<String, String> {
    let cancelled_flag = begin_transfer(&transfer_id)?;
    let destination = PathBuf::from(path);
    let partial = temporary_path(&destination, &transfer_id);
    let result = (|| {
        let target = http_target(&url)?;
        let mut stream = connect(&target)?;
        write_export_request(
            &mut stream,
            &target,
            &passphrase,
            &authorization,
            &cancelled_flag,
        )?;
        let head = response_head(&mut stream, &cancelled_flag)?;
        if !(200..300).contains(&head.status) {
            return Err(response_error(&mut stream, head, &cancelled_flag));
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .map_err(|error| format!("could not create export staging file: {error}"))?;
        copy_response(&mut stream, head, &mut output, &cancelled_flag, None)?;
        cancelled(&cancelled_flag)?;
        output
            .sync_all()
            .map_err(|error| format!("could not flush export: {error}"))?;
        drop(output);
        fs::rename(&partial, &destination)
            .map_err(|error| format!("could not commit export: {error}"))?;
        Ok(destination.to_string_lossy().into_owned())
    })();
    if result.is_err() {
        cleanup_partial(&partial);
    }
    end_transfer(&transfer_id);
    result
}

#[tauri::command(rename_all = "camelCase")]
fn import_bundle_from_file(
    transfer_id: String,
    url: String,
    path: String,
    passphrase: String,
    authorization: Option<String>,
) -> Result<String, String> {
    let cancelled_flag = begin_transfer(&transfer_id)?;
    let result = (|| {
        let target = http_target(&url)?;
        let mut stream = connect(&target)?;
        write_import_request(
            &mut stream,
            &target,
            Path::new(&path),
            &passphrase,
            &authorization,
            &cancelled_flag,
        )?;
        let head = response_head(&mut stream, &cancelled_flag)?;
        if !(200..300).contains(&head.status) {
            return Err(response_error(&mut stream, head, &cancelled_flag));
        }
        let mut body = Vec::new();
        copy_response(
            &mut stream,
            head,
            &mut body,
            &cancelled_flag,
            Some(MAX_RESPONSE_BYTES),
        )?;
        String::from_utf8(body)
            .map_err(|_| "sidecar returned a non-UTF-8 import response".to_string())
    })();
    end_transfer(&transfer_id);
    result
}

fn spawn_sidecar(app: &tauri::AppHandle) {
    let port = pylos_port();
    let mut command = match app.shell().sidecar("pylos-server") {
        Ok(command) => command.args(["serve"]).env("PYLOS_PORT", port),
        Err(error) => {
            // Expected under `tauri dev`, where the dev script runs the server.
            eprintln!("pylos: no sidecar binary ({error}); expecting an external server");
            return;
        }
    };
    if let Ok(resource_dir) = app.path().resource_dir() {
        let semantic_dir = resource_dir.join("semantic");
        if semantic_dir.is_dir() {
            command = command.env("PYLOS_SEMANTIC_RESOURCES", semantic_dir);
        }
    }
    match command.spawn() {
        Ok((mut events, child)) => {
            let state: State<Sidecar> = app.state();
            *state.0.lock().unwrap() = Some(child);
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            eprintln!("pylos-server: {}", String::from_utf8_lossy(&line).trim());
                        }
                        CommandEvent::Terminated(status) => {
                            let _ = handle.emit("pylos://server-exit", status.code);
                            break;
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(error) => eprintln!("pylos: could not start the sidecar: {error}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![
            pylos_port,
            write_file,
            read_file,
            cancel_bundle_transfer,
            export_bundle_to_file,
            import_bundle_from_file
        ])
        .setup(|app| {
            spawn_sidecar(app.handle());

            // The webview shows the window as soon as the server answers; this
            // is only the backstop for a webview that never gets that far.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(REVEAL_AFTER_MS));
                    let _ = window.show();
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state: State<Sidecar> = window.state();
                let child = state.0.lock().unwrap().take();
                if let Some(child) = child {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("pylos failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn sidecar_target_accepts_only_http_and_keeps_the_request_path() {
        let target = http_target("http://127.0.0.1:7334/api/threads/t/export").expect("target");
        assert_eq!(target.host, "127.0.0.1");
        assert_eq!(target.port, 7334);
        assert_eq!(target.path, "/api/threads/t/export");
        assert!(http_target("https://127.0.0.1:7334/api").is_err());
        assert!(http_target("http://127.0.0.1:7334/api\r\nX: y").is_err());
        assert!(http_target("http://example.test:7334/api").is_err());
    }

    #[test]
    fn raw_import_header_is_unpadded_base64url() {
        assert_eq!(base64url(b"password"), "cGFzc3dvcmQ");
        assert_eq!(base64url("pässphrase".as_bytes()), "cMOkc3NwaHJhc2U");
        assert!(!base64url(b"password").contains('='));
    }

    #[test]
    fn partial_export_cleanup_is_recoverable_and_does_not_touch_destination() {
        let root =
            std::env::temp_dir().join(format!("pylos-desktop-test-{}", transfer_id_for_test()));
        fs::create_dir_all(&root).expect("directory");
        let destination = root.join("vault.pylos");
        fs::write(&destination, b"old").expect("destination");
        let partial = temporary_path(&destination, "test-transfer");
        fs::write(&partial, b"partial").expect("partial");
        cleanup_partial(&partial);
        assert!(!partial.exists());
        assert_eq!(fs::read(&destination).expect("destination read"), b"old");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_http_export_removes_staging_and_preserves_existing_destination() {
        let listener = match TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("listener: {error}"),
        };
        let address = listener.local_addr().expect("address");
        let server = std::thread::spawn(move || {
            let (mut connection, _) = listener.accept().expect("request");
            let mut request = [0_u8; 1024];
            let _ = connection.read(&mut request).expect("read");
            connection
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 4\r\nConnection: close\r\n\r\nnope")
                .expect("response");
        });
        let id = transfer_id_for_test();
        let root = std::env::temp_dir().join(format!("pylos-desktop-http-{id}"));
        fs::create_dir_all(&root).expect("directory");
        let destination = root.join("vault.pylos");
        fs::write(&destination, b"old").expect("destination");
        let result = export_bundle_to_file(
            id.clone(),
            format!("http://{address}/api/export"),
            destination.to_string_lossy().into_owned(),
            "password".to_string(),
            None,
        );
        assert!(result.is_err());
        assert_eq!(fs::read(&destination).expect("destination read"), b"old");
        assert!(!temporary_path(&destination, &id).exists());
        server.join().expect("server");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stalled_export_cancellation_does_not_leave_a_partial_destination() {
        let listener = match TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("listener: {error}"),
        };
        let address = listener.local_addr().expect("address");
        let server = std::thread::spawn(move || {
            let (_connection, _) = listener.accept().expect("request");
            std::thread::sleep(Duration::from_millis(SOCKET_TIMEOUT_MS * 3));
        });
        let id = transfer_id_for_test();
        let root = std::env::temp_dir().join(format!("pylos-desktop-stalled-export-{id}"));
        fs::create_dir_all(&root).expect("directory");
        let destination = root.join("vault.pylos");
        fs::write(&destination, b"old").expect("destination");
        let worker_id = id.clone();
        let worker_destination = destination.clone();
        let started = std::time::Instant::now();
        let worker = std::thread::spawn(move || {
            export_bundle_to_file(
                worker_id,
                format!("http://{address}/api/export"),
                worker_destination.to_string_lossy().into_owned(),
                "password".to_string(),
                None,
            )
        });
        cancel_when_active(&id);
        let result = worker.join().expect("worker");
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(fs::read(&destination).expect("destination read"), b"old");
        assert!(!temporary_path(&destination, &id).exists());
        server.join().expect("server");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stalled_import_cancellation_interrupts_upload() {
        let listener = match TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => return,
            Err(error) => panic!("listener: {error}"),
        };
        let address = listener.local_addr().expect("address");
        let server = std::thread::spawn(move || {
            let (_connection, _) = listener.accept().expect("request");
            std::thread::sleep(Duration::from_millis(SOCKET_TIMEOUT_MS * 3));
        });
        let id = transfer_id_for_test();
        let root = std::env::temp_dir().join(format!("pylos-desktop-stalled-import-{id}"));
        fs::create_dir_all(&root).expect("directory");
        let source = root.join("vault.pylos");
        fs::write(&source, vec![b'x'; IO_CHUNK * 128]).expect("source");
        let worker_id = id.clone();
        let worker_source = source.clone();
        let started = std::time::Instant::now();
        let worker = std::thread::spawn(move || {
            import_bundle_from_file(
                worker_id,
                format!("http://{address}/api/import"),
                worker_source.to_string_lossy().into_owned(),
                "password".to_string(),
                None,
            )
        });
        cancel_when_active(&id);
        let result = worker.join().expect("worker");
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        server.join().expect("server");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn transfer_registry_cancellation_is_bounded_and_cleans_up() {
        let id = transfer_id_for_test();
        let flag = begin_transfer(&id).expect("begin");
        assert!(cancel_bundle_transfer(id.clone()));
        assert!(cancelled(&flag).is_err());
        end_transfer(&id);
        assert!(!cancel_bundle_transfer(id));
    }

    #[test]
    fn response_copy_requests_fixed_size_chunks() {
        struct Reader {
            remaining: usize,
            largest_request: usize,
        }

        impl Read for Reader {
            fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
                self.largest_request = self.largest_request.max(output.len());
                let amount = self.remaining.min(output.len());
                self.remaining -= amount;
                Ok(amount)
            }
        }

        let mut source = Reader {
            remaining: IO_CHUNK * 3 + 1,
            largest_request: 0,
        };
        let mut output = Vec::new();
        let flag = AtomicBool::new(false);
        let mut written = 0;
        copy_exact(
            &mut source,
            &mut output,
            (IO_CHUNK * 3 + 1) as u64,
            &flag,
            None,
            &mut written,
        )
        .expect("copy");
        assert_eq!(written, (IO_CHUNK * 3 + 1) as u64);
        assert_eq!(source.largest_request, IO_CHUNK);
    }

    fn transfer_id_for_test() -> String {
        static NEXT: OnceLock<Mutex<u32>> = OnceLock::new();
        let next = NEXT.get_or_init(|| Mutex::new(0));
        let mut value = next.lock().expect("test id lock");
        *value += 1;
        format!("test-{}-{}", std::process::id(), *value)
    }

    fn cancel_when_active(id: &str) {
        for _ in 0..100 {
            if cancel_bundle_transfer(id.to_string()) {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("transfer did not become cancellable");
    }
}
