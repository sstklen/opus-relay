#!/usr/bin/env node
/**
 * ================================================
 *  Opus Relay — 客戶端（跑在你的 Mac / PC / 任何電腦）
 * ================================================
 *
 * 把本機的 Claude CLI（Opus）透過 WebSocket 橋接到遠端 VPS。
 * VPS 收到任務 → 轉發到這裡 → 本機跑 claude -p → 結果回傳 VPS。
 *
 * 相容性：Node.js 18+ / Bun 1.0+ / macOS / Linux / Windows
 *
 * 啟動：
 *   RELAY_URL=wss://你的VPS/api/opus-relay RELAY_PASSWORD=密碼 npx tsx client.ts
 *   RELAY_URL=wss://你的VPS/api/opus-relay RELAY_PASSWORD=密碼 bun client.ts
 */

import { spawn, execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import WebSocket from 'ws';

// ─── 設定 ───
const RELAY_URL = process.env.RELAY_URL || '';
const RELAY_PASSWORD = process.env.RELAY_PASSWORD || '';

const HEARTBEAT_INTERVAL = 25_000;    // 25 秒心跳
const HEARTBEAT_TIMEOUT = 45_000;     // 45 秒沒 ack → 判定斷線
const MIN_RECONNECT = 3_000;          // 最短 3 秒重連
const MAX_RECONNECT = 60_000;         // 最長 60 秒重連
const STATUS_INTERVAL = 300_000;      // 5 分鐘印一次狀態
const DEFAULT_TASK_TIMEOUT = 120_000; // 預設任務超時 120 秒
const LOCK_FILE = process.platform === 'win32'
  ? `${process.env.TEMP || 'C:\\Temp'}\\opus-relay-client.lock`
  : '/tmp/opus-relay-client.lock';

// ─── 狀態 ───
let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatWatchdog: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let isShuttingDown = false;

const stats = {
  connectedAt: 0,
  totalConnections: 0,
  totalDisconnections: 0,
  heartbeatsSent: 0,
  heartbeatsAcked: 0,
  tasksHandled: 0,
  tasksFailed: 0,
  consecutiveFailures: 0,
};

// ─── 子指令 ───
if (process.argv[2] === 'status') {
  checkRemoteStatus();
} else {
  main();
}

// ================================================
// 主流程
// ================================================

function main(): void {
  if (!RELAY_URL) {
    console.error('❌ RELAY_URL 環境變數必填');
    console.error('   例：wss://your-vps.com/api/opus-relay');
    process.exit(1);
  }
  if (!RELAY_PASSWORD) {
    console.error('❌ RELAY_PASSWORD 環境變數必填');
    process.exit(1);
  }

  // 檢查 claude CLI 是否可用
  if (!isClaudeAvailable()) {
    console.error('❌ 找不到 claude CLI');
    console.error('   安裝：https://docs.anthropic.com/en/docs/claude-code');
    console.error('   安裝後確認 "claude -p hello" 能正常執行');
    process.exit(1);
  }

  if (!acquireLock()) process.exit(1);

  log('🚀 Opus Relay Client 啟動');
  log(`   VPS: ${RELAY_URL.replace(/\?.*/, '')}`);
  log(`   PID: ${process.pid}`);
  log(`   Runtime: ${detectRuntime()}`);

  statusTimer = setInterval(printStatus, STATUS_INTERVAL);
  connect();
}

// ================================================
// Runtime 偵測
// ================================================

function detectRuntime(): string {
  if (typeof globalThis !== 'undefined' && 'Bun' in globalThis) {
    return `Bun ${(globalThis as any).Bun.version}`;
  }
  return `Node.js ${process.version}`;
}

function isClaudeAvailable(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// ================================================
// WebSocket 連線
// ================================================

function connect(): void {
  if (isShuttingDown) return;
  if (ws) { try { ws.close(); } catch {} ws = null; }

  const url = `${RELAY_URL}?password=${encodeURIComponent(RELAY_PASSWORD)}`;
  log(`連接中...${stats.consecutiveFailures > 0 ? `（第 ${stats.consecutiveFailures + 1} 次）` : ''}`);

  try {
    ws = new WebSocket(url);
  } catch (err: any) {
    log(`WebSocket 建立失敗: ${err.message}`);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    stats.connectedAt = Date.now();
    stats.totalConnections++;
    stats.consecutiveFailures = 0;
    log('✅ 已連線，等待任務...');
    startHeartbeat();
  });

  ws.on('message', async (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());

      // 心跳回覆
      if (msg.type === 'heartbeat_ack') {
        stats.heartbeatsAcked++;
        resetHeartbeatWatchdog();
        return;
      }

      // ── 收到通用任務 ──
      if (msg.type === 'task_request' && msg.id && msg.prompt) {
        log(`📥 任務 [${msg.id.slice(-8)}]: ${msg.prompt.slice(0, 60)}...`);
        const timeout = msg.timeout || DEFAULT_TASK_TIMEOUT;

        try {
          const result = await runLocalClaude(msg.prompt, timeout);
          safeSend({ type: 'task_response', id: msg.id, result });
          stats.tasksHandled++;
          log(`✅ 完成 [${msg.id.slice(-8)}]`);
        } catch (err: any) {
          safeSend({ type: 'task_response', id: msg.id, error: err.message });
          stats.tasksFailed++;
          log(`❌ 失敗 [${msg.id.slice(-8)}]: ${err.message}`);
        }
        return;
      }

      // ── 相容舊協議（debug_request）──
      if (msg.type === 'debug_request' && msg.id) {
        log(`📥 debug [${msg.id.slice(-8)}]`);
        try {
          const result = await handleDebugRequest(msg);
          safeSend({ type: 'debug_response', id: msg.id, analysis: result });
          stats.tasksHandled++;
          log(`✅ 完成 [${msg.id.slice(-8)}]`);
        } catch (err: any) {
          safeSend({ type: 'debug_response', id: msg.id, error: err.message });
          stats.tasksFailed++;
          log(`❌ 失敗 [${msg.id.slice(-8)}]: ${err.message}`);
        }
        return;
      }
    } catch (err: any) {
      log(`訊息解析失敗: ${err.message}`);
    }
  });

  ws.on('close', (code: number, reason: Buffer) => {
    log(`連線關閉 (${reason.toString() || `code=${code}`})`);
    stats.totalDisconnections++;
    cleanup();
    scheduleReconnect();
  });

  ws.on('error', (err: Error) => {
    log(`WebSocket 錯誤: ${err.message}`);
  });
}

