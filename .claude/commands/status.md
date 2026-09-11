---
description: 查看極速匡監控器狀態與最近掃描結果
allowed-tools: Bash, PowerShell, mcp__tradingview__tv_health_check, mcp__tradingview__chart_get_state
---

回報目前的運行狀態，簡短即可：

1. 監控器行程：`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select ProcessId,CommandLine`
   —— 找命令列含 `monitor-jskuang.js` 的，回報 PID 與間隔參數；沒有就說沒在跑。
2. CDP：`netstat -ano | grep ":9222 .*LISTENING"`，再 `chart_get_state` 看目前 symbol/TF。
3. 最近一輪：`tail -40 monitor-jskuang.log`，回報最後一次「掃描完成」時間、有無進場信號、
   以及推算的下次掃描時間。
4. `tail -20 monitor-jskuang.err.log`，有錯誤才回報。

要停止監控器就用 `Stop-Process -Id <PID>`（先確認 PID 是 monitor-jskuang.js 再砍）。
