//! The Pylos shell.
//!
//! The window is the transcript; everything else lives in `@pylos/server`,
//! which this shell starts as a sidecar and stops on exit. The webview reveals
//! the window itself once `/api/health` answers, so a slow first start never
//! shows an empty frame.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct Sidecar(Mutex<Option<CommandChild>>);

const DEFAULT_PORT: &str = "7334";
const REVEAL_AFTER_MS: u64 = 9_000;

#[tauri::command]
fn pylos_port() -> String {
    std::env::var("PYLOS_PORT").unwrap_or_else(|_| DEFAULT_PORT.to_string())
}

/// Writes a user-chosen path. The path comes from the native save dialog, so no
/// filesystem scope has to be opened to the webview.
#[tauri::command]
fn write_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&target, contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(PathBuf::from(&path)).map_err(|error| error.to_string())
}

fn spawn_sidecar(app: &tauri::AppHandle) {
    let port = pylos_port();
    let command = match app.shell().sidecar("pylos-server") {
        Ok(command) => command.args(["serve"]).env("PYLOS_PORT", port),
        Err(error) => {
            // Expected under `tauri dev`, where the dev script runs the server.
            eprintln!("pylos: no sidecar binary ({error}); expecting an external server");
            return;
        }
    };
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
        .invoke_handler(tauri::generate_handler![pylos_port, write_file, read_file])
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
