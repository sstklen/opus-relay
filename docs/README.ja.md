[English](../README.md) · [中文版](README.zh.md)

# Opus Relay

> APIキー不要で、任意のVPSでClaudeサブスクリプションを使用する。

```
┌─────────────┐   WebSocket   ┌─────────────┐
│  あなたのVPS │◄─────────────►│ あなたのMac/PC│
│  server.ts   │               │  client.ts   │
│              │   task  ────► │              │
│  sendTask()  │               │ claude -p →  │
│              │   ◄──── result│              │
└─────────────┘               └─────────────┘
```

VPSがタスクを送信 → あなたのコンピューターがClaude CLIを実行 → 結果が返ってくる。**APIコストゼロ** — 既存のClaude Max/Proサブスクリプションを使用します。

---

## 前提条件

始める前に**2つ**必要です：

| 必要なもの | 理由 | 入手方法 |
|------|-----|---------------|
| **Claude CLI**（Mac/PC上）| relayが`claude -p`を使ってローカルでOpusを実行 | [インストールガイド](https://docs.anthropic.com/en/docs/claude-code) |
| **Node.js 18+** または **Bun 1.0+** | clientとserverの実行環境 | [Node.js](https://nodejs.org/) / [Bun](https://bun.sh/) |

Claude CLIの動作確認：
```bash
claude -p "Say hello"
# レスポンスが表示されるはずです
```

---

## セットアップガイド（3ステップ）

### ステップ1：VPSにインストール

```bash
# VPSにSSH接続
ssh your-vps

# repoをクローン（アクセス権が必要）
git clone git@github.com:sstklen/opus-relay.git
cd opus-relay

# 依存関係をインストール
npm install    # または: bun install
```

### ステップ2：VPSプロジェクトに追加

スタックを選択してください：

<details>
<summary><strong>オプションA：Node.js + Express / Fastify / 任意のHTTPサーバー</strong></summary>

```typescript
// your-server.ts
import express from 'express';
import { createOpusRelay } from './opus-relay/server.js';

const app = express();
const relay = createOpusRelay({
  password: process.env.RELAY_PASSWORD!,
});

// 既存のルート
app.get('/', (req, res) => res.json({ status: 'ok' }));

// サーバーを起動してrelayをアタッチ
const server = app.listen(3000, () => {
  console.log('Server running on port 3000');
});

// この1行でrelayをサーバーに接続
relay.attachTo(server);

// コードのどこでもOpusを使用：
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
<summary><strong>オプションB：スタンドアロン（既存サーバーなし）</strong></summary>

```typescript
// relay-server.ts
import { createOpusRelay } from './opus-relay/server.js';

const relay = createOpusRelay({
  password: process.env.RELAY_PASSWORD!,
});

// 独自のHTTP + WebSocketサーバーを起動
relay.listen(8080);

// importで他の場所でも使用
export { relay };
```

実行：
```bash
RELAY_PASSWORD=your-secret-password npx tsx relay-server.ts
# または: bun relay-server.ts
```

</details>

<details>
<summary><strong>オプションC：Bunネイティブサーバー</strong></summary>

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

    // relayにWebSocketアップグレードを処理させる
    const upgraded = relay.bunHandleUpgrade?.(req, server, url);
    if (upgraded !== undefined) return upgraded;

    // あなたのルート
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

### ステップ3：Mac/PCでクライアントを起動

```bash
# ローカルマシンにもクローン
git clone git@github.com:sstklen/opus-relay.git
cd opus-relay
npm install    # または: bun install

# relayクライアントを起動
RELAY_URL=wss://your-vps-domain.com/api/opus-relay \
RELAY_PASSWORD=your-secret-password \
npx tsx client.ts

# またはBunで：
RELAY_URL=wss://your-vps-domain.com/api/opus-relay \
RELAY_PASSWORD=your-secret-password \
bun client.ts
```

以下のように表示されるはずです：
```
[12:34:56] 🚀 Opus Relay Client started
[12:34:56]    VPS: wss://your-vps-domain.com/api/opus-relay
[12:34:56]    PID: 12345
[12:34:56]    Runtime: Node.js v22.0.0
[12:34:57] ✅ Connected, waiting for tasks...
```

**これで完了！** VPSから`relay.sendTask()`でOpusが使えるようになりました。

---

## プロジェクトでの使い方

接続後、VPSコードのどこでも`relay.sendTask()`を呼び出せます：

```typescript
// シンプルなテキストタスク
const answer = await relay.sendTask('Explain this error: TypeError ...');
// answer = "The error occurs because..." （オフライン時はnull）

// カスタムタイムアウト（ミリ秒）
const answer = await relay.sendTask('Analyze this large codebase...', 180_000);

// relayが利用可能か確認
if (relay.isOnline()) {
  // Opusを使用
} else {
  // 別のモデルにフォールバック
}
```

### パターン：Opusとフォールバック

```typescript
async function askAI(prompt: string): Promise<string> {
  // まずOpusを試す（無料、最高品質）
  const opus = await relay.sendTask(prompt);
  if (opus) return opus;

  // APIにフォールバック（有料）
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

## クライアントの継続実行

クライアントはMac/PCで起動し続ける必要があります。オプション：

### macOS：バックグラウンドで実行

```bash
# オプション1：tmux（推奨）
tmux new -s relay
RELAY_URL=wss://... RELAY_PASSWORD=... npx tsx client.ts
# Ctrl+Bを押してからDでデタッチ

# オプション2：nohup
nohup bash -c 'RELAY_URL=wss://... RELAY_PASSWORD=... npx tsx client.ts' &

# オプション3：launchd（起動時に自動開始）— examples/launchd.plistを参照
```

### Linux：systemdサービス

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

## リバースプロキシ（Caddy / Nginx）

VPSがリバースプロキシを使用している場合、WebSocketがサポートされていることを確認してください：

### Caddy

```caddyfile
your-domain.com {
    reverse_proxy localhost:3000
}
```

CaddyはWebSocketを自動的にサポートします。追加設定は不要です。

### Nginx

```nginx
location /api/opus-relay {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400;  # 24時間 — 接続維持
}
```

---

## APIリファレンス

### `createOpusRelay(options)`

| オプション | 型 | デフォルト | 説明 |
|--------|------|---------|-------------|
| `password` | string | （必須）| 認証パスワード |
| `path` | string | `/api/opus-relay` | WebSocketパス |
| `heartbeatTimeout` | number | 60000 | ハートビートタイムアウト（ミリ秒）|
| `pingInterval` | number | 30000 | サーバーpingインターバル（ミリ秒）|
| `defaultTaskTimeout` | number | 90000 | デフォルトのタスクタイムアウト（ミリ秒）|
| `logger` | object | console | カスタムロガー `{ info, warn, error }` |

### メソッド

| メソッド | 戻り値 | 説明 |
|--------|---------|-------------|
| `sendTask(prompt, timeout?)` | `Promise<string \| null>` | Opusにテキストタスクを送信 |
| `sendDebugRequest(params)` | `Promise<any \| null>` | 構造化デバッグリクエストを送信 |
| `isOnline()` | `boolean` | relayは接続されているか？ |
| `getStats()` | `RelayStats` | 接続統計 |
| `attachTo(httpServer)` | `void` | 既存のHTTPサーバーにアタッチ |
| `listen(port)` | `void` | スタンドアロンサーバーを起動 |
| `close()` | `void` | シャットダウン |

---

## トラブルシューティング

| 問題 | 解決策 |
|---------|----------|
| `❌ claude CLI not found` | Claude CLIをインストール：`npm install -g @anthropic-ai/claude-code` |
| `WebSocket connection failed` | VPSのファイアウォールがポートを許可しているか確認。`RELAY_URL`が正しいか確認 |
| `401 Unauthorized` | `RELAY_PASSWORD`がサーバーのパスワードと一致しない |
| `Already running (PID xxx)` | 古いプロセスを終了するか`rm /tmp/opus-relay-client.lock` |
| 2分ごとに接続が切れる | Bunに`idleTimeout: 0`を追加、またはNginxに`proxy_read_timeout 86400`を追加 |
| タスクタイムアウト | タイムアウトを増やす：`relay.sendTask(prompt, 180_000)` |

---

## セキュリティ

### 信頼モデル

> **重要：** クライアントマシンはVPSサーバーを完全に信頼します。

VPSを制御する人は、あなたのマシン上のClaude CLIに**任意のプロンプト**を送信できます。Claude CLIはローカルのファイルシステムとツールへのアクセス権を持っています。これは設計上のことです — relayは**あなた自身のVPS**専用です。

**ルール：**
- **あなた**が管理するサーバーにのみ接続する
- `RELAY_PASSWORD`を公開で共有しない
- 本番環境では`wss://`（TLS）を使用 — プレーンな`ws://`は絶対に使わない
- 最小限のファイルシステムアクセスで制限されたユーザーとしてクライアントを実行することを検討する
- クライアントは同時タスク数を制限（デフォルト：3）してリソース枯渇を防ぐ

### セキュリティ機能

- パスワードはheader経由で送信（`x-relay-password`）— URLクエリ文字列には含めない
- タイミング安全なパスワード比較（タイミング攻撃の防止）
- プロンプトサイズ制限（100KB）と出力サイズ制限（1MB）
- ロックファイルにより複数のクライアントインスタンスの起動を防ぐ
- エラーメッセージはサニタイズ済み — ローカルファイルパスは**絶対に**サーバーに送り返されない
- 同時タスク数制限によりリソース枯渇を防ぐ

## ライセンス

MIT