// ================================================
// 安全傳送
// ================================================

function safeSend(obj: any): void {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch {}
}

// ================================================
// 本機 Claude 執行（相容 Node.js + Bun）
// ================================================

async function runLocalClaude(prompt: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // 清掉 Claude 相關 env var（防 nested session 保護機制）
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE') || key === 'CURRENT_SESSION_ID' || key === 'MCP_REGISTRY_URL') {
        delete env[key];
      }
    }

    const proc = spawn('claude', ['-p', prompt], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`claude exit ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      if (!stdout.trim()) {
        reject(new Error('claude returned empty'));
        return;
      }
      resolve(stdout.trim());
    });

    proc.on('error', (err: Error) => {
      reject(new Error(`claude error: ${err.message}`));
    });
  });
}

/**
 * Debug 相容模式：處理舊版 debug_request 格式
 */
async function handleDebugRequest(msg: any): Promise<any> {
  const isRawPrompt = msg.error_description?.startsWith('[RAW_PROMPT] ');

  if (isRawPrompt) {
    const rawPrompt = msg.error_description.slice('[RAW_PROMPT] '.length);
    const output = await runLocalClaude(rawPrompt, 80_000);
    return { fix_description: output, root_cause: '', confidence: 0.95, fix_steps: [] };
  }

  const kbContext = msg.kb_context || '';
  const kbEntryIds = msg.kb_entry_ids || [];
  const isDrclaw = kbContext.length > 0;

  const prompt = isDrclaw ? [
    'You are a debug AI with verified KB solutions to reference.',
    'Use KB entries as REFERENCE, ADAPT to the specific error.',
    'Respond with ONLY a JSON object (no markdown):',
    '{ "root_cause": "...", "category": "api_error|config_error|logic_error|dependency_error|network_error|permission_error|runtime_error|build_error|general",',
    '  "severity": 1-5, "confidence": 0.0-1.0, "fix_description": "...", "fix_steps": [...], "fix_patch": "...",',
    `  "validated_by_kb": true_or_false, "kb_entry_ids": [${kbEntryIds.join(', ')}] }`,
    '', '## KB Entries', kbContext, '',
    msg.specialist_hint ? `## Specialist Guide\n${msg.specialist_hint}` : '',
    `Error: ${msg.error_description}`,
    msg.error_message ? `Message: ${msg.error_message}` : '',
    Object.keys(msg.environment || {}).length > 0 ? `Env: ${JSON.stringify(msg.environment)}` : '',
    msg.similar_bugs || '',
  ].filter(Boolean).join('\n') : [
    'You are a debug AI. Analyze this error. Respond with ONLY JSON (no markdown):',
    '{ "root_cause": "...", "category": "api_error|config_error|logic_error|dependency_error|network_error|permission_error|runtime_error|build_error|general",',
    '  "severity": 1-5, "confidence": 0.0-1.0, "fix_description": "...", "fix_steps": [...], "fix_patch": "..." }',
    '', msg.specialist_hint ? `## Specialist Guide\n${msg.specialist_hint}` : '',
    `Error: ${msg.error_description}`,
    msg.error_message ? `Message: ${msg.error_message}` : '',
    Object.keys(msg.environment || {}).length > 0 ? `Env: ${JSON.stringify(msg.environment)}` : '',
    msg.similar_bugs || '',
  ].filter(Boolean).join('\n');

  const output = await runLocalClaude(prompt, 80_000);
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Cannot extract JSON: ${output.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

// ================================================
// 心跳 + 看門狗
// ================================================

function startHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    safeSend({ type: 'heartbeat' });
    stats.heartbeatsSent++;
  }, HEARTBEAT_INTERVAL);
  safeSend({ type: 'heartbeat' });
  stats.heartbeatsSent++;
  resetHeartbeatWatchdog();
}

