import WebSocket from 'ws';

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
try {
  const [host, apple, android] = clients;
  const hostSession = await host.request('create_room', { name: '房主' });
  await apple.request('join_room', { code: hostSession.code, name: '苹果玩家' });
  await android.request('join_room', { code: hostSession.code, name: '安卓玩家' });
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
  console.log(JSON.stringify({ room: hostSession.code, players: 3, stateVersion: 3, landlord: 0, hiddenInformationProtected: true, duplicateSafe: true }));
} finally {
  clients.forEach((client) => client.close());
}
