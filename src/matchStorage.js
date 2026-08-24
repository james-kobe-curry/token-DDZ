const MATCH_SNAPSHOT_KEY = 'token-landlords:active-match:v1';
const MATCH_SNAPSHOT_VERSION = 1;
const MATCH_SNAPSHOT_TTL = 24 * 60 * 60 * 1000;
const RESTORABLE_PHASES = new Set(['bidding', 'playing']);

function isCard(card) {
  return Boolean(card && typeof card.id === 'string' && typeof card.rank === 'string' && Number.isFinite(card.value));
}

function isValidGame(game) {
  if (!game || !RESTORABLE_PHASES.has(game.phase) || !Array.isArray(game.hands) || game.hands.length !== 3) return false;
  if (!game.hands.every((hand) => Array.isArray(hand) && hand.every(isCard))) return false;
  if (!Array.isArray(game.bottom) || game.bottom.length !== 3 || !game.bottom.every(isCard)) return false;
  if (!Array.isArray(game.deckOrder) || game.deckOrder.length !== 54 || new Set(game.deckOrder).size !== 54) return false;
  if (!Number.isInteger(game.current) || game.current < 0 || game.current > 2) return false;
  if (typeof game.seed !== 'string' || typeof game.commit !== 'string') return false;

  const activeAndPlayed = [...game.hands.flat(), ...(Array.isArray(game.playedCards) ? game.playedCards : [])];
  const expectedCount = game.phase === 'playing' ? 54 : 51;
  return activeAndPlayed.length === expectedCount
    && activeAndPlayed.every(isCard)
    && new Set(activeAndPlayed.map((card) => card.id)).size === expectedCount;
}

export function readMatchSnapshot() {
  if (typeof window === 'undefined') return null;
  try {
    const snapshot = JSON.parse(window.localStorage.getItem(MATCH_SNAPSHOT_KEY) || 'null');
    const valid = snapshot?.version === MATCH_SNAPSHOT_VERSION
      && Number.isFinite(snapshot.savedAt)
      && Date.now() - snapshot.savedAt <= MATCH_SNAPSHOT_TTL
      && typeof snapshot.ranked === 'boolean'
      && isValidGame(snapshot.game);
    if (!valid) {
      window.localStorage.removeItem(MATCH_SNAPSHOT_KEY);
      return null;
    }
    return snapshot;
  } catch {
    window.localStorage.removeItem(MATCH_SNAPSHOT_KEY);
    return null;
  }
}

export function writeMatchSnapshot({ ranked, game, selected = [] }) {
  if (typeof window === 'undefined' || !isValidGame(game)) return false;
  try {
    window.localStorage.setItem(MATCH_SNAPSHOT_KEY, JSON.stringify({
      version: MATCH_SNAPSHOT_VERSION,
      savedAt: Date.now(),
      ranked: Boolean(ranked),
      game,
      selected: Array.isArray(selected) ? selected : [],
    }));
    return true;
  } catch {
    return false;
  }
}

export function clearMatchSnapshot() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(MATCH_SNAPSHOT_KEY);
  } catch {
    // Storage can be unavailable in privacy mode; there is nothing else to clear.
  }
}

export { MATCH_SNAPSHOT_KEY };
