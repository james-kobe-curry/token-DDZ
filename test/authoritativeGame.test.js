import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthoritativeGame,
  GameActionError,
  projectGameForPlayer,
  reduceAuthoritativeAction,
} from '../src/authoritativeGame.js';
import { classifyPlay, enumeratePlayableOptions } from '../src/gameLogic.js';

function bidToPlaying(seed = 'authoritative-test') {
  let state = createAuthoritativeGame({ seed, commit: 'locked' });
  state = reduceAuthoritativeAction(state, { type: 'bid', player: 0, score: 1 });
  state = reduceAuthoritativeAction(state, { type: 'bid', player: 2, score: 0 });
  state = reduceAuthoritativeAction(state, { type: 'bid', player: 1, score: 0 });
  return state;
}

test('权威动作引擎按逆时针完成叫分并给地主加入底牌', () => {
  const state = bidToPlaying();
  assert.equal(state.phase, 'playing');
  assert.equal(state.landlord, 0);
  assert.equal(state.current, 0);
  assert.equal(state.hands[0].length, 20);
  assert.equal(state.stateVersion, 3);
});

test('叫分分值成为牌局初始倍数', () => {
  let state = createAuthoritativeGame({ seed: 'bid-multiplier' });
  state = reduceAuthoritativeAction(state, { type: 'bid', player: 0, score: 3 });
  assert.equal(state.phase, 'playing');
  assert.equal(state.highestBid, 3);
  assert.equal(state.multiplier, 3);
});

test('权威动作引擎拒绝越权、重复牌和无法压制的动作', () => {
  const state = bidToPlaying('reject-invalid');
  assert.throws(() => reduceAuthoritativeAction(state, { type: 'play', player: 2, cardIds: [state.hands[2][0].id] }), (error) => error instanceof GameActionError && error.code === 'NOT_YOUR_TURN');
  assert.throws(() => reduceAuthoritativeAction(state, { type: 'play', player: 0, cardIds: [state.hands[0][0].id, state.hands[0][0].id] }), (error) => error.code === 'DUPLICATE_CARD');
});

test('两家不出后牌权回到上一手玩家', () => {
  let state = bidToPlaying('pass-cycle');
  const lead = enumeratePlayableOptions(state.hands[0]).find((cards) => classifyPlay(cards).type === 'single');
  state = reduceAuthoritativeAction(state, { type: 'play', player: 0, cardIds: lead.map((card) => card.id) });
  assert.equal(state.current, 2);
  state = reduceAuthoritativeAction(state, { type: 'pass', player: 2 });
  state = reduceAuthoritativeAction(state, { type: 'pass', player: 1 });
  assert.equal(state.current, 0);
  assert.equal(state.lastPlay, null);
});

test('玩家投影不会泄露其他两家的暗牌和洗牌种子', () => {
  const state = createAuthoritativeGame({ seed: 'hidden-information', commit: 'locked' });
  const view = projectGameForPlayer(state, 1);
  assert.equal(view.selfHand.length, 17);
  assert.deepEqual(view.handSizes, [17, 17, 17]);
  assert.deepEqual(view.bottom, []);
  assert.equal('hands' in view, false);
  assert.equal('seed' in view, false);
  assert.equal('deckOrder' in view, false);
});
