#!/usr/bin/env node
// win-bulk-send.js — Windows MVP: send one message to N LINE chats in sequence.
//
// For each name in the list:
//   activate LINE -> Ctrl+Shift+F search -> paste name -> Enter -> click first
//   result -> click input box -> clear draft -> paste message (Shift+Enter between
//   lines) -> Enter (unless --preview)
//
// Design notes (things upstream got bitten by, kept on purpose):
//   - Every AHK run has a hard timeout; a LINE modal can otherwise hang forever.
//   - AHK stdout is decoded via chardet + iconv: it is NOT reliably UTF-8 on a
//     zh-TW Windows (often CP950 / UTF-16LE).
//   - Name and message go to AHK through UTF-8 temp files (FileRead), never by
//     string interpolation into the .ahk source — quotes / backticks / % in the
//     message would otherwise break or corrupt it.
//   - Multi-line text is pasted line-by-line with Shift+Enter; a bare "\n" in the
//     paste makes LINE send early.
//   - Clipboard is snapshotted (ClipboardAll) and restored at the end.
//   - All pixel offsets are multiplied by A_ScreenDPI/96 (125% / 150% laptops).
//
// Known MVP limitation: there is no read-back verification that the opened chat
// is really `name` (Windows path has no OCR/UIA yet). If the search has NO match,
// the click lands on empty space and the message would go to whatever chat was
// already open. Mitigations: use exact full chat names, run --preview first.
//
// Usage:
//   node scripts/win-bulk-send.js --contacts names.txt --message "text"
//   node scripts/win-bulk-send.js --contacts names.txt --message-file msg.txt --preview
//   node scripts/win-bulk-send.js "王小明" "專案群組" --message "hi" --delay-ms 5000

import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import chardet from 'chardet';
import iconv from 'iconv-lite';

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELP = `win-bulk-send — send one message to N LINE chats (Windows, AutoHotkey v2)

Usage:
  node scripts/win-bulk-send.js [names...] [options]

Recipients (one or both):
  names...              chat names as positional args
  --contacts <file>     text file, one chat name per line (# comments ok)

Message (exactly one):
  --message <text>
  --message-file <file> UTF-8 file; newlines are sent as Shift+Enter

Options:
  --preview             open the FIRST chat and type the message, but do NOT
                        press Enter, then stop. Use this to check the flow.
  --limit <n>           only send to the first n recipients
  --delay-ms <ms>       pause between recipients (default 3000, +0..1500 jitter)
  --ahk-timeout-ms <ms> kill an AHK run after this long (default 60000)
  --line-title <t>      LINE window title, exact match (default "LINE")
  -h, --help

Env:
  AUTOHOTKEY_PATH       path to AutoHotkey v2 exe (else where.exe / default dirs)
`;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const cfg = {
    names: [],
    contactsFile: null,
    message: null,
    messageFile: null,
    preview: false,
    limit: Infinity,
    delayMs: 3000,
    ahkTimeoutMs: 60000,
    lineTitle: 'LINE',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} 需要一個值`);
      return argv[++i];
    };
    switch (a) {
      case '--contacts': cfg.contactsFile = next(); break;
      case '--message': cfg.message = next(); break;
      case '--message-file': cfg.messageFile = next(); break;
      case '--preview': cfg.preview = true; break;
      case '--limit': cfg.limit = parseInt(next(), 10); break;
      case '--delay-ms': cfg.delayMs = parseInt(next(), 10); break;
      case '--ahk-timeout-ms': cfg.ahkTimeoutMs = parseInt(next(), 10); break;
      case '--line-title': cfg.lineTitle = next(); break;
      case '-h': case '--help': cfg.help = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`未知參數 ${a}`);
        cfg.names.push(a);
    }
  }
  return cfg;
}

async function loadRecipients(cfg) {
  const names = [...cfg.names];
  if (cfg.contactsFile) {
    const txt = await readFile(cfg.contactsFile, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (line && !line.startsWith('#')) names.push(line);
    }
  }
  // de-dup, keep order
  const seen = new Set();
  const out = [];
  for (const n of names) if (!seen.has(n)) { seen.add(n); out.push(n); }
  return out.slice(0, cfg.limit);
}

async function loadMessage(cfg) {
  if (cfg.message && cfg.messageFile) throw new Error('--message 和 --message-file 只能選一個');
  if (cfg.messageFile) return (await readFile(cfg.messageFile, 'utf8')).replace(/\r\n/g, '\n');
  if (cfg.message != null) return cfg.message.replace(/\\n/g, '\n');
  throw new Error('需要 --message 或 --message-file');
}

// ---------------------------------------------------------------------------
// AutoHotkey
// ---------------------------------------------------------------------------

function findAutoHotkey() {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    process.env.AUTOHOTKEY_PATH,
    'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
    'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey.exe',
    'C:\\Program Files (x86)\\AutoHotkey\\v2\\AutoHotkey.exe',
    local && path.join(local, 'Programs', 'AutoHotkey', 'v2', 'AutoHotkey64.exe'),
    local && path.join(local, 'Programs', 'AutoHotkey', 'v2', 'AutoHotkey.exe'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  for (const exe of ['AutoHotkey64.exe', 'AutoHotkey.exe', 'autohotkey.exe']) {
    try {
      const r = execSync(`where.exe "${exe}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .trim().split(/\r?\n/)[0];
      if (r && existsSync(r)) return r;
    } catch { /* next */ }
  }
  throw new Error(
    '找不到 AutoHotkey v2。請安裝 https://www.autohotkey.com/ (v2)，或設定 AUTOHOTKEY_PATH 指向 AutoHotkey64.exe。'
  );
}

