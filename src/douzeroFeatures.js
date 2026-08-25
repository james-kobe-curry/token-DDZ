import { createDeck, enumeratePlayableOptions, nextPlayerCounterClockwise } from './gameLogic.js';

export const DOUZERO_ROLE_DIMS = Object.freeze({
  landlord: 373,
  landlord_up: 484,
  landlord_down: 484,
});

const EMPTY_PLAYERS = Object.freeze([Object.freeze([]), Object.freeze([]), Object.freeze([])]);

function concatFloat32(vectors) {
  const length = vectors.reduce((sum, vector) => sum + vector.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  vectors.forEach((vector) => {
    result.set(vector, offset);
    offset += vector.length;
  });
  return result;
}

// This is the exact 54-value representation used by the official DouZero
// environment: 13 rank columns x four count bits, followed by both jokers.
export function cardsToDouzeroArray(cards = []) {
  const encoded = new Float32Array(54);
  const counts = new Map();
  cards.forEach((card) => counts.set(card.value, (counts.get(card.value) || 0) + 1));
  counts.forEach((count, value) => {
    if (value === 16) encoded[52] = 1;
    else if (value === 17) encoded[53] = 1;
    else {
      const column = value === 15 ? 12 : value - 3;
      if (column < 0 || column > 12) return;
      for (let copy = 0; copy < Math.min(4, count); copy += 1) encoded[column * 4 + copy] = 1;
    }
  });
  return encoded;
}

function oneHotCardsLeft(amount, maximum) {
  const encoded = new Float32Array(maximum);
  if (Number.isInteger(amount) && amount > 0) encoded[Math.min(maximum, amount) - 1] = 1;
  return encoded;
}

function oneHotBombs(amount) {
  const encoded = new Float32Array(15);
  encoded[Math.max(0, Math.min(14, Number(amount) || 0))] = 1;
  return encoded;
}

export function getDouzeroRoles(landlord) {
  const landlordDown = nextPlayerCounterClockwise(landlord);
  return {
    landlord,
    landlord_down: landlordDown,
    landlord_up: nextPlayerCounterClockwise(landlordDown),
  };
}

export function getDouzeroRole(player, landlord) {
  const roles = getDouzeroRoles(landlord);
  return Object.entries(roles).find(([, seat]) => seat === player)?.[0] || 'landlord';
}

function remainingOtherCards(hand, playedCards) {
  const removed = new Map();
  [...hand, ...(playedCards || [])].forEach((card) => removed.set(card.value, (removed.get(card.value) || 0) + 1));
  return createDeck().filter((card) => {
    const count = removed.get(card.value) || 0;
    if (!count) return true;
    removed.set(card.value, count - 1);
    return false;
  });
}

function normalizePlayerCards(source) {
  return [0, 1, 2].map((player) => Array.isArray(source?.[player]) ? source[player] : EMPTY_PLAYERS[player]);
}

function historyToArray(actionHistory) {
  const latest = (actionHistory || []).slice(-15).map((entry) => cardsToDouzeroArray(Array.isArray(entry) ? entry : entry?.cards || []));
  const padded = Array.from({ length: 15 - latest.length }, () => new Float32Array(54));
  return concatFloat32([...padded, ...latest]);
}

export function buildDouzeroLegalActions(hand, previous) {
  const actions = enumeratePlayableOptions(hand, previous).map((cards) => ({ action: 'play', cards }));
  if (previous) actions.push({ action: 'pass', cards: [] });
  return actions;
}

// A learned policy may occasionally split the rocket for a marginal value
// gain. On an unrestricted lead that is needlessly brittle and contradicts
// the product's "super" contract, so keep the pair intact when alternatives
// exist. Following an opponent is left untouched because a single joker can
// be the only safe block against a reported last card.
export function protectRocketOnLead(hand, previous, actions) {
  if (previous || !hand.some((card) => card.value === 16) || !hand.some((card) => card.value === 17)) return actions;
  const protectedActions = actions.filter((action) => action.cards.filter((card) => card.value >= 16).length !== 1);
  return protectedActions.length ? protectedActions : actions;
}

export function buildDouzeroObservation(hand, previous, context = {}, suppliedActions = null) {
  const { currentPlayer, landlord } = context;
  if (!Number.isInteger(currentPlayer) || !Number.isInteger(landlord)) throw new Error('DouZero 缺少当前座位或地主座位');
  const actions = suppliedActions || buildDouzeroLegalActions(hand, previous);
  if (!actions.length) throw new Error('DouZero 没有合法动作可评估');

  const roles = getDouzeroRoles(landlord);
  const role = getDouzeroRole(currentPlayer, landlord);
  const playedByPlayer = normalizePlayerCards(context.playedByPlayer);
  const lastMoves = normalizePlayerCards(context.lastMoves);
  const handSizes = context.handSizes || [];
  const common = [
    cardsToDouzeroArray(hand),
    cardsToDouzeroArray(remainingOtherCards(hand, context.seenCards)),
  ];
  let stateFeatures;
  if (role === 'landlord') {
    stateFeatures = [
      ...common,
      cardsToDouzeroArray(previous?.cards || []),
      cardsToDouzeroArray(playedByPlayer[roles.landlord_up]),
      cardsToDouzeroArray(playedByPlayer[roles.landlord_down]),
      oneHotCardsLeft(handSizes[roles.landlord_up], 17),
      oneHotCardsLeft(handSizes[roles.landlord_down], 17),
      oneHotBombs(context.bombCount),
    ];
  } else {
    const teammateRole = role === 'landlord_up' ? 'landlord_down' : 'landlord_up';
    const teammate = roles[teammateRole];
    stateFeatures = [
      ...common,
      cardsToDouzeroArray(playedByPlayer[landlord]),
      cardsToDouzeroArray(playedByPlayer[teammate]),
      cardsToDouzeroArray(previous?.cards || []),
      cardsToDouzeroArray(lastMoves[landlord]),
      cardsToDouzeroArray(lastMoves[teammate]),
      oneHotCardsLeft(handSizes[landlord], 20),
      oneHotCardsLeft(handSizes[teammate], 17),
      oneHotBombs(context.bombCount),
    ];
  }

  const base = concatFloat32(stateFeatures);
  const featureSize = DOUZERO_ROLE_DIMS[role];
  if (base.length + 54 !== featureSize) throw new Error(`DouZero ${role} 特征维度错误`);
  const x = new Float32Array(actions.length * featureSize);
  actions.forEach((action, index) => {
    const offset = index * featureSize;
    x.set(base, offset);
    x.set(cardsToDouzeroArray(action.cards), offset + base.length);
  });

  const history = historyToArray(context.actionHistory);
  const z = new Float32Array(actions.length * history.length);
  actions.forEach((_, index) => z.set(history, index * history.length));
  return { actions, role, x, z, featureSize, historyShape: [5, 162] };
}
