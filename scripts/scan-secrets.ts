#!/usr/bin/env bun
// Fails if anything that looks like a live credential is tracked by git.
import { $ } from "bun";
const patterns: Array<[string, RegExp]> = [
  ["xai api key", /xai-[A-Za-z0-9]{20,}/],
  ["anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai key", /sk-(proj-)?[A-Za-z0-9_-]{20,}/],
  ["jwt", /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
  ["github token", /gh[pousr]_[A-Za-z0-9]{30,}/],
  ["private key", /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
const files = (await $`git ls-files`.text()).split("\n").filter(Boolean);
let bad = 0;
for (const f of files) {
  if (/\.(png|jpg|jpeg|webp|ico|woff2?|ttf|otf|pdf|sqlite)$/i.test(f)) continue;
  let text: string;
  try { text = await Bun.file(f).text(); } catch { continue; }
  for (const [name, re] of patterns) {
    if (re.test(text)) { console.error(`secret-like content (${name}) in ${f}`); bad++; }
  }
}
if (bad) process.exit(1);
console.log(`scan-secrets: ${files.length} files clean`);
