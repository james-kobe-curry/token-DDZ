import { LAN_CLIENT_VERSION, LAN_PROTOCOL_VERSION, protocolPayload } from './lanProtocol.js';

const SESSION_KEY = 'token-landlords:lan-session:v1';

export function readLanSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

export class LanClient {
  constructor({ url, onMessage = () => {}, onStatus = () => {} }) {
    this.url = url;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.socket = null;
    this.requestSerial = 0;
    this.pending = new Map();
    this.session = null;
    this.seq = 0;
    this.connectPromise = null;
    this.retryTimer = null;
    this.reconnectAttempt = 0;
    this.reconnectInFlight = false;
    this.manualClose = false;
    this.protocolError = null;
  }

  connect({ reconnecting = false } = {}) {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.socket?.readyState === WebSocket.CONNECTING && this.connectPromise) return this.connectPromise;
    this.manualClose = false;
    this.onStatus(reconnecting ? 'reconnecting' : 'connecting');
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      let opened = false;
      socket.onopen = () => { opened = true; this.connectPromise = null; if (!reconnecting) this.onStatus('connected'); resolve(); };
      socket.onerror = () => { if (!opened) { this.connectPromise = null; reject(new Error('无法连接局域网房主')); } };
      socket.onclose = () => {
        if (this.socket === socket) this.socket = null;
        this.connectPromise = null;
        if (!opened) reject(new Error('无法连接局域网房主'));
        this.rejectPending(new Error('连接已经断开'));
        if (!this.manualClose && this.session && !this.reconnectInFlight) this.scheduleReconnect();
        else if (!this.manualClose) this.onStatus('disconnected');
      };
      socket.onmessage = ({ data }) => this.receive(data);
    });
    return this.connectPromise;
  }

  scheduleReconnect() {
    if (this.manualClose || this.retryTimer || !this.session) return;
    const delays = [1000, 2000, 4000, 8000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.onStatus('reconnecting');
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      this.reconnectInFlight = true;
      try {
        await this.connect({ reconnecting: true });
        await this.reconnect(this.session);
        await this.sync();
        this.reconnectAttempt = 0;
        this.onStatus('connected');
      } catch {
        this.reconnectAttempt += 1;
        this.reconnectInFlight = false;
        this.scheduleReconnect();
        return;
      }
      this.reconnectInFlight = false;
    }, delay);
  }

  receive(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type === 'hello' && message.payload?.protocolVersion !== LAN_PROTOCOL_VERSION) {
      this.protocolError = new Error(`联机版本不兼容，请升级到 ${LAN_CLIENT_VERSION}`);
      this.protocolError.code = 'PROTOCOL_MISMATCH';
      this.onStatus('incompatible');
      this.onMessage({ type: 'error', code: this.protocolError.code, message: this.protocolError.message });
      this.rejectPending(this.protocolError);
      this.manualClose = true;
      this.socket?.close();
      return;
    }
    if (message.type === 'host_closing') {
      this.manualClose = true;
      this.onStatus('disconnected');
    }
    if (message.type === 'session') {
      this.session = message.payload;
      this.seq = Math.max(this.seq, Number(message.payload.lastSeq) || 0);
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(message.payload)); } catch { /* optional persistence */ }
    }
    if (message.requestId && this.pending.has(message.requestId)) {
      const request = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      if (message.type === 'error') request.reject(Object.assign(new Error(message.message), { code: message.code }));
      else request.resolve(message.payload);
    }
    this.onMessage(message);
  }

  request(type, payload = {}) {
    if (this.protocolError) return Promise.reject(this.protocolError);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('局域网连接尚未建立'));
    const requestId = `r${++this.requestSerial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('房主响应超时')); }, 8000);
      this.pending.set(requestId, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ type, requestId, payload }));
    });
  }

  createRoom(name) { return this.request('create_room', protocolPayload({ name })); }
  joinRoom(code, name) { return this.request('join_room', protocolPayload({ code, name })); }
  reconnect(session = this.loadSession()) { return this.request('reconnect', protocolPayload(session || {})); }
  setReady(ready) { return this.request('ready', { ready }); }
  setBots(count) { return this.request('bots', { count }); }
  setRematch(ready) { return this.request('rematch', { ready }); }
  sync() { return this.request('sync'); }
  act(action, stateVersion) { return this.request('action', { seq: ++this.seq, stateVersion, action }); }

  loadSession() {
    return readLanSession();
  }

  rejectPending(error) {
    this.pending.forEach((request) => request.reject(error));
    this.pending.clear();
  }

  close() {
    this.manualClose = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.close();
    this.socket = null;
  }
}

export function defaultLanWebSocketUrl(locationLike = window.location) {
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationLike.host}/ws`;
}
