import { Capacitor, registerPlugin } from '@capacitor/core';
import { HostRoomError, HostRoomManager } from './hostRoomManager.js';
import { LAN_CLIENT_VERSION, LAN_PROTOCOL_VERSION } from './lanProtocol.js';

const PhoneLanHostPlugin = registerPlugin('PhoneLanHost');

export function canHostOnThisDevice() {
  return Capacitor.getPlatform() === 'android';
}

export class PhoneLanHostController {
  constructor({ onStopped = () => {} } = {}) {
    this.onStopped = onStopped;
    this.manager = new HostRoomManager();
    this.sessions = new Map();
    this.listenerHandles = [];
    this.queue = Promise.resolve();
    this.pruneTimer = null;
    this.started = false;
  }

  async start({ port = 4174 } = {}) {
    if (!canHostOnThisDevice()) throw new Error('只有 Android 安装包可以在本机创建房主服务');
    if (this.started) throw new Error('本机房主服务已经启动');
    this.listenerHandles = await Promise.all([
      PhoneLanHostPlugin.addListener('clientOpen', ({ clientId }) => this.enqueue(() => this.handleOpen(clientId))),
      PhoneLanHostPlugin.addListener('clientMessage', ({ clientId, message }) => this.enqueue(() => this.handleMessage(clientId, message))),
      PhoneLanHostPlugin.addListener('clientClose', ({ clientId }) => this.enqueue(() => this.handleClose(clientId))),
      PhoneLanHostPlugin.addListener('hostStopped', ({ reason }) => { this.started = false; this.onStopped(reason || '手机房主服务已停止'); }),
    ]);
    try {
      const info = await PhoneLanHostPlugin.start({ port });
      this.started = true;
      this.pruneTimer = window.setInterval(() => this.enqueue(async () => {
        for (const code of await this.manager.tick()) await this.broadcastRoom(code);
        this.manager.prune();
      }), 1000);
      return info;
    } catch (error) {
      await this.removeListeners();
      throw error;
    }
  }

  enqueue(task) {
    this.queue = this.queue.then(task).catch((error) => {
      console.error('Phone LAN host event failed', error);
    });
    return this.queue;
  }

  async handleOpen(clientId) {
    await this.send(clientId, { type: 'hello', payload: { protocolVersion: LAN_PROTOCOL_VERSION, clientVersion: LAN_CLIENT_VERSION, heartbeatMs: 10000, host: 'android' } });
  }

  requireCompatibleClient(payload = {}) {
    if (payload.protocolVersion !== LAN_PROTOCOL_VERSION) throw new HostRoomError('PROTOCOL_MISMATCH', `联机版本不兼容，请将三台设备都升级到 ${LAN_CLIENT_VERSION}`);
  }

  async bindSession(clientId, session) {
    for (const [otherClientId, otherSession] of this.sessions) {
      if (otherClientId !== clientId && otherSession.code === session.code && otherSession.token === session.token) {
        this.sessions.delete(otherClientId);
        await PhoneLanHostPlugin.closeClient({ clientId: otherClientId });
      }
    }
    this.sessions.set(clientId, session);
  }

