import {
  canBeat,
  calculateSpring,
  classifyPlay,
  createSeed,
  dealWithSeed,
  nextPlayerCounterClockwise,
  removeCards,
} from './gameLogic.js';

export class GameActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameActionError';
    this.code = code;
  }
}

function reject(condition, code, message) {
  if (condition) throw new GameActionError(code, message);
}

export function createAuthoritativeGame({ seed = createSeed(), commit = '' } = {}) {
  const dealt = dealWithSeed(seed);
  return {
    protocolVersion: 1,
    stateVersion: 0,
    phase: 'bidding',
    hands: dealt.hands,
    bottom: dealt.bottom,
    deckOrder: dealt.deckOrder,
    seed,
    commit,
    current: 0,
    highestBid: 0,
    highestBidder: null,
    bidCount: 0,
    bids: [],
    landlord: null,
    lastPlay: null,
    lastActor: null,
    passCount: 0,
    multiplier: 1,
    winner: null,
    spring: null,
    playCounts: [0, 0, 0],
    playedCards: [],
  };
}

function finishBidding(state, landlord) {
  return {
    ...state,
    hands: state.hands.map((hand, player) => player === landlord
      ? [...hand, ...state.bottom].sort((a, b) => b.value - a.value)
      : hand),
    phase: 'playing',
    landlord,
    current: landlord,
    lastPlay: null,
  };
}

function applyBid(state, action) {
  reject(state.phase !== 'bidding', 'WRONG_PHASE', '当前不在叫分阶段');
  reject(state.current !== action.player, 'NOT_YOUR_TURN', '还没有轮到该玩家叫分');
  reject(!Number.isInteger(action.score) || action.score < 0 || action.score > 3, 'INVALID_BID', '叫分必须是 0 到 3 的整数');
  reject(action.score !== 0 && action.score <= state.highestBid, 'BID_TOO_LOW', '叫分必须高于当前最高分');

  const highestBid = action.score > state.highestBid ? action.score : state.highestBid;
  const highestBidder = action.score > state.highestBid ? action.player : state.highestBidder;
  const bidCount = state.bidCount + 1;
  let next = {
    ...state,
    highestBid,
    highestBidder,
    bidCount,
    bids: [...state.bids, { player: action.player, score: action.score }],
    current: nextPlayerCounterClockwise(action.player),
  };
  if (action.score === 3) next = finishBidding(next, action.player);
  else if (bidCount >= 3) next = highestBidder === null ? { ...next, phase: 'redeal' } : finishBidding(next, highestBidder);
  return next;
}

function cardsOwnedByPlayer(state, player, cardIds) {
  reject(!Array.isArray(cardIds) || !cardIds.length, 'EMPTY_PLAY', '出牌不能为空');
  reject(new Set(cardIds).size !== cardIds.length, 'DUPLICATE_CARD', '同一张牌不能重复提交');
  const byId = new Map(state.hands[player].map((card) => [card.id, card]));
  const cards = cardIds.map((id) => byId.get(id));
  reject(cards.some((card) => !card), 'CARD_NOT_OWNED', '提交了不属于该玩家的牌');
  return cards;
}

function applyPlay(state, action) {
  reject(state.phase !== 'playing', 'WRONG_PHASE', '当前不在出牌阶段');
  reject(state.current !== action.player, 'NOT_YOUR_TURN', '还没有轮到该玩家出牌');
  const cards = cardsOwnedByPlayer(state, action.player, action.cardIds);
  const combo = classifyPlay(cards);
  reject(!combo, 'INVALID_COMBO', '提交的牌不能组成合法牌型');
  reject(!canBeat(combo, state.lastPlay), 'CANNOT_BEAT', '提交的牌无法压过当前牌型');

  const hands = state.hands.map((hand, player) => player === action.player ? removeCards(hand, cards) : hand);
  const playCounts = state.playCounts.map((count, player) => player === action.player ? count + 1 : count);
  const winner = hands[action.player].length === 0 ? action.player : null;
  const spring = winner === null ? null : calculateSpring(playCounts, state.landlord, winner);
  let multiplier = ['bomb', 'rocket'].includes(combo.type) ? state.multiplier * 2 : state.multiplier;
  if (spring) multiplier *= 2;
  return {
    ...state,
    hands,
    playCounts,
    winner,
    spring,
    multiplier,
    phase: winner === null ? 'playing' : 'ended',
    current: winner === null ? nextPlayerCounterClockwise(action.player) : action.player,
    lastPlay: { ...combo, cards, player: action.player },
    lastActor: action.player,
    passCount: 0,
    playedCards: [...state.playedCards, ...cards],
  };
}

function applyPass(state, action) {
  reject(state.phase !== 'playing', 'WRONG_PHASE', '当前不在出牌阶段');
  reject(state.current !== action.player, 'NOT_YOUR_TURN', '还没有轮到该玩家操作');
  reject(!state.lastPlay, 'CANNOT_PASS', '拥有牌权时不能选择不出');
  const passCount = state.passCount + 1;
  if (passCount >= 2) {
    return { ...state, current: state.lastPlay.player, lastPlay: null, passCount: 0 };
  }
  return { ...state, current: nextPlayerCounterClockwise(action.player), passCount };
}

export function reduceAuthoritativeAction(state, action) {
  reject(!state || typeof state !== 'object', 'INVALID_STATE', '牌局状态无效');
  reject(!action || !['bid', 'play', 'pass'].includes(action.type), 'UNKNOWN_ACTION', '未知牌局动作');
  reject(!Number.isInteger(action.player) || action.player < 0 || action.player > 2, 'INVALID_PLAYER', '玩家座位无效');
  let next;
  if (action.type === 'bid') next = applyBid(state, action);
  else if (action.type === 'play') next = applyPlay(state, action);
  else next = applyPass(state, action);
  return { ...next, stateVersion: (state.stateVersion || 0) + 1 };
}

export function projectGameForPlayer(state, player) {
  reject(!Number.isInteger(player) || player < 0 || player > 2, 'INVALID_PLAYER', '玩家座位无效');
  const ended = state.phase === 'ended';
  const bottomRevealed = state.phase === 'playing' || ended;
  return {
    protocolVersion: state.protocolVersion,
    stateVersion: state.stateVersion,
    phase: state.phase,
    current: state.current,
    highestBid: state.highestBid,
    highestBidder: state.highestBidder,
    bids: state.bids,
    landlord: state.landlord,
    selfPlayer: player,
    selfHand: state.hands[player],
    handSizes: state.hands.map((hand) => hand.length),
    bottom: bottomRevealed ? state.bottom : [],
    bottomCount: state.bottom.length,
    lastPlay: state.lastPlay,
    lastActor: state.lastActor,
    passCount: state.passCount,
    multiplier: state.multiplier,
    winner: state.winner,
    spring: state.spring,
    playCounts: state.playCounts,
    playedCards: state.playedCards,
    commit: state.commit,
    ...(ended ? { seed: state.seed, deckOrder: state.deckOrder, revealedHands: state.hands } : {}),
  };
}