/** Decode AHK stdout/stderr bytes: zh-TW consoles are often CP950 or UTF-16LE. */
function decodeOut(buf) {
  if (!buf || !buf.length) return '';
  const enc = chardet.detect(buf);
  try {
    if (enc && !/^utf-?8$/i.test(enc) && iconv.encodingExists(enc)) return iconv.decode(buf, enc).trim();
  } catch { /* fall through */ }
  return buf.toString('utf8').trim();
}

/**
 * AHK v2 script for ONE recipient. Name/message are read from UTF-8 files so no
 * escaping of user text is needed. Emits a single status line on stdout:
 *   OK | ERR_NO_WINDOW | ERR_NOT_ACTIVE | ERR_CLIP
 */
function buildAhk({ nameFile, msgFile, lineTitle, send }) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`; // AHK v2: "" escapes a quote
  return `#Requires AutoHotkey v2.0
#SingleInstance force
SendMode "Input"
SetTitleMatchMode 3
CoordMode "Mouse", "Screen"

title := ${q(lineTitle)}
name  := Trim(FileRead(${q(nameFile)}, "UTF-8"), " \`t\`r\`n")
msg   := FileRead(${q(msgFile)}, "UTF-8")
doSend := ${send ? 1 : 0}

saved := ClipboardAll()
restoreClip() {
  global saved
  try A_Clipboard := saved
}

if !WinExist(title) {
  FileAppend "ERR_NO_WINDOW\`n", "*"
  ExitApp 2
}
WinActivate title
if !WinWaitActive(title,, 3) {
  FileAppend "ERR_NOT_ACTIVE\`n", "*"
  ExitApp 3
}
WinGetPos &wx, &wy, &ww, &wh, title
scale := A_ScreenDPI / 96
P(x, y) => Round(x) " " Round(y)

; --- open the chat via the search box (Ctrl+Shift+F) ---
Click P(wx + 30*scale, wy + 110*scale)       ; focus the chat list column
Sleep 300
Send "^+f"
Sleep 250
Send "^a"
Send "{Delete}"
Sleep 150
A_Clipboard := ""
A_Clipboard := name
if !ClipWait(2) {
  FileAppend "ERR_CLIP\`n", "*"
  restoreClip()
  ExitApp 4
}
Send "^v"
Sleep 900                                     ; let the filtered list render
Send "{Enter}"
Sleep 400
Click P(wx + 200*scale, wy + 140*scale)      ; first search result
Sleep 1200                                    ; chat view render

; --- focus the input box, clear any draft ---
Click P(wx + ww*3/4, wy + wh - 100*scale)
Sleep 250
Send "^a"
Send "{Delete}"
Sleep 250

