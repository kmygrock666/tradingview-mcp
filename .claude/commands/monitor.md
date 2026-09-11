---
description: 啟動極速匡進場監控器（背景常駐，預設 30 分一輪）
argument-hint: "[間隔分鐘，預設 30]"
allowed-tools: Bash, PowerShell, mcp__tradingview__tv_health_check, mcp__tradingview__tab_list, mcp__tradingview__tab_switch, mcp__tradingview__chart_get_state
---

啟動 `scripts/monitor-jskuang.js`（極速匡進場監控器）。間隔分鐘＝ $1，沒給就用 30。

前置：先跑 `/tv` 的流程確保 CDP 9222 + 圖表分頁可讀，並確認圖表上有 `7EMA_5MA`
（監控條件要讀它的 MA 1）。

若已有監控器在跑（`Get-CimInstance Win32_Process -Filter "Name='node.exe'"` 命令列含
`monitor-jskuang.js`），先問使用者要不要重啟，不要盲目再開一個。

啟動（**一定要用 Start-Process**，用 Bash 背景工作會隨 session 結束被砍；腳本自帶
`process.loadEnvFile()` 讀 `.env`，不用 `--env-file`）：

```powershell
Set-Location "C:\Users\USER\git\tradingview-mcp"
foreach ($f in @(".\monitor-jskuang.log", ".\monitor-jskuang.err.log")) {
  if (Test-Path $f) { Move-Item $f "$f.prev" -Force }
}
Start-Process node -ArgumentList "scripts/monitor-jskuang.js","<間隔>" `
  -WorkingDirectory "C:\Users\USER\git\tradingview-mcp" -WindowStyle Hidden `
  -RedirectStandardOutput ".\monitor-jskuang.log" -RedirectStandardError ".\monitor-jskuang.err.log" -PassThru
```

啟動後 tail log **等到出現「掃描完成」**才算正常，回報 PID、第一輪結果與下次掃描時間。