function resetHeartbeatWatchdog(): void {
  if (heartbeatWatchdog) clearTimeout(heartbeatWatchdog);
  heartbeatWatchdog = setTimeout(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      log('⚠️ 心跳超時（45s），主動重連...');
      try { ws.close(); } catch {}
    }
  }, HEARTBEAT_TIMEOUT);
}

// ================================================
// 重連 + 清理
// ================================================

function cleanup(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (heartbeatWatchdog) { clearTimeout(heartbeatWatchdog); heartbeatWatchdog = null; }
  ws = null;
  stats.connectedAt = 0;
}

function scheduleReconnect(): void {
  if (isShuttingDown || reconnectTimer) return;
  stats.consecutiveFailures++;
  const delay = Math.min(MIN_RECONNECT * Math.pow(2, stats.consecutiveFailures - 1), MAX_RECONNECT);
  log(`⏳ ${(delay / 1000).toFixed(0)} 秒後重連...`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

// ================================================
// Lock file（防多開）
// ================================================

function acquireLock(): boolean {
  try {
    if (existsSync(LOCK_FILE)) {
      const oldPid = readFileSync(LOCK_FILE, 'utf-8').trim();
      try {
        process.kill(Number(oldPid), 0);
        console.error(`❌ 已有 relay 在跑 (PID ${oldPid})`);
        console.error(`   刪掉 lock 重試: rm ${LOCK_FILE}`);
        return false;
      } catch { /* PID 已死，可以接手 */ }
    }
    writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch { return true; }
}

function releaseLock(): void {
  try { unlinkSync(LOCK_FILE); } catch {}
}

// ================================================
// 工具
// ================================================

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function uptime(): string {
  if (!stats.connectedAt) return 'offline';
  const sec = Math.floor((Date.now() - stats.connectedAt) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function printStatus(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    log(`📊 Offline | reconnecting (${stats.consecutiveFailures})`);
    return;
  }
  log(`📊 Online ${uptime()} | heartbeat ${stats.heartbeatsAcked}/${stats.heartbeatsSent} | tasks ${stats.tasksHandled} done ${stats.tasksFailed} failed | connections ${stats.totalConnections}`);
}

async function checkRemoteStatus(): Promise<void> {
  if (!RELAY_URL) {
    console.error('❌ RELAY_URL required');
    process.exit(1);
  }
  const apiUrl = RELAY_URL.replace(/\/api.*/, '').replace('wss://', 'https://').replace('ws://', 'http://');
  try {
    const res = await fetch(apiUrl);
    const data: any = await res.json();
    console.log('Opus Relay Status');
    console.log('─'.repeat(30));
    console.log(`Online: ${data?.opus_relay?.online ? '✅ Yes' : '❌ No'}`);
  } catch (err: any) {
    console.error(`❌ Cannot reach VPS: ${err.message}`);
  }
  process.exit(0);
}

// ================================================
// 優雅關閉
// ================================================

function shutdown(signal: string): void {
  log(`${signal} received, shutting down...`);
  printStatus();
  isShuttingDown = true;
  cleanup();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (statusTimer) clearInterval(statusTimer);
  releaseLock();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
