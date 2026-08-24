import test from 'node:test';
import assert from 'node:assert/strict';
import { dealWithSeed } from '../src/gameLogic.js';
import { clearMatchSnapshot, MATCH_SNAPSHOT_KEY, readMatchSnapshot, writeMatchSnapshot } from '../src/matchStorage.js';
import { localDayKey, normalizeDailyProfile } from '../src/profileState.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test('每日状态跨本地日期后重置，但保留长期资产', () => {
  const profile = { tokens: 880, dailyDate: '2026-08-23', dailyGames: 3, dailyWins: 2, claimed: ['play1'] };
  const next = normalizeDailyProfile(profile, new Date(2026, 7, 24, 0, 0, 1));
  assert.deepEqual(next, { tokens: 880, dailyDate: '2026-08-24', dailyGames: 0, dailyWins: 0, claimed: [] });
  assert.equal(localDayKey(new Date(2026, 0, 2)), '2026-01-02');
});

test('同一天重复检查不会制造新的存档对象', () => {
  const profile = { dailyDate: '2026-08-24', dailyGames: 1, dailyWins: 0, claimed: [] };
  assert.equal(normalizeDailyProfile(profile, new Date(2026, 7, 24, 18)), profile);
});

test('未完成叫分牌局可以写入、校验并恢复', () => {
  const previousWindow = global.window;
  global.window = { localStorage: memoryStorage() };
  try {
    const dealt = dealWithSeed('snapshot-roundtrip');
    const game = {
      phase: 'bidding',
      hands: dealt.hands,
      bottom: dealt.bottom,
      deckOrder: dealt.deckOrder,
      playedCards: [],
      seed: 'snapshot-roundtrip',
      commit: 'test-commit',
      current: 2,
    };
    assert.equal(writeMatchSnapshot({ ranked: true, game, selected: [dealt.hands[0][0].id] }), true);
    const restored = readMatchSnapshot();
    assert.equal(restored.ranked, true);
    assert.equal(restored.game.current, 2);
    assert.deepEqual(restored.selected, [dealt.hands[0][0].id]);
    clearMatchSnapshot();
    assert.equal(readMatchSnapshot(), null);
  } finally {
    global.window = previousWindow;
  }
});

test('损坏或过期牌局不会被恢复', () => {
  const previousWindow = global.window;
  global.window = { localStorage: memoryStorage() };
  try {
    global.window.localStorage.setItem(MATCH_SNAPSHOT_KEY, JSON.stringify({ version: 1, savedAt: Date.now() - 25 * 60 * 60 * 1000, ranked: false, game: {} }));
    assert.equal(readMatchSnapshot(), null);
    assert.equal(global.window.localStorage.getItem(MATCH_SNAPSHOT_KEY), null);
  } finally {
    global.window = previousWindow;
  }
});
