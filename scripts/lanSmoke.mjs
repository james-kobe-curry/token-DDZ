import WebSocket from 'ws';
import { LanClient } from '../src/lanClient.js';
import { LAN_PROTOCOL_VERSION, protocolPayload } from '../src/lanProtocol.js';

const url = process.env.LAN_WS_URL || 'ws://127.0.0.1:4174/ws';

class SmokeClient {
  constructor(name) {
    this.name = name;
    this.socket = new WebSocket(url);
    this.serial = 0;
    this.pending = new Map();
    this.session = null;
    this.state = null;
    this.opened = new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
    this.socket.on('message', (raw) => this.receive(JSON.parse(raw.toString())));
  }

  receive(message) {
    if (message.type === 'session') this.session = message.payload;
    if (message.type === 'room_state') this.state = message.payload;
    const request = this.pending.get(message.requestId);
    if (!request) return;
    this.pending.delete(message.requestId);
    if (message.type === 'error') request.reject(Object.assign(new Error(message.message), { code: message.code }));
    else request.resolve(message.payload);
  }

  async request(type, payload = {}) {
    await this.opened;
    const requestId = `${this.name}-${++this.serial}`;
    this.socket.send(JSON.stringify({ type, requestId, payload }));
    return new Promise((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
  }

  waitFor(predicate, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (predicate(this.state)) return resolve(this.state);
        if (Date.now() - started > timeout) return reject(new Error(`${this.name} did not receive the expected room state`));
        setTimeout(check, 25);
      };
      check();
    });
  }

  close() { this.socket.close(); }
}

const clients = [new SmokeClient('host'), new SmokeClient('apple'), new SmokeClient('android')];
let automaticClient = null;
try {
  const [host, apple, android] = clients;
  const hostSession = await host.request('create_room', protocolPayload({ name: '房主' }));
  const appleSession = await apple.request('join_room', protocolPayload({ code: hostSession.code, name: '苹果玩家' }));
  await android.request('join_room', protocolPayload({ code: hostSession.code, name: '安卓玩家' }));
  await Promise.all(clients.map((client) => client.waitFor((state) => state?.players?.length === 3)));
  await Promise.all(clients.map((client) => client.request('ready', { ready: true })));
  await Promise.all(clients.map((client) => client.waitFor((state) => state?.game?.phase === 'bidding')));

  await host.request('action', { seq: 1, stateVersion: 0, action: { type: 'bid', score: 1 } });
  await android.request('action', { seq: 1, stateVersion: 1, action: { type: 'bid', score: 0 } });
  await apple.request('action', { seq: 1, stateVersion: 2, action: { type: 'bid', score: 0 } });
  await Promise.all(clients.map((client) => client.waitFor((state) => state?.game?.phase === 'playing' && state.game.stateVersion === 3)));

  if (host.state.game.selfHand.length !== 20) throw new Error('landlord did not receive the bottom cards');
  if (apple.state.game.selfHand.length !== 17 || android.state.game.selfHand.length !== 17) throw new Error('farmer hand size changed unexpectedly');
  if (clients.some((client) => 'hands' in client.state.game || 'seed' in client.state.game)) throw new Error('a client snapshot leaked hidden game data');

  const duplicate = await host.request('action', { seq: 1, stateVersion: 3, action: { type: 'pass' } });
  if (!duplicate.duplicate) throw new Error('duplicate action was not acknowledged idempotently');
  apple.close();
  const restoredApple = new SmokeClient('apple-restored');
  clients.push(restoredApple);
  const restoredSession = await restoredApple.request('reconnect', protocolPayload(appleSession));
  if (restoredSession.seat !== appleSession.seat) throw new Error('reconnect did not restore the original seat');
  await restoredApple.waitFor((state) => state?.game?.stateVersion === 3);

  const oldClient = new SmokeClient('old-client');
  clients.push(oldClient);
  let versionRejected = false;
  try { await oldClient.request('create_room', { name: '旧版本' }); } catch (error) { versionRejected = error.code === 'PROTOCOL_MISMATCH'; }
  if (!versionRejected) throw new Error('incompatible client protocol was not rejected');

  globalThis.WebSocket = WebSocket;
  const statuses = [];
  let syncedStates = 0;
  automaticClient = new LanClient({
    url,
    onStatus: (status) => statuses.push(status),
    onMessage: (message) => { if (message.type === 'room_state') syncedStates += 1; },
  });
  await automaticClient.connect();
  await automaticClient.createRoom('自动重连测试');
  await automaticClient.sync();
  automaticClient.socket.terminate();
  const reconnectStarted = Date.now();
  while (!(statuses.at(-1) === 'connected' && statuses.includes('reconnecting') && syncedStates >= 2) && Date.now() - reconnectStarted < 6000) await new Promise((resolve) => setTimeout(resolve, 100));
  if (statuses.at(-1) !== 'connected' || !statuses.includes('reconnecting') || syncedStates < 2) throw new Error('LanClient did not reconnect and synchronize automatically');

  console.log(JSON.stringify({ room: hostSession.code, players: 3, protocolVersion: LAN_PROTOCOL_VERSION, stateVersion: 3, landlord: 0, hiddenInformationProtected: true, duplicateSafe: true, reconnectSafe: true, autoReconnectSafe: true, oldVersionRejected: true }));
} finally {
  automaticClient?.close();
  clients.forEach((client) => client.close());
}
