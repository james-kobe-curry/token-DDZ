import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, nextPlayerCounterClockwise } from '../src/gameLogic.js';
import {
  buildDouzeroLegalActions,
  buildDouzeroObservation,
  cardsToDouzeroArray,
  getDouzeroRole,
  getDouzeroRoles,
  protectRocketOnLead,
} from '../src/douzeroFeatures.js';

const deck = createDeck();
const cards = (...values) => {
  const remaining = [...deck];
  return values.map((value) => {
    const index = remaining.findIndex((card) => card.value === value);
    assert.notEqual(index, -1);
    return remaining.splice(index, 1)[0];
  });
};

test('DouZero 牌向量保持官方 54 维计数编码', () => {
  const encoded = cardsToDouzeroArray(cards(3, 3, 15, 16, 17));
  assert.equal(encoded.length, 54);
  assert.deepEqual([...encoded.slice(0, 4)], [1, 1, 0, 0]);
  assert.deepEqual([...encoded.slice(48, 52)], [1, 0, 0, 0]);
  assert.deepEqual([...encoded.slice(52)], [1, 1]);
  assert.equal([...encoded].reduce((sum, value) => sum + value, 0), 5);
});

test('地主身份按本项目逆时针座位正确映射', () => {
  const roles = getDouzeroRoles(2);
  assert.equal(roles.landlord, 2);
  assert.equal(roles.landlord_down, nextPlayerCounterClockwise(2));
  assert.equal(getDouzeroRole(roles.landlord_up, 2), 'landlord_up');
  assert.equal(getDouzeroRole(roles.landlord_down, 2), 'landlord_down');
});

test('地主与农民特征严格匹配官方 ONNX 输入维度', () => {
  const hand = cards(3, 3, 4, 5, 6, 7, 16, 17);
  const common = {
    landlord: 0,
    handSizes: [20, 17, 17],
    seenCards: [],
    playedByPlayer: [[], [], []],
    lastMoves: [[], [], []],
    actionHistory: [],
    bombCount: 0,
  };
  const landlord = buildDouzeroObservation(hand, null, { ...common, currentPlayer: 0 });
  assert.equal(landlord.role, 'landlord');
  assert.equal(landlord.featureSize, 373);
  assert.equal(landlord.x.length, landlord.actions.length * 373);
  assert.equal(landlord.z.length, landlord.actions.length * 5 * 162);

  const farmer = buildDouzeroObservation(hand, null, { ...common, currentPlayer: 1 });
  assert.equal(farmer.featureSize, 484);
  assert.equal(farmer.x.length, farmer.actions.length * 484);
  assert.equal(farmer.z.length, farmer.actions.length * 5 * 162);
});

test('动作历史左侧补零并保留最近十五手', () => {
  const hand = cards(9, 10, 11, 12, 13);
  const history = Array.from({ length: 17 }, (_, index) => ({ player: index % 3, cards: cards(3 + (index % 10)) }));
  const observation = buildDouzeroObservation(hand, null, {
    currentPlayer: 0, landlord: 0, handSizes: [5, 17, 17], seenCards: [],
    playedByPlayer: [[], [], []], lastMoves: [[], [], []], actionHistory: history, bombCount: 0,
  }, [{ action: 'play', cards: hand.slice(0, 1) }]);
  assert.equal(observation.z.length, 810);
  assert.deepEqual([...observation.z.slice(0, 54)], [...cardsToDouzeroArray(history[2].cards)]);
});

test('超强人机拥有牌权时不会把双王拆成单王', () => {
  const hand = cards(3, 4, 8, 12, 16, 17);
  const actions = protectRocketOnLead(hand, null, buildDouzeroLegalActions(hand, null));
  assert.ok(actions.some((action) => action.cards.length === 2 && action.cards.every((card) => card.value >= 16)));
  assert.equal(actions.some((action) => action.cards.length === 1 && action.cards[0].value >= 16), false);
});

test('神经网络观察只使用公开信息，不读取额外对手暗牌', () => {
  const hand = cards(3, 4, 5, 6, 7, 8);
  const actions = buildDouzeroLegalActions(hand, null);
  const context = {
    currentPlayer: 1, landlord: 0, handSizes: [20, 6, 17], seenCards: [],
    playedByPlayer: [[], [], []], lastMoves: [[], [], []], actionHistory: [], bombCount: 0,
  };
  const clean = buildDouzeroObservation(hand, null, context, actions);
  const poisoned = buildDouzeroObservation(hand, null, { ...context, opponentHands: [cards(17), cards(16)] }, actions);
  assert.deepEqual([...clean.x], [...poisoned.x]);
  assert.deepEqual([...clean.z], [...poisoned.z]);
});
