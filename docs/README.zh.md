[English](../README.md) · [日本語](README.ja.md)

# Opus Relay

> 在任何 VPS 上使用你的 Claude 訂閱 — 不需要 API 金鑰。

```
┌─────────────┐   WebSocket   ┌─────────────┐
│   你的 VPS   │◄─────────────►│  你的 Mac/PC │
│  server.ts   │               │  client.ts   │
│              │   task  ────► │              │
│  sendTask()  │               │ claude -p →  │
│              │   ◄──── result│              │
└─────────────┘               └─────────────┘
```

你的 VPS 發送任務 → 你的電腦執行 Claude CLI → 結果回傳。**零 API 費用** — 使用你現有的 Claude Max/Pro 訂閱。

---

## 前置條件

開始前需要**兩樣東西**：

| 需要什麼 | 為什麼 | 怎麼取得 |
|------|-----|---------------|
| **Claude CLI**（在你的 Mac/PC 上）| relay 用 `claude -p` 在本地執行 Opus | [安裝指南](https://docs.anthropic.com/en/docs/claude-code) |
| **Node.js 18+** 或 **Bun 1.0+** | client 和 server 的執行環境 | [Node.js](https://nodejs.org/) / [Bun](https://bun.sh/) |

確認 Claude CLI 正常運作：
```bash
claude -p "Say hello"
# 應該印出回應
```

---

## 設定指南（3 步驟）

### 第一步：在 VPS 上安裝

```bash
# SSH 進入 VPS
ssh your-vps

# Clone repo（需要存取權限）
git clone git@github.com:sstklen/opus-relay.git
cd opus-relay

# 安裝依賴套件
npm install    # 或：bun install
```

### 第二步：加入你的 VPS 專案

選擇你的技術棧：

<details>
<summary><strong>選項 A：Node.js + Express / Fastify / 任何 HTTP 伺服器</strong></summary>

```typescript
// your-server.ts
import express from 'express';
import { createOpusRelay } from './opus-relay/server.js';

const app = express();
const relay = createOpusRelay({
  password: process.env.RELAY_PASSWORD!,
});

// 你現有的路由
app.get('/', (req, res) => res.json({ status: 'ok' }));

// 啟動伺服器並附加 relay
const server = app.listen(3000, () => {
  console.log('Server running on port 3000');
});

// 這一行把 relay 連接到你的伺服器
relay.attachTo(server);

// 現在可以在程式碼任何地方使用 Opus：
app.post('/api/analyze', async (req, res) => {
  const answer = await relay.sendTask(req.body.prompt);
  if (answer) {
    res.json({ result: answer });
  } else {
    res.json({ error: 'Opus offline, try later' });
  }
});
```

</details>

<details>
<summary><strong>選項 B：獨立模式（沒有現有伺服器）</strong></summary>

```typescript
// relay-server.ts
import { createOpusRelay } from './opus-relay/server.js';

const relay = createOpusRelay({
  password: process.env.RELAY_PASSWORD!,
});

// 自己啟動 HTTP + WebSocket 伺服器
relay.listen(8080);

// 在其他地方透過 import 使用
export { relay };
```

執行：
```bash
RELAY_PASSWORD=your-secret-password npx tsx relay-server.ts
# 或：bun relay-server.ts
```

</details>

<details>
<summary><strong>選項 C：Bun 原生伺服器</strong></summary>

```typescript
// bun-server.ts
import { createOpusRelay } from './opus-relay/server.js';

const relay = createOpusRelay({
  password: process.env.RELAY_PASSWORD!,
});

export default {
  port: 3000,
  fetch(req: Request, server: any) {
    const url = new URL(req.url);

    // 讓 relay 處理 WebSocket 升級
    const upgraded = relay.bunHandleUpgrade?.(req, server, url);
    if (upgraded !== undefined) return upgraded;

    // 你的路由
    if (url.pathname === '/status') {
      return Response.json({ relay: relay.getStats() });
    }
    return new Response('OK');
  },
  websocket: {
    idleTimeout: 0,
    sendPingsAutomatically: true,
    ...relay.bunWsHandlers,
  },
};
```

</details>

### 第三步：在你的 Mac/PC 上啟動 client

```bash
# 在本地機器也 clone
git clone git@github.com:sstklen/opus-relay.git
cd opus-relay
npm install    # 或：bun install

# 啟動 relay client
RELAY_URL=wss://your-vps-domain.com/api/opus-relay \
RELAY_PASSWORD=your-secret-password \
npx tsx client.ts

# 或用 Bun：
RELAY_URL=wss://your-vps-domain.com/api/opus-relay \
RELAY_PASSWORD=your-secret-password \
bun client.ts
```

你應該會看到：
```
[12:34:56] 🚀 Opus Relay Client started
[12:34:56]    VPS: wss://your-vps-domain.com/api/opus-relay
[12:34:56]    PID: 12345
[12:34:56]    Runtime: Node.js v22.0.0
[12:34:57] ✅ Connected, waiting for tasks...
```

**就這樣！** 你的 VPS 現在可以透過 `relay.sendTask()` 使用 Opus 了。

---

## 在專案中使用

連線後，在 VPS 程式碼的任何地方呼叫 `relay.sendTask()`：

```typescript
// 簡單文字任務
const answer = await relay.sendTask('Explain this error: TypeError ...');
// answer = "The error occurs because..." （或者離線時回傳 null）

// 自訂逾時（毫秒）
const answer = await relay.sendTask('Analyze this large codebase...', 180_000);

// 確認 relay 是否可用
if (relay.isOnline()) {
  // 使用 Opus
} else {
  // 退回到其他模型
}
```

### 模式：Opus 搭配 fallback

```typescript
async function askAI(prompt: string): Promise<string> {
  // 先嘗試 Opus（免費，品質最好）
  const opus = await relay.sendTask(prompt);
  if (opus) return opus;

  // 退回到 API（付費）
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await response.json();
  return data.content[0].text;
}
```

---

## 保持 Client 運行

Client 需要在你的 Mac/PC 上持續執行。選項：

### macOS：在背景執行

```bash
# 選項 1：tmux（推薦）
tmux new -s relay
RELAY_URL=wss://... RELAY_PASSWORD=... npx tsx client.ts
# 按 Ctrl+B 然後 D 分離

# 選項 2：nohup
nohup bash -c 'RELAY_URL=wss://... RELAY_PASSWORD=... npx tsx client.ts' &

# 選項 3：launchd（開機自動啟動）— 見 examples/launchd.plist
```

### Linux：systemd 服務

```bash
# /etc/systemd/system/opus-relay.service
[Unit]
Description=Opus Relay Client
After=network.target

[Service]
Type=simple
User=your-username
Environment=RELAY_URL=wss://your-vps/api/opus-relay
Environment=RELAY_PASSWORD=your-password
ExecStart=/usr/local/bin/npx tsx /path/to/opus-relay/client.ts
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable opus-relay
sudo systemctl start opus-relay
```

---

## 反向代理（Caddy / Nginx）

如果你的 VPS 使用反向代理，確認 WebSocket 有被支援：

### Caddy

```caddyfile
your-domain.com {
    reverse_proxy localhost:3000
}
```

Caddy 自動支援 WebSocket，不需要額外設定。

### Nginx

```nginx
location /api/opus-relay {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;  # 24 小時 — 保持連線
}
```

---

## API 參考

### `createOpusRelay(options)`

| 選項 | 型別 | 預設值 | 說明 |
|--------|------|---------|-------------|
| `password` | string | （必填）| 認證密碼 |
| `path` | string | `/api/opus-relay` | WebSocket 路徑 |
| `heartbeatTimeout` | number | 60000 | 心跳逾時（毫秒）|
| `pingInterval` | number | 30000 | Server ping 間隔（毫秒）|
| `defaultTaskTimeout` | number | 90000 | 預設任務逾時（毫秒）|
| `logger` | object | console | 自訂日誌器 `{ info, warn, error }` |

### 方法

| 方法 | 回傳 | 說明 |
|--------|---------|-------------|
| `sendTask(prompt, timeout?)` | `Promise<string \| null>` | 發送文字任務給 Opus |
| `sendDebugRequest(params)` | `Promise<any \| null>` | 發送結構化除錯請求 |
| `isOnline()` | `boolean` | relay 是否已連線？|
| `getStats()` | `RelayStats` | 連線統計資料 |
| `attachTo(httpServer)` | `void` | 附加到現有 HTTP 伺服器 |
| `listen(port)` | `void` | 啟動獨立伺服器 |
| `close()` | `void` | 關閉 |

---

## 疑難排解

| 問題 | 解法 |
|---------|----------|
| `❌ claude CLI not found` | 安裝 Claude CLI：`npm install -g @anthropic-ai/claude-code` |
| `WebSocket connection failed` | 確認 VPS 防火牆允許你的埠號。確認 `RELAY_URL` 正確 |
| `401 Unauthorized` | `RELAY_PASSWORD` 與伺服器密碼不符 |
| `Already running (PID xxx)` | 終止舊程序或 `rm /tmp/opus-relay-client.lock` |
| 連線每 2 分鐘斷一次 | 在 Bun 加 `idleTimeout: 0`，或在 Nginx 加 `proxy_read_timeout 86400` |
| 任務逾時 | 增加逾時：`relay.sendTask(prompt, 180_000)` |

---

## 安全性

### 信任模型

> **重要：** Client 機器完全信任 VPS 伺服器。

控制 VPS 的人可以發送**任何提示詞**給你機器上的 Claude CLI。Claude CLI 有存取你本地檔案系統和工具的權限。這是設計上的選擇 — relay 只適合用在**你自己的 VPS**。

**規則：**
- 只連線到**你自己**控制的伺服器
- 不要公開分享你的 `RELAY_PASSWORD`
- 正式環境使用 `wss://`（TLS）— 絕不用明文 `ws://`
- 考慮用受限使用者執行 client，限制檔案系統存取
- Client 限制同時執行的任務數量（預設：3），防止資源耗盡

### 安全功能

- 密碼透過 header 傳送（`x-relay-password`）— 不放在 URL 查詢字串裡
- 時序安全的密碼比對（防止計時攻擊）
- 提示詞大小限制（100KB）和輸出大小限制（1MB）
- 鎖定檔案防止多個 client 實例同時執行
- 錯誤訊息已過濾 — 本地檔案路徑**絕不**回傳給伺服器
- 同時任務數量限制防止資源耗盡

## 搭配使用

- **ClawAPI** ([`sstklen/clawapi`](https://github.com/sstklen/clawapi)) — AI API 金鑰管理 + 智能路由。Opus Relay 橋接算力，ClawAPI 管理金鑰。

## 授權條款

MIT
