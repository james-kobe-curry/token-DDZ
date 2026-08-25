import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { LanRoomManager, RoomError } from './roomManager.mjs';
import { LAN_CLIENT_VERSION, LAN_PROTOCOL_VERSION } from '../src/lanProtocol.js';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = resolve(projectRoot, 'dist');
const port = Number(process.env.LAN_PORT || 4174);
const host = process.env.LAN_HOST || '0.0.0.0';
const manager = new LanRoomManager();
const sessions = new Map();

function requireCompatibleClient(payload = {}) {
  if (payload.protocolVersion !== LAN_PROTOCOL_VERSION) throw new RoomError('PROTOCOL_MISMATCH', `联机版本不兼容，请将三台设备都升级到 ${LAN_CLIENT_VERSION}`);
}

if (!existsSync(resolve(distRoot, 'index.html'))) throw new Error('dist/index.html is missing; run npm run build before npm run lan:serve');

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

function lanAddresses() {
  return Object.values(networkInterfaces()).flat().filter((address) => address?.family === 'IPv4' && !address.internal).map((address) => `http://${address.address}:${port}`);
}

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function sendError(socket, error, requestId) {
  send(socket, { type: 'error', requestId, code: error.code || 'SERVER_ERROR', message: error instanceof RoomError ? error.message : '服务器处理失败' });
}

function broadcastRoom(code) {
  for (const [socket, session] of sessions) {
    if (session.code !== code) continue;
    try {
      send(socket, { type: 'room_state', payload: manager.snapshot(code, session.token) });
    } catch {
      // A disconnected session may have been pruned between heartbeat ticks.
    }
  }
}

function bindSession(socket, session) {
  for (const [otherSocket, otherSession] of sessions) {
    if (otherSocket !== socket && otherSession.code === session.code && otherSession.token === session.token) {
      sessions.delete(otherSocket);
      otherSocket.close(4001, 'session replaced');
    }
  }
  sessions.set(socket, session);
}

const httpServer = createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: true, protocolVersion: LAN_PROTOCOL_VERSION, clientVersion: LAN_CLIENT_VERSION, rooms: manager.rooms.size, addresses: lanAddresses() }));
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { pathname = '/'; }
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = resolve(distRoot, requested);
  if (!filePath.startsWith(`${distRoot}${sep}`) || !existsSync(filePath) || statSync(filePath).isDirectory()) filePath = resolve(distRoot, 'index.html');
  response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] || 'application/octet-stream', 'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable' });
  createReadStream(filePath).pipe(response);
});

const websocketServer = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 16 * 1024, perMessageDeflate: false });
websocketServer.on('connection', (socket) => {
  socket.alive = true;
  send(socket, { type: 'hello', payload: { protocolVersion: LAN_PROTOCOL_VERSION, clientVersion: LAN_CLIENT_VERSION, heartbeatMs: 10000 } });
  socket.on('pong', () => { socket.alive = true; });
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return sendError(socket, new RoomError('INVALID_JSON', '消息格式不是有效 JSON')); }
    const requestId = message.requestId;
    try {
      if (message.type === 'create_room') {
        requireCompatibleClient(message.payload);
        const session = manager.createRoom({ name: message.payload?.name });
        bindSession(socket, session);
        send(socket, { type: 'session', requestId, payload: session });
        broadcastRoom(session.code);
      } else if (message.type === 'join_room') {
        requireCompatibleClient(message.payload);
        const session = manager.joinRoom({ code: message.payload?.code, name: message.payload?.name });
        bindSession(socket, session);
        send(socket, { type: 'session', requestId, payload: session });
        broadcastRoom(session.code);
      } else if (message.type === 'reconnect') {
        requireCompatibleClient(message.payload);
        const session = manager.reconnect(message.payload || {});
        bindSession(socket, session);
        send(socket, { type: 'session', requestId, payload: session });
        broadcastRoom(session.code);
      } else if (message.type === 'ready') {
        const session = sessions.get(socket);
        if (!session) throw new RoomError('NO_SESSION', '请先创建或加入房间');
        const snapshot = manager.setReady(session.code, session.token, message.payload?.ready);
        send(socket, { type: 'ready_ack', requestId, payload: { ready: Boolean(message.payload?.ready), started: Boolean(snapshot.game) } });
        broadcastRoom(session.code);
      } else if (message.type === 'rematch') {
        const session = sessions.get(socket);
        if (!session) throw new RoomError('NO_SESSION', '请先创建或加入房间');
        const snapshot = manager.setRematch(session.code, session.token, message.payload?.ready);
        send(socket, { type: 'rematch_ack', requestId, payload: { ready: Boolean(message.payload?.ready), started: snapshot.game?.phase === 'bidding' } });
        broadcastRoom(session.code);
      } else if (message.type === 'action') {
        const session = sessions.get(socket);
        if (!session) throw new RoomError('NO_SESSION', '请先创建或加入房间');
        const result = manager.performAction(session.code, session.token, message.payload || {});
        send(socket, { type: 'action_ack', requestId, payload: { duplicate: result.duplicate, stateVersion: result.snapshot.game?.stateVersion } });
        broadcastRoom(session.code);
      } else if (message.type === 'sync') {
        const session = sessions.get(socket);
        if (!session) throw new RoomError('NO_SESSION', '请先创建或加入房间');
        send(socket, { type: 'room_state', requestId, payload: manager.snapshot(session.code, session.token) });
      } else if (message.type === 'ping') send(socket, { type: 'pong', requestId, payload: { now: Date.now() } });
      else throw new RoomError('UNKNOWN_MESSAGE', '未知消息类型');
    } catch (error) {
      sendError(socket, error, requestId);
    }
  });
  socket.on('close', () => {
    const session = sessions.get(socket);
    sessions.delete(socket);
    const replacementActive = session && [...sessions.values()].some((candidate) => candidate.code === session.code && candidate.token === session.token);
    if (session && !replacementActive) manager.disconnect(session.code, session.token);
    if (session) broadcastRoom(session.code);
  });
});

const heartbeat = setInterval(() => {
  for (const socket of websocketServer.clients) {
    if (!socket.alive) socket.terminate();
    else { socket.alive = false; socket.ping(); }
  }
  manager.prune();
}, 10000);
const roomClock = setInterval(() => {
  for (const code of manager.tick()) broadcastRoom(code);
}, 1000);

httpServer.listen(port, host, () => {
  console.log(`Token 斗地主局域网服务已启动：\n${lanAddresses().map((address) => `  ${address}`).join('\n') || `  http://localhost:${port}`}`);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(roomClock);
  websocketServer.close(() => httpServer.close());
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