; --- paste the message line by line (Shift+Enter = newline, Enter = send) ---
lines := StrSplit(msg, "\`n", "\`r")
for i, line in lines {
  if (line != "") {
    A_Clipboard := ""
    A_Clipboard := line
    if !ClipWait(2) {
      FileAppend "ERR_CLIP\`n", "*"
      restoreClip()
      ExitApp 4
    }
    Send "^v"
    Sleep 250
  }
  if (i < lines.Length)
    Send "+{Enter}"
}
Sleep 300
if (doSend) {
  Send "{Enter}"
  Sleep 400
}

restoreClip()
FileAppend "OK\`n", "*"
ExitApp 0
`;
}

async function runAhk(ahkPath, scriptPath, timeoutMs) {
  try {
    const { stdout, stderr } = await execFileP(ahkPath, [scriptPath], {
      encoding: 'buffer',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    return { status: decodeOut(stdout) || 'ERR_EMPTY', stderr: decodeOut(stderr) };
  } catch (err) {
    if (err && (err.killed || err.signal === 'SIGKILL')) {
      return { status: 'ERR_TIMEOUT', stderr: `AHK 超過 ${timeoutMs}ms 未結束（LINE 可能被彈窗擋住）` };
    }
    const out = decodeOut(err.stdout);
    return { status: out || `ERR_EXIT_${err.code ?? '?'}`, stderr: decodeOut(err.stderr) || err.message };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg.help) { process.stdout.write(HELP); return; }
  if (process.platform !== 'win32') {
    throw new Error(`這個腳本只支援 Windows（目前 ${process.platform}）。`);
  }

  const recipients = await loadRecipients(cfg);
  const message = await loadMessage(cfg);
  if (!recipients.length) throw new Error('沒有收件人：請給名字或 --contacts 檔案');
  if (!message.trim()) throw new Error('訊息是空的');

  const ahkPath = findAutoHotkey();
  const work = await mkdtemp(path.join(tmpdir(), 'line-bulk-'));
  const msgFile = path.join(work, 'msg.txt');
  await writeFile(msgFile, message, 'utf8');

  const targets = cfg.preview ? recipients.slice(0, 1) : recipients;
  console.error(
    `${cfg.preview ? '[PREVIEW 不送出] ' : ''}收件人 ${targets.length} 位，` +
      `訊息 ${message.length} 字，間隔 ${cfg.delayMs}ms，AHK: ${ahkPath}`
  );

  const results = [];
  try {
    for (let i = 0; i < targets.length; i++) {
      const name = targets[i];
      const nameFile = path.join(work, `name-${i}.txt`);
      const scriptPath = path.join(work, `send-${i}.ahk`);
      await writeFile(nameFile, name, 'utf8');
      await writeFile(
        scriptPath,
        buildAhk({ nameFile, msgFile, lineTitle: cfg.lineTitle, send: !cfg.preview }),
        'utf8'
      );

      process.stderr.write(`[${i + 1}/${targets.length}] ${name} ... `);
      const r = await runAhk(ahkPath, scriptPath, cfg.ahkTimeoutMs);
      const ok = r.status === 'OK';
      console.error(ok ? 'OK' : `FAIL ${r.status}${r.stderr ? ` — ${r.stderr}` : ''}`);
      results.push({ name, ok, status: r.status });

      // Stop the batch on a LINE-level failure (window gone / stuck); a wrong
      // paste target is worse than an incomplete batch.
      if (!ok && /ERR_(NO_WINDOW|NOT_ACTIVE|TIMEOUT)/.test(r.status)) {
        console.error('中止：LINE 視窗狀態異常，剩餘收件人未處理。');
        break;
      }
      if (i < targets.length - 1) {
        await sleep(cfg.delayMs + Math.floor(Math.random() * 1500));
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }

  const sent = results.filter((r) => r.ok).length;
  console.error(`\n完成：${sent}/${targets.length} ${cfg.preview ? '已打字（未送出）' : '已送出'}`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error('失敗：');
    for (const f of failed) console.error(`  - ${f.name}: ${f.status}`);
  }
  const skipped = targets.length - results.length;
  if (skipped > 0) console.error(`未處理：${skipped} 位`);
  if (cfg.preview && sent) {
    console.error('請到 LINE 確認開的聊天室和內容都對，再拿掉 --preview 正式送出（記得先刪掉預覽留下的草稿）。');
  }
  process.exitCode = failed.length || skipped ? 1 : 0;
}

main().catch((e) => {
  console.error(`win-bulk-send 失敗：${e?.message || e}`);
  process.exitCode = 1;
});
