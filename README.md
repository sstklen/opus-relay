[中文版](docs/README.zh.md) · [日本語版](docs/README.ja.md)

# Opus Relay

> Use your Claude subscription on any VPS — no API key needed.

```
┌─────────────┐   WebSocket   ┌─────────────┐
│  Your VPS    │◄─────────────►│  Your Mac/PC │
│  server.ts   │               │  client.ts   │
│              │   task  ────► │              │
│  sendTask()  │               │ claude -p →  │
│              │   ◄──── result│              │
└─────────────┘               └─────────────┘
```

Your VPS sends tasks → Your computer runs Claude CLI → Results come back. **Zero API cost** — uses your existing Claude Max/Pro subscription.

---

## Prerequisites

You need **two things** before starting:

| What | Why | How to get it |
|------|-----|---------------|
| **Claude CLI** on your Mac/PC | The relay uses `claude -p` to run Opus locally | [Install guide](https://docs.anthropic.com/en/docs/claude-code) |
| **Node.js 18+** or **Bun 1.0+** | Runtime for both client and server | [Node.js](https://nodejs.org/) / [Bun](https://bun.sh/) |

Verify Claude CLI works:
```bash
claude -p "Say hello"
# Should print a response
```

---

## Setup Guide (3 Steps)

### Step 1: Install on your VPS

```bash
# SSH into your VPS
ssh your-vps

# Clone the repo (you need access)
git clone git@github.com:sstklen/opus-relay.git
cd opus-relay

# Install dependencies
npm install    # or: bun install
```

### Step 2: Add to your VPS project

Choose your stack:

<details>
<summary><strong>Option A: Node.js + Express / Fastify / any HTTP server</strong></summary>

```typescript
// your-server.ts
import express from 'express';
import { createOpusRelay } from './opus-relay/server.js';

const app = express();
const relay = createOpusRelay({
  password: process.env.RELAY_PASSWORD!,
});

// Your existing routes
app.get('/', (req, res) => res.json({ status: 'ok' }));

// Start server and attach relay
const server = app.listen(3000, () => {
  console.log('Server running on port 3000');
});

// This one line connects the relay to your server
relay.attachTo(server);

// Now use Opus anywhere in your code:
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
<summary><strong>Option B: Standalone (no existing server)</strong></summary>

```typescript
// relay-server.ts
import { createOpusRelay } from './opus-relay/server.js';

const relay = createOpusRelay({
  password: process.env.RELAY_PASSWORD!,
});

// Starts its own HTTP + WebSocket server
relay.listen(8080);

// Use it elsewhere via import
export { relay };
```

Run it:
```bash
RELAY_PASSWORD=your-secret-password npx tsx relay-server.ts
# or: bun relay-server.ts
```

</details>

<details>
<summary><strong>Option C: Bun native server</strong></summary>

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

    // Let relay handle WebSocket upgrade
    const upgraded = relay.bunHandleUpgrade?.(req, server, url);
    if (upgraded !== undefined) return upgraded;

    // Your routes
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

### Step 3: Start the client on your Mac/PC

```bash
# Clone on your local machine too
git clone git@github.com:sstklen/opus-relay.git
cd opus-relay
npm install    # or: bun install

# Start the relay client
RELAY_URL=wss://your-vps-domain.com/api/opus-relay \
RELAY_PASSWORD=your-secret-password \
npx tsx client.ts

# Or with Bun:
RELAY_URL=wss://your-vps-domain.com/api/opus-relay \
RELAY_PASSWORD=your-secret-password \
bun client.ts
```

You should see:
```
[12:34:56] 🚀 Opus Relay Client started
[12:34:56]    VPS: wss://your-vps-domain.com/api/opus-relay
[12:34:56]    PID: 12345
[12:34:56]    Runtime: Node.js v22.0.0
[12:34:57] ✅ Connected, waiting for tasks...
```

**That's it!** Your VPS can now use Opus via `relay.sendTask()`.

---

## Using in Your Project

Once connected, call `relay.sendTask()` anywhere in your VPS code:

```typescript
// Simple text task
const answer = await relay.sendTask('Explain this error: TypeError ...');
// answer = "The error occurs because..." (or null if offline)

// With custom timeout (ms)
const answer = await relay.sendTask('Analyze this large codebase...', 180_000);

// Check if relay is available
if (relay.isOnline()) {
  // Use Opus
} else {
  // Fallback to another model
}
```

### Pattern: Opus with fallback

```typescript
async function askAI(prompt: string): Promise<string> {
  // Try Opus first (free, best quality)
  const opus = await relay.sendTask(prompt);
  if (opus) return opus;

  // Fallback to API (paid)
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

## Keeping Client Running

The client needs to stay running on your Mac/PC. Options:

### macOS: Keep running in background

```bash
# Option 1: tmux (recommended)
tmux new -s relay
RELAY_URL=wss://... RELAY_PASSWORD=... npx tsx client.ts
# Press Ctrl+B then D to detach

# Option 2: nohup
nohup bash -c 'RELAY_URL=wss://... RELAY_PASSWORD=... npx tsx client.ts' &

# Option 3: launchd (auto-start on boot) — see examples/launchd.plist
```

### Linux: systemd service

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

## Reverse Proxy (Caddy / Nginx)

If your VPS uses a reverse proxy, make sure WebSocket is supported:

### Caddy

```caddyfile
your-domain.com {
    reverse_proxy localhost:3000
}
```

Caddy supports WebSocket automatically. No extra config needed.

### Nginx

```nginx
location /api/opus-relay {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;  # 24h — keep alive
}
```

---

## API Reference

### `createOpusRelay(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `password` | string | (required) | Auth password |
| `path` | string | `/api/opus-relay` | WebSocket path |
| `heartbeatTimeout` | number | 60000 | Heartbeat timeout (ms) |
| `pingInterval` | number | 30000 | Server ping interval (ms) |
| `defaultTaskTimeout` | number | 90000 | Default task timeout (ms) |
| `logger` | object | console | Custom logger `{ info, warn, error }` |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `sendTask(prompt, timeout?)` | `Promise<string \| null>` | Send a text task to Opus |
| `sendDebugRequest(params)` | `Promise<any \| null>` | Send structured debug request |
| `isOnline()` | `boolean` | Is relay connected? |
| `getStats()` | `RelayStats` | Connection stats |
| `attachTo(httpServer)` | `void` | Attach to existing HTTP server |
| `listen(port)` | `void` | Start standalone server |
| `close()` | `void` | Shutdown |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `❌ claude CLI not found` | Install Claude CLI: `npm install -g @anthropic-ai/claude-code` |
| `WebSocket connection failed` | Check VPS firewall allows your port. Check `RELAY_URL` is correct |
| `401 Unauthorized` | `RELAY_PASSWORD` doesn't match server's password |
| `Already running (PID xxx)` | Kill old process or `rm /tmp/opus-relay-client.lock` |
| Connection drops every 2 min | Add `idleTimeout: 0` in Bun, or `proxy_read_timeout 86400` in Nginx |
| Task timeout | Increase timeout: `relay.sendTask(prompt, 180_000)` |

---

## Security

### Trust Model

> **Important:** The client machine trusts the VPS server completely.

Whoever controls the VPS can send **any prompt** to Claude CLI on your machine. Claude CLI has access to your local filesystem and tools. This is by design — the relay is meant for **your own VPS** only.

**Rules:**
- Only connect to servers **you** control
- Never share your `RELAY_PASSWORD` publicly
- Use `wss://` (TLS) in production — never plain `ws://`
- Consider running the client as a restricted user with minimal filesystem access
- The client limits concurrent tasks (default: 3) to prevent resource exhaustion

### Security Features

- Password sent via header (`x-relay-password`) — never in URL query strings
- Timing-safe password comparison (prevents timing attacks)
- Prompt size limit (100KB) and output size limit (1MB)
- Lock file prevents multiple client instances
- Error messages are sanitized — local file paths are **never** sent back to the server
- Concurrent task limit prevents resource exhaustion

## License

MIT
