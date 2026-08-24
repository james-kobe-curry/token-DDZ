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
  }

  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.socket?.readyState === WebSocket.CONNECTING && this.connectPromise) return this.connectPromise;
    this.onStatus('connecting');
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.onopen = () => { this.connectPromise = null; this.onStatus('connected'); resolve(); };
      socket.onerror = () => { this.connectPromise = null; reject(new Error('无法连接局域网房主')); };
      socket.onclose = () => { this.connectPromise = null; this.onStatus('disconnected'); this.rejectPending(new Error('连接已经断开')); };
      socket.onmessage = ({ data }) => this.receive(data);
    });
    return this.connectPromise;
  }

  receive(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
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

  createRoom(name) { return this.request('create_room', { name }); }
  joinRoom(code, name) { return this.request('join_room', { code, name }); }
  reconnect(session = this.loadSession()) { return this.request('reconnect', session || {}); }
  setReady(ready) { return this.request('ready', { ready }); }
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
    this.socket?.close();
    this.socket = null;
  }
}

export function defaultLanWebSocketUrl(locationLike = window.location) {
  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${locationLike.host}/ws`;
}
