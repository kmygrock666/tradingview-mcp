---
description: 執行一次極速匡掃描（BingX 漲幅前 20，符合者加入清單並發 TG）
allowed-tools: Bash, mcp__tradingview__chart_get_state, mcp__tradingview__chart_set_symbol, mcp__tradingview__chart_set_timeframe
---

跑一次 `scripts/scanner-jskuang.js`：條件為 18D紅吞 + 3D紅吞 + 1D紅吞 + 3H(紅吞或黑吞)，
掃 BingX USDT 永續 24h 漲幅前 20 名，符合者以 REST 指名加入「極速匡」清單並發 Telegram。

1. 確保 CDP 9222 + 圖表分頁可讀（同 `/tv`）。
2. 用 `chart_get_state` 記下目前的 symbol/TF —— 掃描器會借用圖表切換標的，**結束後不會還原**。
3. 執行（約 40 秒；`.env` 要有 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`）：
   ```bash
   node --env-file=.env scripts/scanner-jskuang.js
   ```
4. 掃完把圖表切回第 2 步記下的 symbol/TF。
5. 回報：符合幣對、加入清單與 TG 通知是否成功、條件不符與無資料的數量。