  async handleMessage(clientId, raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return this.sendError(clientId, new HostRoomError('INVALID_JSON', '消息格式不是有效 JSON')); }
    const requestId = message.requestId;
    try {
      if (message.type === 'create_room') {
        this.requireCompatibleClient(message.payload);
        const session = this.manager.createRoom({ name: message.payload?.name });
        await this.bindSession(clientId, session);
        await this.send(clientId, { type: 'session', requestId, payload: session });
        await this.broadcastRoom(session.code);
      } else if (message.type === 'join_room') {
        this.requireCompatibleClient(message.payload);
        const session = this.manager.joinRoom({ code: message.payload?.code, name: message.payload?.name });
        await this.bindSession(clientId, session);
        await this.send(clientId, { type: 'session', requestId, payload: session });
        await this.broadcastRoom(session.code);
      } else if (message.type === 'reconnect') {
        this.requireCompatibleClient(message.payload);
        const session = this.manager.reconnect(message.payload || {});
        await this.bindSession(clientId, session);
        await this.send(clientId, { type: 'session', requestId, payload: session });
        await this.broadcastRoom(session.code);
      } else if (message.type === 'ready') {
        const session = this.requireSession(clientId);
        const snapshot = await this.manager.setReady(session.code, session.token, message.payload?.ready);
        await this.send(clientId, { type: 'ready_ack', requestId, payload: { ready: Boolean(message.payload?.ready), started: Boolean(snapshot.game) } });
        await this.broadcastRoom(session.code);
      } else if (message.type === 'bots') {
        const session = this.requireSession(clientId);
        const snapshot = await this.manager.setBots(session.code, session.token, message.payload?.count);
        await this.send(clientId, { type: 'bots_ack', requestId, payload: { count: snapshot.players.filter((player) => player.isBot).length, started: Boolean(snapshot.game) } });
        await this.broadcastRoom(session.code);
      } else if (message.type === 'rematch') {
        const session = this.requireSession(clientId);
        const snapshot = await this.manager.setRematch(session.code, session.token, message.payload?.ready);
        await this.send(clientId, { type: 'rematch_ack', requestId, payload: { ready: Boolean(message.payload?.ready), started: snapshot.game?.phase === 'bidding' } });
        await this.broadcastRoom(session.code);
      } else if (message.type === 'action') {
        const session = this.requireSession(clientId);
        const result = await this.manager.performAction(session.code, session.token, message.payload || {});
        await this.send(clientId, { type: 'action_ack', requestId, payload: { duplicate: result.duplicate, stateVersion: result.snapshot.game?.stateVersion } });
        await this.broadcastRoom(session.code);
      } else if (message.type === 'sync') {
        const session = this.requireSession(clientId);
        await this.send(clientId, { type: 'room_state', requestId, payload: this.manager.snapshot(session.code, session.token) });
      } else if (message.type === 'ping') {
        await this.send(clientId, { type: 'pong', requestId, payload: { now: Date.now() } });
      } else {
        throw new HostRoomError('UNKNOWN_MESSAGE', '未知消息类型');
      }
    } catch (error) {
      await this.sendError(clientId, error, requestId);
    }
  }

  async handleClose(clientId) {
    const session = this.sessions.get(clientId);
    this.sessions.delete(clientId);
    const replacementActive = session && [...this.sessions.values()].some((candidate) => candidate.code === session.code && candidate.token === session.token);
    if (session && !replacementActive) this.manager.disconnect(session.code, session.token);
    if (session) await this.broadcastRoom(session.code);
  }

  requireSession(clientId) {
    const session = this.sessions.get(clientId);
    if (!session) throw new HostRoomError('NO_SESSION', '请先创建或加入房间');
    return session;
  }

  async broadcastRoom(code) {
    const sends = [];
    for (const [clientId, session] of this.sessions) {
      if (session.code !== code) continue;
      try { sends.push(this.send(clientId, { type: 'room_state', payload: this.manager.snapshot(code, session.token) })); } catch { /* pruned session */ }
    }
    await Promise.allSettled(sends);
  }

  send(clientId, payload) {
    return PhoneLanHostPlugin.send({ clientId, message: JSON.stringify(payload) });
  }

  sendError(clientId, error, requestId) {
    const message = error instanceof HostRoomError ? error.message : '手机房主处理失败';
    return this.send(clientId, { type: 'error', requestId, code: error.code || 'HOST_ERROR', message }).catch(() => {});
  }

  async removeListeners() {
    const handles = this.listenerHandles;
    this.listenerHandles = [];
    await Promise.allSettled(handles.map((handle) => handle.remove()));
  }

  async stop() {
    if (this.pruneTimer) window.clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.started) {
      await Promise.allSettled([...this.sessions.keys()].map((clientId) => this.send(clientId, { type: 'host_closing', message: '房主已结束本机房间' })));
      await PhoneLanHostPlugin.stop().catch(() => {});
    }
    this.started = false;
    this.sessions.clear();
    await this.removeListeners();
  }
}
