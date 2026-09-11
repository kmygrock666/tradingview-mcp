---
description: 啟動 TradingView Desktop（帶 CDP 9222）並確認圖表可讀
allowed-tools: Bash, PowerShell, mcp__tradingview__tv_health_check, mcp__tradingview__tab_list, mcp__tradingview__tab_switch, mcp__tradingview__chart_get_state
---

確保 TradingView Desktop 帶 CDP 9222 在跑，且 MCP 接到「圖表」分頁。步驟：

1. 檢查 `netstat -ano | grep ":9222 .*LISTENING"`。已 LISTENING 就跳到第 3 步。
2. 沒開就用（PowerShell，需 dangerouslyDisableSandbox；版本號用 `(Get-AppxPackage -Name TradingView.Desktop).InstallLocation` 取得）：
   ```powershell
   Invoke-CommandInDesktopPackage -PackageFamilyName "TradingView.Desktop_n534cwy3pjxzj" `
     -AppId "TradingView.Desktop" `
     -Command "<InstallLocation>\TradingView.exe" -Args "--remote-debugging-port=9222"
   ```
   **不要**用 `tv_launch`、`launch_tv_debug.bat/vbs` 或本機副本，那三條路在這台機器上都壞的。
3. 輪詢等 9222 起來，然後 `tab_list` → `tab_switch` 切到 `is_chart: true` 的分頁
   （MCP 預設常接到 shell window，`chart_get_state` 會噴 `_activeChartWidgetWV` undefined）。
4. `chart_get_state` 確認 symbol/TF 與指標清單，回報結果。
