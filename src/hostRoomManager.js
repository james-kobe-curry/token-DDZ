import { createAuthoritativeGame, GameActionError, projectGameForPlayer, reduceAuthoritativeAction } from './authoritativeGame.js';
import { sha256 } from './gameLogic.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class HostRoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostRoomError';
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (condition) throw new HostRoomError(code, message);
}

function secureBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function createRoomCode() {
  return [...secureBytes(6)].map((value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length]).join('');
}

function createToken(bytes = 24) {
  return [...secureBytes(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function cleanName(name) {
  const normalized = String(name || '牌友').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 16);
  return normalized || '牌友';
}

async function createRound() {
  const game = createAuthoritativeGame();
  const commit = await sha256(`${game.seed}:${game.deckOrder.join('|')}`);
  return { ...game, commit };
}

/** Browser-safe room authority used inside an Android host WebView. */
export class HostRoomManager {
  constructor({ now = () => Date.now() } = {}) {
    this.rooms = new Map();
    this.now = now;
  }

  createRoom({ name }) {
    let code;
    do code = createRoomCode(); while (this.rooms.has(code));
    const token = createToken();
    const player = { id: `p-${createToken(8)}`, token, seat: 0, name: cleanName(name), ready: false, connected: true, lastSeq: 0 };
    this.rooms.set(code, { code, createdAt: this.now(), updatedAt: this.now(), players: [player], game: null });
    return { code, token, playerId: player.id, seat: player.seat, lastSeq: player.lastSeq };
  }

  joinRoom({ code, name }) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    fail(!room, 'ROOM_NOT_FOUND', '房间不存在或已经关闭');
    fail(room.game, 'ROOM_STARTED', '牌局已经开始，不能加入新玩家');
    fail(room.players.length >= 3, 'ROOM_FULL', '房间已经满员');
    const token = createToken();
    const seat = room.players.length;
    const player = { id: `p-${createToken(8)}`, token, seat, name: cleanName(name), ready: false, connected: true, lastSeq: 0 };
    room.players.push(player);
    room.updatedAt = this.now();
    return { code: room.code, token, playerId: player.id, seat, lastSeq: player.lastSeq };
  }

  reconnect({ code, token }) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    fail(!room, 'ROOM_NOT_FOUND', '房间不存在或已经关闭');
    const player = room.players.find((candidate) => candidate.token === token);
    fail(!player, 'INVALID_SESSION', '重连凭证无效');
    player.connected = true;
    room.updatedAt = this.now();
    return { code: room.code, token: player.token, playerId: player.id, seat: player.seat, lastSeq: player.lastSeq };
  }

  disconnect(code, token) {
    const room = this.rooms.get(code);
    const player = room?.players.find((candidate) => candidate.token === token);
    if (!player) return;
    player.connected = false;
    room.updatedAt = this.now();
  }

  async setReady(code, token, ready) {
    const { room, player } = this.session(code, token);
    fail(room.game, 'ROOM_STARTED', '牌局已经开始');
    player.ready = Boolean(ready);
    room.updatedAt = this.now();
    if (room.players.length === 3 && room.players.every((candidate) => candidate.ready)) room.game = await createRound();
    return this.snapshot(code, token);
  }

  async performAction(code, token, { seq, stateVersion, action }) {
    const { room, player } = this.session(code, token);
    fail(!room.game, 'ROOM_NOT_STARTED', '房间还没有开局');
    fail(!Number.isInteger(seq) || seq < 1, 'INVALID_SEQUENCE', '动作序号无效');
    if (seq <= player.lastSeq) return { duplicate: true, snapshot: this.snapshot(code, token) };
    fail(stateVersion !== room.game.stateVersion, 'STALE_STATE', '客户端状态已过期，请先同步最新牌局');
    try {
      room.game = reduceAuthoritativeAction(room.game, { ...action, player: player.seat });
    } catch (error) {
      if (error instanceof GameActionError) throw new HostRoomError(error.code, error.message);
      throw error;
    }
    player.lastSeq = seq;
    room.updatedAt = this.now();
    if (room.game.phase === 'redeal') room.game = await createRound();
    return { duplicate: false, snapshot: this.snapshot(code, token) };
  }

  session(code, token) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    fail(!room, 'ROOM_NOT_FOUND', '房间不存在或已经关闭');
    const player = room.players.find((candidate) => candidate.token === token);
    fail(!player, 'INVALID_SESSION', '房间身份无效');
    return { room, player };
  }

  snapshot(code, token) {
    const { room, player } = this.session(code, token);
    return {
      code: room.code,
      selfPlayer: player.seat,
      players: room.players.map(({ id, seat, name, ready, connected }) => ({ id, seat, name, ready, connected })),
      game: room.game ? projectGameForPlayer(room.game, player.seat) : null,
      updatedAt: room.updatedAt,
    };
  }

  prune({ emptyAfter = 10 * 60 * 1000, finishedAfter = 30 * 60 * 1000 } = {}) {
    const now = this.now();
    for (const [code, room] of this.rooms) {
      const nobodyConnected = room.players.every((player) => !player.connected);
      const finished = room.game?.phase === 'ended';
      if ((nobodyConnected && now - room.updatedAt > emptyAfter) || (finished && now - room.updatedAt > finishedAfter)) this.rooms.delete(code);
    }
  }
}
