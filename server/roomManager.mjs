import { createHash, randomBytes, randomInt } from 'node:crypto';
import { createAuthoritativeGame, GameActionError, projectGameForPlayer, reduceAuthoritativeAction } from '../src/authoritativeGame.js';
import { analyzeAiDecision, estimateBid } from '../src/gameLogic.js';
import { LAN_DISCONNECT_GRACE_MS, LAN_TURN_TIME_MS } from '../src/lanProtocol.js';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BOT_NAMES = ['墨衡·大师', '红绫·大师'];

export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoomError';
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (condition) throw new RoomError(code, message);
}

function roomCode() {
  return Array.from({ length: 6 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');
}

function sessionToken() {
  return randomBytes(24).toString('base64url');
}

function cleanName(name) {
  const normalized = String(name || '牌友').trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 16);
  return normalized || '牌友';
}

function makeCommit(game) {
  return createHash('sha256').update(`${game.seed}:${game.deckOrder.join('|')}`).digest('hex');
}

function createRound(now = Date.now()) {
  const game = createAuthoritativeGame();
  return { ...game, commit: makeCommit(game), turnDeadline: now + LAN_TURN_TIME_MS };
}

function armDeadline(game, now, delay = LAN_TURN_TIME_MS) {
  return ['bidding', 'playing'].includes(game?.phase) ? { ...game, turnDeadline: now + delay } : game;
}

function roomCanStart(room) {
  return room.players.length === 3
    && new Set(room.players.map((player) => player.seat)).size === 3
    && room.players.every((player) => player.isBot || (player.ready && player.connected));
}

function humansReadyForRematch(room) {
  return room.players.length === 3 && room.players.every((player) => player.isBot || (player.connected && player.rematchReady));
}

export class LanRoomManager {
  constructor({ now = () => Date.now() } = {}) {
    this.rooms = new Map();
    this.now = now;
  }

  createRoom({ name }) {
    let code;
    do code = roomCode(); while (this.rooms.has(code));
    const token = sessionToken();
    const player = { id: `p-${randomBytes(8).toString('hex')}`, token, seat: 0, name: cleanName(name), ready: false, rematchReady: false, connected: true, lastSeq: 0, isBot: false };
    this.rooms.set(code, { code, createdAt: this.now(), updatedAt: this.now(), players: [player], game: null });
    return { code, token, playerId: player.id, seat: player.seat, lastSeq: player.lastSeq };
  }

  joinRoom({ code, name }) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    fail(!room, 'ROOM_NOT_FOUND', '房间不存在或已经关闭');
    fail(room.game, 'ROOM_STARTED', '牌局已经开始，不能加入新玩家');
    let seat = [0, 1, 2].find((candidate) => !room.players.some((player) => player.seat === candidate));
    if (seat === undefined) {
      const replaceableBot = room.players.filter((player) => player.isBot).sort((a, b) => b.seat - a.seat)[0];
      fail(!replaceableBot, 'ROOM_FULL', '房间已经满员');
      seat = replaceableBot.seat;
      room.players = room.players.filter((player) => player !== replaceableBot);
    }
    const token = sessionToken();
    const player = { id: `p-${randomBytes(8).toString('hex')}`, token, seat, name: cleanName(name), ready: false, rematchReady: false, connected: true, lastSeq: 0, isBot: false };
    room.players.push(player);
    room.updatedAt = this.now();
    return { code: room.code, token, playerId: player.id, seat, lastSeq: player.lastSeq };
  }

  reconnect({ code, token }) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    fail(!room, 'ROOM_NOT_FOUND', '房间不存在或已经关闭');
    const player = room.players.find((candidate) => !candidate.isBot && token && candidate.token === token);
    fail(!player, 'INVALID_SESSION', '重连凭证无效');
    player.connected = true;
    if (room.game && ['bidding', 'playing'].includes(room.game.phase) && room.game.current === player.seat) room.game = armDeadline(room.game, this.now());
    room.updatedAt = this.now();
    return { code: room.code, token: player.token, playerId: player.id, seat: player.seat, lastSeq: player.lastSeq };
  }

  disconnect(code, token) {
    const room = this.rooms.get(code);
    const player = room?.players.find((candidate) => !candidate.isBot && token && candidate.token === token);
    if (!player) return;
    player.connected = false;
    player.rematchReady = false;
    if (!room.game) player.ready = false;
    if (room.game && ['bidding', 'playing'].includes(room.game.phase) && room.game.current === player.seat) {
      room.game = { ...room.game, turnDeadline: Math.min(room.game.turnDeadline || Number.POSITIVE_INFINITY, this.now() + LAN_DISCONNECT_GRACE_MS) };
    }
    room.updatedAt = this.now();
  }

  setReady(code, token, ready) {
    const { room, player } = this.session(code, token);
    fail(room.game, 'ROOM_STARTED', '牌局已经开始');
    fail(ready && !player.connected, 'PLAYER_OFFLINE', '离线玩家不能准备');
    player.ready = Boolean(ready);
    room.updatedAt = this.now();
    if (roomCanStart(room)) room.game = createRound(this.now());
    return this.snapshot(code, token);
  }

  setBots(code, token, count) {
    const { room, player } = this.session(code, token);
    fail(room.game, 'ROOM_STARTED', '牌局已经开始，不能调整人机');
    fail(player.seat !== 0, 'NOT_HOST', '只有房主可以调整人机座位');
    fail(!Number.isInteger(count) || count < 0 || count > 2, 'INVALID_BOT_COUNT', '人机数量必须为 0 到 2');
    let humans = room.players.filter((candidate) => !candidate.isBot);
    const replaceableHumans = humans.filter((candidate) => candidate.seat !== 0 && !candidate.connected).sort((a, b) => b.seat - a.seat);
    while (count > 3 - humans.length && replaceableHumans.length) {
      const removed = replaceableHumans.shift();
      room.players = room.players.filter((candidate) => candidate !== removed);
      humans = humans.filter((candidate) => candidate !== removed);
    }
    fail(count > 3 - humans.length, 'BOT_SEATS_FULL', '没有足够空位补入这些人机');
    let bots = room.players.filter((candidate) => candidate.isBot).sort((a, b) => a.seat - b.seat);
    while (bots.length > count) {
      const removed = bots.pop();
      room.players = room.players.filter((candidate) => candidate !== removed);
    }
    while (bots.length < count) {
      const seat = [1, 2].find((candidate) => !room.players.some((occupant) => occupant.seat === candidate));
      fail(seat === undefined, 'BOT_SEATS_FULL', '没有可用的人机座位');
      const bot = { id: `bot-${randomBytes(8).toString('hex')}`, token: null, seat, name: BOT_NAMES[seat - 1], ready: true, rematchReady: true, connected: true, lastSeq: 0, isBot: true, difficulty: 'master' };
      room.players.push(bot);
      bots.push(bot);
      bots.sort((a, b) => a.seat - b.seat);
    }
    room.updatedAt = this.now();
    if (roomCanStart(room)) room.game = createRound(this.now());
    return this.snapshot(code, token);
  }

  performAction(code, token, { seq, stateVersion, action }) {
    const { room, player } = this.session(code, token);
    fail(!room.game, 'ROOM_NOT_STARTED', '房间还没有开局');
    fail(!Number.isInteger(seq) || seq < 1, 'INVALID_SEQUENCE', '动作序号无效');
    if (seq <= player.lastSeq) return { duplicate: true, snapshot: this.snapshot(code, token) };
    fail(stateVersion !== room.game.stateVersion, 'STALE_STATE', '客户端状态已过期，请先同步最新牌局');
    try {
      room.game = armDeadline(reduceAuthoritativeAction(room.game, { ...action, player: player.seat }), this.now());
    } catch (error) {
      if (error instanceof GameActionError) throw new RoomError(error.code, error.message);
      throw error;
    }
    player.lastSeq = seq;
    room.updatedAt = this.now();
    if (room.game.phase === 'redeal') room.game = createRound(this.now());
    return { duplicate: false, snapshot: this.snapshot(code, token) };
  }

  setRematch(code, token, ready) {
    const { room, player } = this.session(code, token);
    fail(room.game?.phase !== 'ended', 'ROUND_NOT_ENDED', '当前牌局尚未结束');
    player.rematchReady = Boolean(ready);
    room.updatedAt = this.now();
    if (humansReadyForRematch(room)) {
      room.players.forEach((candidate) => { candidate.rematchReady = false; candidate.ready = true; });
      room.game = createRound(this.now());
    }
    return this.snapshot(code, token);
  }

  tick() {
    const now = this.now();
    const changed = [];
    for (const room of this.rooms.values()) {
      const game = room.game;
      if (!game || !['bidding', 'playing'].includes(game.phase)) continue;
      const player = game.current;
      const seatPlayer = room.players.find((candidate) => candidate.seat === player);
      const botTurn = Boolean(seatPlayer?.isBot);
      if (!botTurn && (!game.turnDeadline || now < game.turnDeadline)) continue;
      let action;
      if (game.phase === 'bidding') {
        const bid = estimateBid(game.hands[player], seatPlayer?.difficulty || 'master', { currentPlayer: player, turnSerial: game.stateVersion });
        action = { type: 'bid', score: bid > game.highestBid ? bid : 0 };
      } else {
        const decision = analyzeAiDecision(game.hands[player], game.lastPlay, {
          currentPlayer: player, landlord: game.landlord, lastPlayer: game.lastActor,
          handSizes: game.hands.map((hand) => hand.length), seenCards: game.playedCards,
          publicCards: game.bottom, passCount: game.passCount, playedByPlayer: game.playedByPlayer,
          lastMoves: game.lastMoves, actionHistory: game.actionHistory, bombCount: game.bombCount,
          turnSerial: game.stateVersion, difficulty: seatPlayer?.difficulty || 'master',
        });
        action = decision.action === 'play' ? { type: 'play', cardIds: decision.cards.map((card) => card.id) } : { type: 'pass' };
      }
      room.game = reduceAuthoritativeAction(game, { ...action, player });
      room.game = { ...room.game, lastAction: { ...room.game.lastAction, automated: true, bot: botTurn } };
      room.game = room.game.phase === 'redeal' ? createRound(now) : armDeadline(room.game, now);
      room.updatedAt = now;
      changed.push(room.code);
    }
    return changed;
  }

  session(code, token) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    fail(!room, 'ROOM_NOT_FOUND', '房间不存在或已经关闭');
    const player = room.players.find((candidate) => !candidate.isBot && token && candidate.token === token);
    fail(!player, 'INVALID_SESSION', '房间身份无效');
    return { room, player };
  }

  snapshot(code, token) {
    const { room, player } = this.session(code, token);
    return {
      code: room.code,
      selfPlayer: player.seat,
      players: room.players.map(({ id, seat, name, ready, rematchReady, connected, isBot, difficulty }) => ({ id, seat, name, ready, rematchReady, connected, isBot: Boolean(isBot), difficulty })).sort((a, b) => a.seat - b.seat),
      game: room.game ? projectGameForPlayer(room.game, player.seat) : null,
      updatedAt: room.updatedAt,
    };
  }

  tokensForRoom(code) {
    return this.rooms.get(code)?.players.filter((player) => !player.isBot).map((player) => player.token) || [];
  }

  prune({ emptyAfter = 10 * 60 * 1000, finishedAfter = 30 * 60 * 1000 } = {}) {
    const now = this.now();
    for (const [code, room] of this.rooms) {
      const nobodyConnected = room.players.filter((player) => !player.isBot).every((player) => !player.connected);
      const finished = room.game?.phase === 'ended';
      if ((nobodyConnected && now - room.updatedAt > emptyAfter) || (finished && now - room.updatedAt > finishedAfter)) this.rooms.delete(code);
    }
  }
}
