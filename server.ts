/**
 * ================================================
 *  Opus Relay — 伺服端模組（跑在你的 VPS）
 * ================================================
 *
 * 讓你的 VPS 透過 WebSocket 呼叫本機的 Claude CLI（Opus）。
 *
 * 支援兩種 VPS 環境：
 *   1. Bun（原生 WebSocket）
 *   2. Node.js（用 ws 套件）
 *
 * 用法：
 *   import { createOpusRelay } from 'opus-relay/server';
 *   const relay = createOpusRelay({ password: 'your-password' });
 *
 *   // 需要 Opus 時
 *   const answer = await relay.sendTask('Analyze this bug...');
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { URL } from 'url';
import { timingSafeEqual, randomUUID } from 'crypto';

/** 常數時間字串比較（防 timing attack） */
function constantTimeCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const maxLen = Math.max(a.length, b.length);
  const bufA = Buffer.alloc(maxLen, 0);
  const bufB = Buffer.alloc(maxLen, 0);
  bufA.write(a);
  bufB.write(b);
  return a.length === b.length && timingSafeEqual(bufA, bufB);
}

// ─── 型別 ───

export interface OpusRelayOptions {
  /** 認證密碼 */
  password: string;
  /** WebSocket 路徑（預設 /api/opus-relay） */
  path?: string;
  /** 心跳超時 ms（預設 60000） */
  heartbeatTimeout?: number;
  /** 伺服器 ping 間隔 ms（預設 30000） */
  pingInterval?: number;
  /** 預設任務超時 ms（預設 90000） */
  defaultTaskTimeout?: number;
  /** 自訂日誌 */
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface OpusRelay {
  /** 發送純文字任務，回傳結果。離線/超時回傳 null */
  sendTask: (prompt: string, timeout?: number) => Promise<string | null>;
  /** 發送結構化 debug 請求，回傳 JSON。離線/超時回傳 null */
  sendDebugRequest: (params: DebugRequestParams) => Promise<any | null>;
  /** Relay 是否在線 */
  isOnline: () => boolean;
  /** 取得統計 */
  getStats: () => RelayStats;
  /** 取得 WebSocketServer 實例（給進階用途） */
  getWss: () => WebSocketServer;
  /** 手動處理 HTTP upgrade（如果你的 server 不是用 attachTo） */
  handleUpgrade: (req: IncomingMessage, socket: any, head: Buffer) => void;
  /** 直接掛到現有 HTTP server */
  attachTo: (httpServer: any) => void;
  /** 啟動獨立 WebSocket server（不需要現有 HTTP server） */
  listen: (port: number) => void;
  /** 關閉 */
  close: () => void;

  // ── Bun 相容層 ──
  /** Bun 原生 WebSocket upgrade handler（放在 fetch 裡） */
  bunHandleUpgrade?: (req: Request, server: any, url?: URL) => Response | undefined;
  /** Bun 原生 WebSocket handlers（放在 websocket 設定裡） */
  bunWsHandlers?: {
    open: (ws: any) => void;
    message: (ws: any, message: string | Buffer) => void;
    close: (ws: any) => void;
  };
}

export interface DebugRequestParams {
  errorDescription: string;
  errorMessage?: string;
  environment?: Record<string, any>;
  kbContext?: string;
  kbEntryIds?: number[];
  specialistHint?: string;
  similarBugs?: string;
}

export interface RelayStats {
  online: boolean;
  connectedAt: number;
  lastHeartbeat: number;
  pendingRequests: number;
  totalTasksSent: number;
  totalTasksCompleted: number;
  totalTasksFailed: number;
  totalTasksTimedOut: number;
}

// ─── 工廠函數 ───

export function createOpusRelay(options: OpusRelayOptions): OpusRelay {
  const {
    password,
    path = '/api/opus-relay',
    heartbeatTimeout = 60_000,
    pingInterval = 30_000,
    defaultTaskTimeout = 90_000,
    logger = {
      info: (msg: string) => console.log(`[opus-relay] ${msg}`),
      warn: (msg: string) => console.warn(`[opus-relay] ${msg}`),
      error: (msg: string) => console.error(`[opus-relay] ${msg}`),
    },
  } = options;

  // ─── 內部狀態 ───
  let clientWs: WebSocket | null = null;
  let lastHeartbeat = 0;
  let connectedAt = 0;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const stats = {
    totalTasksSent: 0,
    totalTasksCompleted: 0,
    totalTasksFailed: 0,
    totalTasksTimedOut: 0,
  };

  const pendingRequests = new Map<string, {
    resolve: (result: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // ─── ws WebSocketServer ───
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket) => {
    handleOpen(ws);

    ws.on('message', (data: Buffer | string) => {
      handleMessage(data.toString());
    });

    ws.on('close', () => {
      handleClose(ws);
    });

    ws.on('error', (err: Error) => {
      logger.warn(`WebSocket error: ${err.message}`);
    });
  });

  // ─── 內部工具 ───

  function generateId(): string {
    return `relay_${randomUUID()}`;
  }

  function isOnline(): boolean {
    return clientWs !== null && (Date.now() - lastHeartbeat) < heartbeatTimeout;
  }

  // ─── WebSocket 生命週期 ───

  function handleOpen(ws: WebSocket): void {
    if (clientWs && clientWs !== ws) {
      logger.info('🔄 New relay connection replacing old one');
    }

    clientWs = ws;
    lastHeartbeat = Date.now();
    connectedAt = Date.now();

    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        try { clientWs.ping(); } catch {}
      }
    }, pingInterval);

    logger.info('🔗 Opus Relay connected');
  }

  function handleClose(closingWs: WebSocket): void {
    if (clientWs !== null && clientWs !== closingWs) {
      logger.info('🔌 Old relay connection closed (no impact)');
      return;
    }

    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    clientWs = null;
    connectedAt = 0;

    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Opus Relay disconnected'));
      pendingRequests.delete(id);
    }

    logger.info('🔌 Opus Relay disconnected');
  }

  function handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'heartbeat') {
        lastHeartbeat = Date.now();
        safeSend({ type: 'heartbeat_ack' });
        return;
      }

      if (msg.type === 'task_response' && msg.id) {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.id);
          if (msg.error) { stats.totalTasksFailed++; pending.reject(new Error(msg.error)); }
          else { stats.totalTasksCompleted++; pending.resolve(msg.result); }
        }
        return;
      }

      if (msg.type === 'debug_response' && msg.id) {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.id);
          if (msg.error) { stats.totalTasksFailed++; pending.reject(new Error(msg.error)); }
          else { stats.totalTasksCompleted++; pending.resolve(msg.analysis); }
        }
        return;
      }
    } catch (err: any) {
      logger.warn(`Message parse error: ${err.message}`);
    }
  }

  function safeSend(obj: any): void {
    try {
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(obj));
      }
    } catch {}
  }

  // ─── 認證 ───

  function authenticate(req: IncomingMessage): boolean {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    // 只接受 header 認證（不接受 query string，避免密碼出現在 log）
    const pw = req.headers['x-relay-password'] as string || '';
    return constantTimeCompare(pw, password);
  }

  // ─── 公開 API ───

  function handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): void {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== path) return;

    if (!authenticate(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  function attachTo(httpServer: any): void {
    httpServer.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
      handleUpgrade(req, socket, head);
    });
    logger.info(`📡 Opus Relay attached to HTTP server at ${path}`);
  }

  function listen(port: number): void {
    const { createServer } = require('http');
    const server = createServer((_req: any, res: any) => {
      // 安全：只回傳最小資訊，不洩漏連線時間、pending 數量等細節
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ opus_relay: { online: isOnline() } }));
    });
    server.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
      handleUpgrade(req, socket, head);
    });
    server.listen(port, () => {
      logger.info(`📡 Opus Relay server listening on port ${port}`);
      logger.info(`   WebSocket: ws://localhost:${port}${path}`);
    });
  }

  async function sendTask(prompt: string, timeout?: number): Promise<string | null> {
    if (!isOnline()) return null;

    const requestId = generateId();
    const taskTimeout = timeout || defaultTaskTimeout;
    stats.totalTasksSent++;

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        stats.totalTasksTimedOut++;
        logger.warn(`Task timeout (${(taskTimeout / 1000).toFixed(0)}s): ${requestId}`);
        resolve(null);
      }, taskTimeout);

      pendingRequests.set(requestId, {
        resolve: (result) => resolve(result),
        reject: () => resolve(null),
        timer,
      });

      try {
        safeSend({ type: 'task_request', id: requestId, prompt, timeout: taskTimeout });
        logger.info(`📡 Task sent: ${requestId}`);
      } catch {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        resolve(null);
      }
    });
  }

  async function sendDebugRequest(params: DebugRequestParams): Promise<any | null> {
    if (!isOnline()) return null;

    const requestId = generateId();
    stats.totalTasksSent++;

    return new Promise<any | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        stats.totalTasksTimedOut++;
        logger.warn(`Debug timeout (90s): ${requestId}`);
        resolve(null);
      }, defaultTaskTimeout);

      pendingRequests.set(requestId, {
        resolve: (analysis) => resolve(analysis),
        reject: () => resolve(null),
        timer,
      });

      try {
        safeSend({
          type: 'debug_request',
          id: requestId,
          error_description: params.errorDescription,
          error_message: params.errorMessage || '',
          environment: params.environment || {},
          ...(params.kbContext ? { kb_context: params.kbContext, kb_entry_ids: params.kbEntryIds || [] } : {}),
          ...(params.specialistHint ? { specialist_hint: params.specialistHint } : {}),
          ...(params.similarBugs ? { similar_bugs: params.similarBugs } : {}),
        });
        logger.info(`📡 Debug request sent: ${requestId}`);
      } catch {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        resolve(null);
      }
    });
  }

  function getStats(): RelayStats {
    return {
      online: isOnline(),
      connectedAt,
      lastHeartbeat,
      pendingRequests: pendingRequests.size,
      ...stats,
    };
  }

  function close(): void {
    if (pingTimer) clearInterval(pingTimer);
    wss.close();
  }

  // ─── Bun 相容層 ───
  // 如果你的 VPS 用 Bun 原生 server，可以用這些 handler
  const wsType = 'opus-relay';

  const bunHandleUpgrade = (req: Request, server: any, url?: globalThis.URL): Response | undefined => {
    const parsedUrl = url || new globalThis.URL(req.url);
    if (parsedUrl.pathname !== path) return undefined;

    const pw = req.headers.get('x-relay-password') || '';
    if (!constantTimeCompare(pw, password)) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (server.upgrade(req, { data: { type: wsType } })) {
      return undefined;
    }
    return new Response('WebSocket upgrade failed', { status: 500 });
  };

  const bunWsHandlers = {
    open(ws: any) {
      if (ws.data?.type === wsType) {
        // 包一層，讓 Bun 的 ServerWebSocket 看起來像 ws 的 WebSocket
        const wrapped = {
          get readyState() { return ws.readyState; },
          send: (data: string) => ws.send(data),
          ping: () => ws.ping(),
          close: () => ws.close(),
          _bunWs: ws,
        };
        handleOpen(wrapped as any);
      }
    },
    message(ws: any, message: string | Buffer) {
      if (ws.data?.type === wsType) {
        handleMessage(typeof message === 'string' ? message : message.toString());
      }
    },
    close(ws: any) {
      if (ws.data?.type === wsType) {
        // 找到對應的 wrapped 物件
        if (clientWs && (clientWs as any)._bunWs === ws) {
          handleClose(clientWs);
        }
      }
    },
  };

  return {
    sendTask,
    sendDebugRequest,
    isOnline,
    getStats,
    getWss: () => wss,
    handleUpgrade,
    attachTo,
    listen,
    close,
    bunHandleUpgrade,
    bunWsHandlers,
  };
}
