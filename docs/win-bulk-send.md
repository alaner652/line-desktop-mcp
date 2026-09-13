# win-bulk-send — Windows 批次發送 MVP

把同一則訊息依序發給 N 個 LINE 聊天室。Windows 專用，靠 AutoHotkey v2 操作 LINE Desktop。

## 前置

1. LINE Desktop 已登入、主視窗開著（可以在背景，腳本會自己叫到前景）。
2. 安裝 [AutoHotkey v2](https://www.autohotkey.com/)。預設路徑會自動找到；
   裝在別處就設 `AUTOHOTKEY_PATH=C:\...\AutoHotkey64.exe`。
3. `npm install`（需要 `chardet` / `iconv-lite` 解 AHK 輸出編碼）。

## 用法

```powershell
node scripts\win-bulk-send.js "Keep Memo" --message "test" --preview
```

`names.txt` 格式見 `scripts/win-bulk-send.contacts.example.txt`。

| 參數 | 說明 |
|---|---|
| `--contacts <file>` | 一行一個聊天室名稱 |
| `--message <text>` / `--message-file <file>` | 訊息；換行會以 Shift+Enter 送 |
| `--preview` | 只處理第一位、不送出 |
| `--limit <n>` | 只送前 n 位 |
| `--delay-ms <ms>` | 每位之間等待（預設 3000，外加 0–1500ms 隨機） |
| `--ahk-timeout-ms <ms>` | 單次 AHK 超時（預設 60000） |
| `--line-title <t>` | LINE 視窗標題（預設 `LINE`） |

## 每位收件人的動作

```
叫 LINE 到前景 → 點側邊欄 → Ctrl+Shift+F 搜尋 → 貼名字 → Enter → 點第一筆結果
→ 點輸入框 → Ctrl+A / Delete 清草稿 → 逐行貼上（Shift+Enter 換行）→ Enter 送出
```

## 已知限制（MVP）

- **沒有開房驗證。** Windows 端目前沒有 OCR / UIA 讀回聊天室標題。
  如果搜尋**沒有結果**，「點第一筆結果」會點到空白處，訊息就會貼進**上一個還開著的聊天室**。
  所以：名字要完全一致、先 `--preview`、名單不確定的先小量試。
- 座標是寫死的（側邊欄 (30,110)、第一筆結果 (200,140)、輸入框 (w·3/4, h−100)），
  有乘 DPI 縮放，但 LINE 改版或視窗太小就會偏。
- 跑的時候會搶鍵盤滑鼠，不要同時操作電腦。
- 短時間對多人送相同內容有被 LINE 風控的可能；預設間隔 3 秒，建議別一次送太多。

## 下一步（如果要做穩）

1. 用 Inspect.exe / Accessibility Insights 看 LINE Windows 的 UIA tree。
   若側邊欄列和聊天室標題有暴露 Name，就能用 UIA 做開房驗證和真正的「滑列表選人」。
2. 若 UIA 看不到，改走截圖 + Windows.Media.Ocr，把 macOS 端 `scan-engine.js` 的幾何邏輯平移過來。
