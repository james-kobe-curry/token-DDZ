export const SUITS = [
  { key: 'spade', symbol: '♠', color: 'black' },
  { key: 'heart', symbol: '♥', color: 'red' },
  { key: 'club', symbol: '♣', color: 'black' },
  { key: 'diamond', symbol: '♦', color: 'red' },
];

export const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
export const GAME_RULES = Object.freeze({
  straightMinimum: 5,
  pairStraightMinimum: 3,
  airplaneMinimum: 2,
  fourWithTwoSinglesMayUsePair: true,
  airplaneWingsMayReuseCoreRank: false,
});
export const AI_DIFFICULTIES = Object.freeze({
  super: Object.freeze({ id: 'super', name: '超强人机', shortName: '超强', memoryRatio: 1, planningHandLimit: 12, nodeLimit: 26000, samples: 72, teamwork: 1, structureWeight: 4.2, planningWeight: 28, controlWeight: 10, sampleWeight: 54, bombPenalty: 190, accuracy: 1, choiceWindow: 1, description: '完整记牌、未知手牌采样与深度牌路搜索，重视牌权、配合和终局控制。' }),
  master: Object.freeze({ id: 'master', name: '大师', shortName: '大师', memoryRatio: .92, planningHandLimit: 10, nodeLimit: 15000, samples: 36, teamwork: .98, structureWeight: 4, planningWeight: 23, controlWeight: 10, sampleWeight: 60, bombPenalty: 175, accuracy: .96, choiceWindow: 2, description: '高精度记牌和概率推演，稳定配合队友并谨慎使用炸弹。' }),
  elite: Object.freeze({ id: 'elite', name: '精英', shortName: '精英', memoryRatio: .72, planningHandLimit: 8, nodeLimit: 8000, samples: 14, teamwork: .86, structureWeight: 3.2, planningWeight: 17, controlWeight: 7, sampleWeight: 42, bombPenalty: 155, accuracy: .82, choiceWindow: 4, description: '具备可靠的结构判断、局势意识和部分未知牌推演。' }),
  normal: Object.freeze({ id: 'normal', name: '普通', shortName: '普通', memoryRatio: .42, planningHandLimit: 6, nodeLimit: 3500, samples: 4, teamwork: .62, structureWeight: 2, planningWeight: 10, controlWeight: 4, sampleWeight: 24, bombPenalty: 125, accuracy: .55, choiceWindow: 8, description: '懂基本牌型与简单配合，偶尔拆牌或错过更优牌路。' }),
  rookie: Object.freeze({ id: 'rookie', name: '菜鸟', shortName: '菜鸟', memoryRatio: 0, planningHandLimit: 0, nodeLimit: 0, samples: 0, teamwork: .22, structureWeight: .65, planningWeight: 0, controlWeight: 0, sampleWeight: 0, bombPenalty: 70, accuracy: .2, choiceWindow: 14, description: '主要依据当前牌型行动，较少记牌、计算和主动配合。' }),
});
export const rankValue = (rank) => {
  const index = RANKS.indexOf(rank);
  return index >= 0 ? index + 3 : rank === 'SJ' ? 16 : 17;
};

// Seats are rendered as player 0 at the bottom, player 1 on the left and
// player 2 on the right. Counter-clockwise play therefore advances
// bottom -> right -> left -> bottom.
export const nextPlayerCounterClockwise = (player) => (player + 2) % 3;

export function createDeck() {
  const cards = [];
  for (const rank of RANKS) {
    for (const suit of SUITS) cards.push({ id: `${suit.key}-${rank}`, rank, value: rankValue(rank), ...suit });
  }
  cards.push({ id: 'joker-small', rank: 'SJ', label: '小王', value: 16, symbol: 'JOKER', color: 'black', key: 'joker' });
  cards.push({ id: 'joker-big', rank: 'BJ', label: '大王', value: 17, symbol: 'JOKER', color: 'red', key: 'joker' });
  return cards;
}

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a) {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSeed() {
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((n) => n.toString(16).padStart(8, '0')).join('');
}

export async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function dealWithSeed(seed) {
  const deck = createDeck();
  const seedFn = xmur3(seed);
  const random = mulberry32(seedFn());
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const sort = (hand) => [...hand].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  return {
    hands: [sort(deck.slice(0, 17)), sort(deck.slice(17, 34)), sort(deck.slice(34, 51))],
    bottom: sort(deck.slice(51)),
    deckOrder: deck.map((card) => card.id),
  };
}

function countsOf(cards) {
  const map = new Map();
  cards.forEach((card) => {
    const group = map.get(card.value) || [];
    group.push(card);
    map.set(card.value, group);
  });
  return map;
}

function isSequence(values) {
  if (!values.length || values.at(-1) >= 15) return false;
  return values.every((value, index) => index === 0 || value === values[index - 1] + 1);
}

function consecutiveRuns(values, length) {
  const set = new Set(values.filter((value) => value < 15));
  const starts = [...set].sort((a, b) => a - b);
  return starts.filter((start) => Array.from({ length }, (_, i) => start + i).every((value) => set.has(value)));
}

export function classifyPlay(cards) {
  if (!cards?.length) return null;
  const sorted = [...cards].sort((a, b) => a.value - b.value);
  const n = sorted.length;
  const counts = countsOf(sorted);
  const groups = [...counts.entries()].map(([value, list]) => ({ value, count: list.length })).sort((a, b) => a.value - b.value);
  const byCount = (count) => groups.filter((group) => group.count === count);

  if (n === 2 && sorted[0].value === 16 && sorted[1].value === 17) return { type: 'rocket', rank: 17, length: 2 };
  if (n === 4 && groups.length === 1) return { type: 'bomb', rank: groups[0].value, length: 4 };
  if (n === 1) return { type: 'single', rank: sorted[0].value, length: 1 };
  if (n === 2 && groups.length === 1) return { type: 'pair', rank: groups[0].value, length: 2 };
  if (n === 3 && groups.length === 1) return { type: 'triple', rank: groups[0].value, length: 3 };
  if (n === 4 && byCount(3).length === 1) return { type: 'triple_single', rank: byCount(3)[0].value, length: 4 };
  if (n === 5 && byCount(3).length === 1 && byCount(2).length === 1) return { type: 'triple_pair', rank: byCount(3)[0].value, length: 5 };

  const values = groups.map((group) => group.value);
  if (n >= 5 && groups.every((group) => group.count === 1) && isSequence(values)) return { type: 'straight', rank: values[0], length: n };
  if (n >= 6 && n % 2 === 0 && groups.every((group) => group.count === 2) && isSequence(values)) return { type: 'pair_straight', rank: values[0], length: n };
  if (n >= 6 && n % 3 === 0 && groups.every((group) => group.count === 3) && isSequence(values)) return { type: 'airplane', rank: values[0], length: n };

  if (n >= 8 && n % 4 === 0) {
    const runLength = n / 4;
    const starts = consecutiveRuns(groups.filter((g) => g.count === 3).map((g) => g.value), runLength);
    for (const start of starts) {
      const core = new Set(Array.from({ length: runLength }, (_, i) => start + i));
      const wings = groups.filter((group) => !core.has(group.value));
      if (wings.reduce((total, group) => total + group.count, 0) === runLength) return { type: 'airplane_single', rank: start, length: n };
    }
  }

  if (n >= 10 && n % 5 === 0) {
    const runLength = n / 5;
    const starts = consecutiveRuns(groups.filter((g) => g.count === 3).map((g) => g.value), runLength);
    for (const start of starts) {
      const core = new Set(Array.from({ length: runLength }, (_, i) => start + i));
      const wings = groups.filter((group) => !core.has(group.value));
      if (wings.length === runLength && wings.every((group) => group.count === 2)) return { type: 'airplane_pair', rank: start, length: n };
    }
  }

  if (n === 6 && byCount(4).length === 1 && (GAME_RULES.fourWithTwoSinglesMayUsePair || byCount(2).length === 0)) return { type: 'four_two_single', rank: byCount(4)[0].value, length: 6 };
  if (n === 8 && byCount(4).length === 1 && byCount(2).length === 2) return { type: 'four_two_pair', rank: byCount(4)[0].value, length: 8 };
  return null;
}

export function canBeat(play, previous) {
  if (!play) return false;
  if (!previous) return true;
  if (play.type === 'rocket') return previous.type !== 'rocket';
  if (previous.type === 'rocket') return false;
  if (play.type === 'bomb' && previous.type !== 'bomb') return true;
  if (play.type !== previous.type || play.length !== previous.length) return false;
  return play.rank > previous.rank;
}

function cardsByValue(hand) {
  return countsOf([...hand].sort((a, b) => a.value - b.value));
}

function selectFrom(map, value, amount) {
  return (map.get(value) || []).slice(0, amount);
}

function combinations(items, amount, start = 0, picked = [], output = []) {
  if (picked.length === amount) {
    output.push([...picked]);
    return output;
  }
  for (let index = start; index <= items.length - (amount - picked.length); index += 1) {
    picked.push(items[index]);
    combinations(items, amount, index + 1, picked, output);
    picked.pop();
  }
  return output;
}

function singleWingOptions(hand, amount, excluded) {
  const candidates = hand.filter((card) => !excluded.has(card.value)).sort((a, b) => a.value - b.value);
  const seen = new Set();
  return combinations(candidates, amount).filter((cards) => {
    const signature = optionSignature(cards);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function pairWingOptions(hand, amount, excluded) {
  const map = cardsByValue(hand.filter((card) => !excluded.has(card.value)));
  const values = [...map.keys()].filter((value) => map.get(value).length >= 2).sort((a, b) => a - b);
  return combinations(values, amount).map((picked) => picked.flatMap((value) => selectFrom(map, value, 2)));
}

function wingOptions(hand, amount, excluded, mode) {
  return mode === 'pair' ? pairWingOptions(hand, amount, excluded) : singleWingOptions(hand, amount, excluded);
}

const optionTypeOrder = {
  single: 0, pair: 1, triple: 2, triple_single: 3, triple_pair: 4, straight: 5,
  pair_straight: 6, airplane: 7, airplane_single: 8, airplane_pair: 9,
  four_two_single: 10, four_two_pair: 11, bomb: 90, rocket: 100,
};

function preservationCost(hand, option) {
  const handCounts = countsOf(hand);
  const optionCounts = countsOf(option);
  let cost = 0;
  for (const [value, cards] of optionCounts.entries()) {
    const total = handCounts.get(value)?.length || 0;
    if (total === 4 && cards.length < 4) cost += 90;
    else if (total === 3 && cards.length < 3) cost += 24;
    else if (total === 2 && cards.length < 2) cost += 7;
    if ((value === 16 || value === 17) && handCounts.has(16) && handCounts.has(17) && option.length !== 2) cost += 80;
  }
  return cost;
}

function optionSignature(cards) {
  const groups = [...countsOf(cards).entries()].sort((a, b) => a[0] - b[0]);
  return groups.map(([value, list]) => `${value}x${list.length}`).join('-');
}

export function enumeratePlayableOptions(hand, previous = null) {
  const map = cardsByValue(hand);
  const values = [...map.keys()].sort((a, b) => a - b);
  const options = [];
  const seen = new Set();
  const add = (cards) => {
    if (!cards?.length) return;
    const combo = classifyPlay(cards);
    if (!combo || !canBeat(combo, previous)) return;
    const key = `${combo.type}:${optionSignature(cards)}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push(cards);
  };
  const valuesWith = (count) => values.filter((value) => map.get(value).length >= count);
  const addTripleWings = (triple, mode) => {
    wingOptions(hand, 1, new Set([triple]), mode).forEach((wing) => add([...selectFrom(map, triple, 3), ...wing]));
  };
  const addAirplanes = (runLength, wingMode = null) => {
    for (const start of consecutiveRuns(valuesWith(3), runLength)) {
      const coreValues = Array.from({ length: runLength }, (_, index) => start + index);
      const core = coreValues.flatMap((value) => selectFrom(map, value, 3));
      if (!wingMode) add(core);
      else {
        wingOptions(hand, runLength, new Set(coreValues), wingMode).forEach((wings) => add([...core, ...wings]));
      }
    }
  };

  if (!previous) {
    values.forEach((value) => add(selectFrom(map, value, 1)));
    valuesWith(2).forEach((value) => add(selectFrom(map, value, 2)));
    valuesWith(3).forEach((value) => {
      add(selectFrom(map, value, 3));
      addTripleWings(value, 'single');
      addTripleWings(value, 'pair');
    });
    const sequenceValues = valuesWith(1).filter((value) => value < 15);
    for (let length = 5; length <= sequenceValues.length; length += 1) {
      consecutiveRuns(sequenceValues, length).forEach((start) => add(Array.from({ length }, (_, index) => selectFrom(map, start + index, 1)).flat()));
    }
    const pairValues = valuesWith(2).filter((value) => value < 15);
    for (let length = 3; length <= pairValues.length; length += 1) {
      consecutiveRuns(pairValues, length).forEach((start) => add(Array.from({ length }, (_, index) => selectFrom(map, start + index, 2)).flat()));
    }
    for (let length = 2; length <= Math.min(4, valuesWith(3).length); length += 1) {
      addAirplanes(length);
      addAirplanes(length, 'single');
      addAirplanes(length, 'pair');
    }
    valuesWith(4).forEach((value) => {
      wingOptions(hand, 2, new Set([value]), 'single').forEach((wings) => add([...selectFrom(map, value, 4), ...wings]));
      wingOptions(hand, 2, new Set([value]), 'pair').forEach((wings) => add([...selectFrom(map, value, 4), ...wings]));
    });
  } else {
    const higher = (count) => valuesWith(count).filter((value) => value > previous.rank);
    if (previous.type === 'single') higher(1).forEach((value) => add(selectFrom(map, value, 1)));
    if (previous.type === 'pair') higher(2).forEach((value) => add(selectFrom(map, value, 2)));
    if (previous.type === 'triple') higher(3).forEach((value) => add(selectFrom(map, value, 3)));
    if (previous.type === 'triple_single' || previous.type === 'triple_pair') {
      higher(3).forEach((value) => addTripleWings(value, previous.type === 'triple_pair' ? 'pair' : 'single'));
    }
    if (previous.type === 'straight' || previous.type === 'pair_straight') {
      const repeat = previous.type === 'straight' ? 1 : 2;
      const length = previous.length / repeat;
      consecutiveRuns(valuesWith(repeat), length).filter((start) => start > previous.rank).forEach((start) => add(Array.from({ length }, (_, index) => selectFrom(map, start + index, repeat)).flat()));
    }
    if (previous.type.startsWith('airplane')) {
      const unit = previous.type === 'airplane' ? 3 : previous.type === 'airplane_pair' ? 5 : 4;
      const length = previous.length / unit;
      for (const start of consecutiveRuns(valuesWith(3), length).filter((value) => value > previous.rank)) {
        const coreValues = Array.from({ length }, (_, index) => start + index);
        const core = coreValues.flatMap((value) => selectFrom(map, value, 3));
        if (previous.type === 'airplane') add(core);
        else {
          const mode = previous.type === 'airplane_pair' ? 'pair' : 'single';
          wingOptions(hand, length, new Set(coreValues), mode).forEach((wings) => add([...core, ...wings]));
        }
      }
    }
    if (previous.type === 'four_two_single' || previous.type === 'four_two_pair') {
      higher(4).forEach((value) => {
        const mode = previous.type === 'four_two_pair' ? 'pair' : 'single';
        wingOptions(hand, 2, new Set([value]), mode).forEach((wings) => add([...selectFrom(map, value, 4), ...wings]));
      });
    }
  }

  valuesWith(4).forEach((value) => add(selectFrom(map, value, 4)));
  if (map.has(16) && map.has(17)) add([map.get(16)[0], map.get(17)[0]]);
  return options.sort((cardsA, cardsB) => {
    const a = classifyPlay(cardsA);
    const b = classifyPlay(cardsB);
    const aSpecial = a.type === 'bomb' || a.type === 'rocket' ? 1 : 0;
    const bSpecial = b.type === 'bomb' || b.type === 'rocket' ? 1 : 0;
    return aSpecial - bSpecial || preservationCost(hand, cardsA) - preservationCost(hand, cardsB) || a.rank - b.rank || a.length - b.length || optionTypeOrder[a.type] - optionTypeOrder[b.type];
  });
}

function sameCardSet(cardsA, cardsB) {
  if (!cardsA || !cardsB || cardsA.length !== cardsB.length) return false;
  const ids = new Set(cardsA.map((card) => card.id));
  return cardsB.every((card) => ids.has(card.id));
}

function strategicPlayScore(hand, cards, previous) {
  const combo = classifyPlay(cards);
  if (!combo) return Number.POSITIVE_INFINITY;
  const special = combo.type === 'bomb' || combo.type === 'rocket';
  const chain = ['straight', 'pair_straight', 'airplane', 'airplane_single', 'airplane_pair'].includes(combo.type);
  return preservationCost(hand, cards) * 3
    + combo.rank
    + (special ? 145 : 0)
    - cards.length * (previous ? .45 : 5.5)
    - (chain && !previous ? 14 : 0)
    - (cards.length === hand.length ? 220 : 0);
}

function resolveDifficulty(difficulty = 'master') {
  if (typeof difficulty === 'object' && difficulty?.id && AI_DIFFICULTIES[difficulty.id]) return AI_DIFFICULTIES[difficulty.id];
  return AI_DIFFICULTIES[difficulty] || AI_DIFFICULTIES.master;
}

function deterministicDecisionRoll(hand, context = {}) {
  const source = `${context.turnSerial || 0}:${context.currentPlayer ?? '-'}:${hand.map((card) => card.id).sort().join('|')}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function rememberedPublicCards(seenCards, publicCards, profile) {
  const publicById = new Map((publicCards || []).map((card) => [card.id, card]));
  const rememberedCount = Math.ceil((seenCards?.length || 0) * profile.memoryRatio);
  if (rememberedCount > 0) (seenCards || []).slice(-rememberedCount).forEach((card) => publicById.set(card.id, card));
  return [...publicById.values()];
}

function buildCardMemory(hand, seenCards, publicCards, profile) {
  const knownById = new Map();
  [...hand, ...rememberedPublicCards(seenCards, publicCards, profile)].forEach((card) => knownById.set(card.id, card));
  const known = countsOf([...knownById.values()]);
  const unseen = new Map();
  for (let value = 3; value <= 17; value += 1) {
    const deckCount = value >= 16 ? 1 : 4;
    unseen.set(value, Math.max(0, deckCount - (known.get(value)?.length || 0)));
  }
  return unseen;
}

function numericCounts(cards) {
  const counts = new Map();
  cards.forEach((card) => counts.set(card.value, (counts.get(card.value) || 0) + 1));
  return counts;
}

function firstHigherWith(counts, rank, amount, maximum = 17) {
  for (let value = rank + 1; value <= maximum; value += 1) if ((counts.get(value) || 0) >= amount) return value;
  return null;
}

function firstRunWith(counts, startAfter, length, repeat) {
  for (let start = startAfter + 1; start + length - 1 < 15; start += 1) {
    if (Array.from({ length }, (_, index) => start + index).every((value) => (counts.get(value) || 0) >= repeat)) return start;
  }
  return null;
}

function wingCapacity(counts, excludedValues, mode) {
  if (mode === 'pair') return [...counts.entries()].filter(([value, count]) => !excludedValues.has(value) && count >= 2).length;
  return [...counts.entries()].reduce((total, [value, count]) => total + (excludedValues.has(value) ? 0 : count), 0);
}

function fastBeatingCombo(counts, target) {
  if (!target || target.type === 'rocket') return null;
  let response = null;
  if (target.type === 'single') {
    const rank = firstHigherWith(counts, target.rank, 1);
    if (rank !== null) response = { type: 'single', rank, length: 1 };
  } else if (target.type === 'pair' || target.type === 'triple') {
    const amount = target.type === 'pair' ? 2 : 3;
    const rank = firstHigherWith(counts, target.rank, amount, 15);
    if (rank !== null) response = { type: target.type, rank, length: target.length };
  } else if (target.type === 'triple_single' || target.type === 'triple_pair') {
    for (let rank = target.rank + 1; rank <= 15; rank += 1) {
      if ((counts.get(rank) || 0) < 3) continue;
      const mode = target.type === 'triple_pair' ? 'pair' : 'single';
      if (wingCapacity(counts, new Set([rank]), mode) >= (mode === 'pair' ? 1 : 1)) { response = { type: target.type, rank, length: target.length }; break; }
    }
  } else if (target.type === 'straight' || target.type === 'pair_straight' || target.type === 'airplane') {
    const repeat = target.type === 'straight' ? 1 : target.type === 'pair_straight' ? 2 : 3;
    const rank = firstRunWith(counts, target.rank, target.length / repeat, repeat);
    if (rank !== null) response = { type: target.type, rank, length: target.length };
  } else if (target.type === 'airplane_single' || target.type === 'airplane_pair') {
    const mode = target.type === 'airplane_pair' ? 'pair' : 'single';
    const unit = mode === 'pair' ? 5 : 4;
    const runLength = target.length / unit;
    for (let start = target.rank + 1; start + runLength - 1 < 15; start += 1) {
      const core = new Set(Array.from({ length: runLength }, (_, index) => start + index));
      if ([...core].every((value) => (counts.get(value) || 0) >= 3) && wingCapacity(counts, core, mode) >= (mode === 'pair' ? runLength : runLength)) { response = { type: target.type, rank: start, length: target.length }; break; }
    }
  } else if (target.type === 'four_two_single' || target.type === 'four_two_pair') {
    const mode = target.type === 'four_two_pair' ? 'pair' : 'single';
    for (let rank = target.rank + 1; rank <= 15; rank += 1) {
      if ((counts.get(rank) || 0) >= 4 && wingCapacity(counts, new Set([rank]), mode) >= 2) { response = { type: target.type, rank, length: target.length }; break; }
    }
  } else if (target.type === 'bomb') {
    const rank = firstHigherWith(counts, target.rank, 4, 15);
    if (rank !== null) response = { type: 'bomb', rank, length: 4 };
  }
  if (response) return response;
  if (target.type !== 'bomb') {
    const bombRank = firstHigherWith(counts, 2, 4, 15);
    if (bombRank !== null) return { type: 'bomb', rank: bombRank, length: 4 };
  }
  if ((counts.get(16) || 0) && (counts.get(17) || 0)) return { type: 'rocket', rank: 17, length: 2 };
  return null;
}

function samplePossibleHands(hand, context, profile) {
  if (!profile.samples || context.currentPlayer === null || context.currentPlayer === undefined || context.landlord === null || context.landlord === undefined) return [];
  const remembered = rememberedPublicCards(context.seenCards || [], context.publicCards || [], profile);
  const knownIds = new Set([...hand, ...remembered].map((card) => card.id));
  const fullySeenIds = new Set((context.seenCards || []).map((card) => card.id));
  const fixedByPlayer = [[], [], []];
  if (context.landlord !== context.currentPlayer) fixedByPlayer[context.landlord] = (context.publicCards || []).filter((card) => !fullySeenIds.has(card.id));
  const unknown = createDeck().filter((card) => !knownIds.has(card.id));
  const source = `${context.turnSerial || 0}:${context.currentPlayer}:${context.landlord}:${hand.map((card) => card.id).sort().join('|')}:${remembered.map((card) => card.id).sort().join('|')}`;
  const samples = [];
  for (let sampleIndex = 0; sampleIndex < profile.samples; sampleIndex += 1) {
    const random = mulberry32(xmur3(`${source}:${sampleIndex}`)());
    const shuffled = [...unknown];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const target = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
    }
    let cursor = 0;
    const playerCounts = [null, null, null];
    for (let player = 0; player < 3; player += 1) {
      if (player === context.currentPlayer) { playerCounts[player] = numericCounts(hand); continue; }
      const fixed = fixedByPlayer[player];
      const needed = Math.max(0, (context.handSizes?.[player] ?? 0) - fixed.length);
      playerCounts[player] = numericCounts([...fixed, ...shuffled.slice(cursor, cursor + needed)]);
      cursor += needed;
    }
    samples.push(playerCounts);
  }
  return samples;
}

function sampledControlMetrics(candidate, hand, samples, context) {
  if (!samples.length) return { responseRate: 0, recaptureRate: 0 };
  const opponents = [0, 1, 2].filter((player) => player !== context.currentPlayer && !sameTeam(context.currentPlayer, player, context.landlord));
  const remainingCounts = numericCounts(removeCards(hand, candidate.cards));
  let responses = 0;
  let recaptures = 0;
  samples.forEach((sample) => {
    let response = null;
    for (const player of opponents) {
      response = fastBeatingCombo(sample[player], candidate.combo);
      if (response) break;
    }
    if (!response) return;
    responses += 1;
    if (fastBeatingCombo(remainingCounts, response)) recaptures += 1;
  });
  return { responseRate: responses / samples.length, recaptureRate: responses ? recaptures / responses : 0 };
}

function potentialHigherResponses(combo, unseen) {
  if (!combo || combo.type === 'rocket') return 0;
  let responses = 0;
  const required = combo.type === 'single' ? 1 : combo.type === 'pair' ? 2 : combo.type === 'triple' ? 3 : combo.type === 'bomb' ? 4 : 0;
  if (required) {
    for (let value = combo.rank + 1; value <= 17; value += 1) {
      if ((unseen.get(value) || 0) >= required) responses += 1;
    }
  } else if (['straight', 'pair_straight', 'airplane'].includes(combo.type)) {
    const repeat = combo.type === 'straight' ? 1 : combo.type === 'pair_straight' ? 2 : 3;
    const runLength = combo.length / repeat;
    for (let start = combo.rank + 1; start + runLength - 1 < 15; start += 1) {
      if (Array.from({ length: runLength }, (_, index) => start + index).every((value) => (unseen.get(value) || 0) >= repeat)) responses += 1;
    }
  } else {
    for (let value = combo.rank + 1; value <= 15; value += 1) if ((unseen.get(value) || 0) >= 3) responses += 1;
  }
  if (combo.type !== 'bomb') {
    for (let value = 3; value <= 15; value += 1) if ((unseen.get(value) || 0) === 4) responses += 1.5;
  }
  if ((unseen.get(16) || 0) && (unseen.get(17) || 0)) responses += 2;
  return responses;
}

function strategicReason({ cards, combo, remaining, turns, breakCost, opponentThreat, responseRisk, responseRate, recaptureRate }) {
  if (!remaining.length) return '可以直接走完本局';
  if (responseRate !== undefined && responseRate <= .12) return '公开牌推演中对手很难接住，牌权稳定';
  if (opponentThreat && responseRisk <= 1) return '对手接近收官，这手更利于封堵牌权';
  if (responseRate !== undefined && responseRate >= .68 && recaptureRate < .25) return '对手接牌概率偏高，后续夺回牌权较困难';
  if (turns !== null && turns <= 2) return `牌路紧凑，预计剩余 ${turns} 手走完`;
  if (breakCost === 0 && ['straight', 'pair_straight', 'airplane', 'airplane_single', 'airplane_pair'].includes(combo.type)) return `整组消化 ${cards.length} 张，同时保留核心结构`;
  if (breakCost === 0) return '不拆对子、三张或炸弹，后续衔接更完整';
  if (breakCost >= 80) return '会拆散炸弹，仅适合关键封堵';
  if (breakCost >= 20) return '会拆三张，后续带牌空间有所下降';
  if (breakCost >= 7) return '会拆对子，优先级低于独立单张';
  return '牌力消耗与后续牌路较为均衡';
}

function splitsProtectedRocket(hand, cards) {
  const handValues = new Set(hand.map((card) => card.value));
  if (!handValues.has(16) || !handValues.has(17)) return false;
  const playedJokers = cards.filter((card) => card.value === 16 || card.value === 17);
  return playedJokers.length === 1;
}

function chainBreakCost(hand, cards) {
  const combo = classifyPlay(cards);
  if (combo && ['straight', 'pair_straight', 'airplane', 'airplane_single', 'airplane_pair'].includes(combo.type)) return 0;
  const handCounts = countsOf(hand);
  const playedCounts = countsOf(cards);
  const valuesWith = (amount) => [...handCounts.keys()].filter((value) => value < 15 && (handCounts.get(value)?.length || 0) >= amount);
  const protectedValues = (repeat, minimum) => {
    const values = new Set();
    consecutiveRuns(valuesWith(repeat), minimum).forEach((start) => Array.from({ length: minimum }, (_, index) => start + index).forEach((value) => values.add(value)));
    return values;
  };
  const structures = [
    { repeat: 1, minimum: 5, cost: 10 },
    { repeat: 2, minimum: 3, cost: 16 },
    { repeat: 3, minimum: 2, cost: 22 },
  ];
  return structures.reduce((total, structure) => {
    const protectedSet = protectedValues(structure.repeat, structure.minimum);
    const broken = [...playedCounts.entries()].some(([value, played]) => protectedSet.has(value) && (handCounts.get(value).length - played.length) < structure.repeat);
    return total + (broken ? structure.cost : 0);
  }, 0);
}

function structuralDamageCost(hand, cards) {
  return preservationCost(hand, cards) + chainBreakCost(hand, cards);
}

export function rankStrategicOptions(hand, previous = null, context = {}, difficulty = 'master') {
  const profile = resolveDifficulty(difficulty);
  const legalOptions = enumeratePlayableOptions(hand, previous);
  const protectsRocket = profile.id === 'super' || profile.id === 'master';
  const protectedOptions = protectsRocket ? legalOptions.filter((cards) => !splitsProtectedRocket(hand, cards)) : legalOptions;
  let options = protectedOptions.length ? protectedOptions : legalOptions;
  if (!options.length) return [];
  const { currentPlayer = null, landlord = null, handSizes = [], seenCards = [], publicCards = [] } = context;
  const opposingPlayers = handSizes.map((_, player) => player).filter((player) => player !== currentPlayer && !sameTeam(currentPlayer, player, landlord));
  const opponentThreat = opposingPlayers.some((player) => (handSizes[player] ?? 99) <= 2);
  const opponentClosing = opposingPlayers.some((player) => (handSizes[player] ?? 99) <= 4);
  // The AI should normally prune structurally destructive moves. The player
  // hint panel, however, needs to keep the wider legal response set so the
  // hint button can genuinely cycle while still ranking safer choices first.
  if (protectsRocket && !opponentThreat && !context.includeAlternatives) {
    const structureSafe = options.filter((cards) => structuralDamageCost(hand, cards) === 0 || removeCards(hand, cards).length === 0);
    if (structureSafe.length) options = structureSafe;
  }
  const nextPlayer = currentPlayer === null ? null : nextPlayerCounterClockwise(currentPlayer);
  const teammateClosing = nextPlayer !== null && sameTeam(currentPlayer, nextPlayer, landlord) && (handSizes[nextPlayer] ?? 99) <= 2;
  const memory = buildCardMemory(hand, seenCards, publicCards, profile);
  const planner = profile.planningHandLimit && hand.length <= profile.planningHandLimit ? createEndgamePlanner(profile.nodeLimit) : null;
  const possibleHands = samplePossibleHands(hand, context, profile);

  const ranked = options.map((cards) => {
    const combo = classifyPlay(cards);
    const remaining = removeCards(hand, cards);
    const breakCost = structuralDamageCost(hand, cards);
    const special = ['bomb', 'rocket'].includes(combo.type);
    const turns = planner && remaining.length <= profile.planningHandLimit ? planner.minimumTurns(remaining) : null;
    const responseRisk = potentialHigherResponses(combo, memory);
    const desiredFeedType = (handSizes[nextPlayer] ?? 1) === 2 ? 'pair' : 'single';
    let score = combo.rank
      + breakCost * profile.structureWeight
      + (special ? profile.bombPenalty : 0)
      - cards.length * (previous ? .55 : 5.2)
      + (turns === null ? 0 : turns * profile.planningWeight)
      + responseRisk * profile.controlWeight * (opponentThreat ? 2.5 : opponentClosing ? 1.15 : .02)
      - (!remaining.length ? 1200 : 0)
      - (teammateClosing && !previous && combo.type === desiredFeedType ? 95 * profile.teamwork : 0);
    if (opponentThreat && !previous && ['single', 'pair'].includes(combo.type)) score -= combo.rank * profile.controlWeight * .9;
    if (opponentThreat && !previous) {
      const threatenedWithOne = opposingPlayers.some((player) => (handSizes[player] ?? 99) === 1);
      const blockingType = threatenedWithOne ? 'single' : 'pair';
      if (combo.type === blockingType && breakCost === 0) score -= 230 + combo.rank * profile.controlWeight;
    }
    if (opponentThreat && previous && !special) score -= combo.rank * profile.controlWeight * .7;
    if (previous && special && remaining.length && !opponentThreat) score += profile.bombPenalty * .45;
    return { cards, combo, remaining, turns, breakCost, responseRisk, score, reason: '' };
  });

  if (possibleHands.length) {
    ranked.forEach((candidate) => {
      const metrics = sampledControlMetrics(candidate, hand, possibleHands, context);
      candidate.responseRate = metrics.responseRate;
      candidate.recaptureRate = metrics.recaptureRate;
      const urgency = opponentThreat ? 1.8 : opponentClosing ? 1 : .28;
      candidate.score += metrics.responseRate * profile.sampleWeight * urgency - metrics.recaptureRate * profile.sampleWeight * .32;
    });
  }
  ranked.sort((a, b) => a.score - b.score || a.combo.rank - b.combo.rank || b.cards.length - a.cards.length);

  return ranked.map((candidate, index) => ({
    ...candidate,
    grade: index === 0 ? '首选' : index < 3 ? '稳健' : '备选',
    reason: strategicReason({ ...candidate, opponentThreat }),
  }));
}

function selectDifficultyCandidate(ranked, hand, context, profile) {
  if (!ranked.length) return null;
  if (profile.choiceWindow <= 1 || deterministicDecisionRoll(hand, context) <= profile.accuracy) return ranked[0].cards;
  const available = Math.min(profile.choiceWindow, ranked.length);
  const index = 1 + Math.floor(deterministicDecisionRoll([...hand].reverse(), context) * Math.max(1, available - 1));
  return ranked[Math.min(index, available - 1)].cards;
}

function createEndgamePlanner(nodeLimit = 7000) {
  const memo = new Map();
  let nodes = 0;
  const minimumTurns = (hand) => {
    if (!hand.length) return 0;
    const whole = classifyPlay(hand);
    if (whole) return 1;
    const key = optionSignature(hand);
    if (memo.has(key)) return memo.get(key);
    nodes += 1;
    if (nodes > nodeLimit) return Math.ceil(hand.length / 3);
    let best = hand.length;
    const options = enumeratePlayableOptions(hand);
    for (const option of options) {
      const remaining = removeCards(hand, option);
      best = Math.min(best, 1 + minimumTurns(remaining));
      if (best === 2) break;
    }
    memo.set(key, best);
    return best;
  };
  return { minimumTurns };
}

export function estimateMinimumTurns(hand) {
  if (!hand?.length) return 0;
  return createEndgamePlanner().minimumTurns(hand);
}

function recommendEndgamePlay(hand, previous = null, nodeLimit = 7000) {
  if (!hand?.length || hand.length > 10) return null;
  const planner = createEndgamePlanner(nodeLimit);
  return enumeratePlayableOptions(hand, previous)
    .map((cards) => {
      const remaining = removeCards(hand, cards);
      const combo = classifyPlay(cards);
      return {
        cards,
        turns: remaining.length ? planner.minimumTurns(remaining) : 0,
        score: strategicPlayScore(hand, cards, previous),
        special: combo.type === 'bomb' || combo.type === 'rocket' ? 1 : 0,
      };
    })
    .sort((a, b) => a.turns - b.turns || a.special - b.special || a.score - b.score)[0]?.cards || null;
}

export function recommendStrategicPlay(hand, previous = null) {
  return enumeratePlayableOptions(hand, previous)
    .map((cards) => ({ cards, score: strategicPlayScore(hand, cards, previous) }))
    .sort((a, b) => a.score - b.score)[0]?.cards || null;
}

export function evaluatePlayDecision(hand, previous, played) {
  const combo = classifyPlay(played);
  const recommended = recommendStrategicPlay(hand, previous);
  if (!combo || !recommended) return { tone: 'neutral', title: '暂无策略评价', detail: '这一手缺少可比较的合法候选。', recommended: null };
  const recommendedCombo = classifyPlay(recommended);
  const breakCost = preservationCost(hand, played);
  if (sameCardSet(played, recommended)) {
    return { tone: 'good', title: '稳健选择', detail: '兼顾了牌力消耗、组合完整度与后续牌权。', recommended };
  }
  if ((combo.type === 'bomb' || combo.type === 'rocket') && !['bomb', 'rocket'].includes(recommendedCombo.type)) {
    return { tone: 'critical', title: '炸弹使用偏早', detail: `存在${playNames[recommendedCombo.type]}可以完成压制，保留炸弹通常更有终局价值。`, recommended };
  }
  if (breakCost >= 80) {
    return { tone: 'critical', title: '拆散了完整炸弹', detail: '这手牌破坏了四张结构，除非正在阻止对手走完，否则代价较高。', recommended };
  }
  if (breakCost >= 20) {
    return { tone: 'watch', title: '拆三张偏激进', detail: '当前选择削弱了三张组合，推荐方案能保留更多带牌空间。', recommended };
  }
  if (breakCost >= 7) {
    return { tone: 'watch', title: '可以避免拆对子', detail: '保留对子会让后续牌型更完整，建议优先使用真正的单张。', recommended };
  }
  const gap = strategicPlayScore(hand, played, previous) - strategicPlayScore(hand, recommended, previous);
  return {
    tone: gap > 35 ? 'watch' : 'good',
    title: gap > 35 ? '还有更高效的牌路' : '合理选择',
    detail: gap > 35 ? `推荐优先打出${playNames[recommendedCombo.type]}，能更快压缩手牌并保留高牌。` : '与推荐方案接近，属于可接受的局面选择。',
    recommended,
  };
}

export function evaluatePassDecision(hand, previous, context = {}) {
  if (!previous) return { tone: 'neutral', title: '新一轮牌权', detail: '当前没有需要压制的牌型。', recommended: null };
  const { currentPlayer = null, landlord = null, lastPlayer = null, handSizes = [] } = context;
  if (sameTeam(currentPlayer, lastPlayer, landlord)) {
    return { tone: 'good', title: '让牌给队友', detail: '队友持有牌权，选择不出可以避免无意义内耗。', recommended: null };
  }
  const recommended = recommendStrategicPlay(hand, previous);
  if (!recommended) return { tone: 'good', title: '无牌可压', detail: '手牌中没有合法且更大的同型牌或炸弹。', recommended: null };
  const threat = lastPlayer !== null && (handSizes[lastPlayer] ?? 99) <= 2;
  if (threat) return { tone: 'critical', title: '放过了关键牌权', detail: '对手仅剩两张以内，此时有牌可压却选择不出，终局风险很高。', recommended };
  return { tone: 'watch', title: '保守过牌', detail: '当前存在可压制方案；若不是为保留结构或配合队友，可考虑主动争取牌权。', recommended };
}

function materializeOption(hand, sourceCards, option) {
  const optionCounts = countsOf(option);
  const sourceIds = new Set(sourceCards.map((card) => card.id));
  const matched = [];
  for (const [value, cards] of optionCounts.entries()) {
    const fromSource = sourceCards.filter((card) => card.value === value).slice(0, cards.length);
    matched.push(...fromSource);
    matched.push(...hand.filter((card) => card.value === value && !sourceIds.has(card.id)).slice(0, cards.length - fromSource.length));
  }
  return matched;
}

export function matchLikelyOptions(hand, selectedCards, previous = null) {
  if (!selectedCards?.length) return [];
  const selectedCounts = countsOf(selectedCards);
  const options = enumeratePlayableOptions(hand, previous).filter((option) => {
    const optionCounts = countsOf(option);
    const combo = classifyPlay(option);
    if ((combo.type === 'bomb' || combo.type === 'rocket') && previous?.type !== combo.type && selectedCards.length < 2) return false;
    return [...selectedCounts.entries()].every(([value, cards]) => (optionCounts.get(value)?.length || 0) >= cards.length);
  });
  options.sort((a, b) => {
    const comboA = classifyPlay(a);
    const comboB = classifyPlay(b);
    const specialA = comboA.type === 'bomb' || comboA.type === 'rocket' ? 1 : 0;
    const specialB = comboB.type === 'bomb' || comboB.type === 'rocket' ? 1 : 0;
    return specialA - specialB
      || preservationCost(hand, a) - preservationCost(hand, b)
      || (a.length - selectedCards.length) - (b.length - selectedCards.length)
      || comboA.rank - comboB.rank;
  });
  return options.map((option) => materializeOption(hand, selectedCards, option));
}

export function matchLikelyPlay(hand, selectedCards, previous = null) {
  return matchLikelyOptions(hand, selectedCards, previous)[0] || null;
}

export function findBestGesturePlay(hand, gestureCards, previous = null) {
  if (!gestureCards?.length) return null;
  const exact = classifyPlay(gestureCards);
  if (exact && canBeat(exact, previous)) return [...gestureCards];
  const gestureCounts = countsOf(gestureCards);
  const minimumOverlap = Math.max(2, Math.ceil(gestureCards.length * .5));
  const ranked = enumeratePlayableOptions(hand, previous).map((option) => {
    const optionCounts = countsOf(option);
    const overlap = [...gestureCounts.entries()].reduce((sum, [value, cards]) => sum + Math.min(cards.length, optionCounts.get(value)?.length || 0), 0);
    const discarded = gestureCards.length - overlap;
    const extras = option.length - overlap;
    const combo = classifyPlay(option);
    const special = combo.type === 'bomb' || combo.type === 'rocket' ? 1 : 0;
    const remaining = removeCards(hand, option);
    const endgameTurns = hand.length <= 10 ? estimateMinimumTurns(remaining) : 0;
    const score = overlap * -1000 + discarded * 320 + extras * 85 + special * 520 + preservationCost(hand, option) * 4 + endgameTurns * 120 + combo.rank;
    return { option, overlap, score };
  }).filter((candidate) => candidate.overlap >= minimumOverlap).sort((a, b) => a.score - b.score);
  return ranked[0] ? materializeOption(hand, gestureCards, ranked[0].option) : null;
}

function sameTeam(playerA, playerB, landlord) {
  if (playerA === null || playerB === null || landlord === null || landlord === undefined) return false;
  return playerA === landlord ? playerB === landlord : playerB !== landlord;
}

function unseenHighCardCount(hand, seenCards = []) {
  const known = countsOf([...hand, ...seenCards]);
  return [14, 15, 16, 17].reduce((total, value) => {
    const deckCount = value >= 16 ? 1 : 4;
    return total + Math.max(0, deckCount - (known.get(value)?.length || 0));
  }, 0);
}

export function rankStrategicActions(hand, previous = null, context = {}, difficulty = 'master') {
  const profile = resolveDifficulty(difficulty);
  const plays = rankStrategicOptions(hand, previous, context, profile).map((candidate) => ({ ...candidate, action: 'play' }));
  if (!previous) return plays.map((action, index) => ({ ...action, grade: index === 0 ? '首选' : index === 1 ? '稳健' : index === 2 ? '激进' : '备选' }));
  if (!plays.length) return [{ action: 'pass', cards: [], combo: null, score: -1000, grade: '首选', reason: '没有合法压制牌，保留当前手牌结构' }];

  const best = plays[0];
  const { currentPlayer = null, landlord = null, lastPlayer = previous.player ?? null, handSizes = [] } = context;
  const teammateHasLead = sameTeam(currentPlayer, lastPlayer, landlord);
  const landlordThreat = landlord !== null && landlord !== undefined && (handSizes[landlord] ?? 99) <= 2;
  const landlordActsNext = currentPlayer !== null && landlord === nextPlayerCounterClockwise(currentPlayer);
  const mustTakeOver = teammateHasLead && landlordThreat && landlordActsNext && ['single', 'pair'].includes(previous.type);
  const opposingPlayers = handSizes.map((_, player) => player).filter((player) => player !== currentPlayer && !sameTeam(currentPlayer, player, landlord));
  const opponentThreat = opposingPlayers.some((player) => (handSizes[player] ?? 99) <= 2);
  let passScore = best.score + 22;
  let reason = '可以保留牌力，但会继续让出当前牌权';
  if (teammateHasLead && !mustTakeOver) {
    passScore = profile.teamwork >= .55 ? best.score - 520 : best.score + 38;
    reason = profile.teamwork >= .55 ? '队友持有牌权，避免内耗并保留控制牌' : '可以让队友继续掌握牌权';
  } else if (mustTakeOver || opponentThreat) {
    passScore = best.score + 520;
    reason = mustTakeOver ? '地主即将行动，需要主动接过队友牌权封堵' : '对手接近走完，此时不出风险很高';
  } else if (best.breakCost >= 80 || ['bomb', 'rocket'].includes(best.combo.type)) {
    passScore = currentPlayer === null ? best.score + 22 : best.score - 28;
    reason = '当前压制需要破坏炸弹或王炸，暂时不出更利于保留终局牌力';
  }
  const actions = [...plays, { action: 'pass', cards: [], combo: null, score: passScore, reason, breakCost: 0, responseRate: 0, recaptureRate: 0 }]
    .sort((a, b) => a.score - b.score);
  return actions.map((action, index) => ({ ...action, grade: index === 0 ? '首选' : index === 1 ? '稳健' : index === 2 ? '激进' : '备选' }));
}

export function analyzeAiDecision(hand, previous, context = {}) {
  const profile = resolveDifficulty(context.difficulty);
  const actions = rankStrategicActions(hand, previous, context, profile);
  if (!actions.length) return { action: 'pass', cards: [], reason: '没有可执行动作', difficulty: profile.id, alternatives: [] };
  let index = 0;
  if (context.difficulty && profile.choiceWindow > 1 && deterministicDecisionRoll(hand, context) > profile.accuracy) {
    const available = Math.min(profile.choiceWindow, actions.length);
    index = Math.min(available - 1, 1 + Math.floor(deterministicDecisionRoll([...hand].reverse(), context) * Math.max(1, available - 1)));
  }
  const chosen = actions[index];
  return {
    action: chosen.action,
    cards: chosen.cards,
    combo: chosen.combo,
    reason: chosen.reason,
    grade: chosen.grade,
    score: chosen.score,
    responseRate: chosen.responseRate ?? null,
    recaptureRate: chosen.recaptureRate ?? null,
    difficulty: profile.id,
    alternatives: actions.slice(0, 3).map((action) => ({ action: action.action, cards: action.cards, combo: action.combo, reason: action.reason, grade: action.grade, score: action.score })),
  };
}

export function chooseAiPlay(hand, previous, context = {}) {
  const decision = analyzeAiDecision(hand, previous, context);
  return decision.action === 'play' ? decision.cards : null;
}

export function calculateSpring(playCounts, landlord, winner) {
  if (!playCounts || landlord === null || winner === null) return null;
  if (winner === landlord && playCounts.every((count, player) => player === landlord || count === 0)) return 'spring';
  if (winner !== landlord && playCounts[landlord] === 1) return 'anti_spring';
  return null;
}

export function removeCards(hand, cards) {
  const ids = new Set(cards.map((card) => card.id));
  return hand.filter((card) => !ids.has(card.id));
}

export function estimateBid(hand, difficulty = 'master', context = {}) {
  const map = cardsByValue(hand);
  const profile = resolveDifficulty(difficulty);
  let score = 0;
  if (map.has(17)) score += 2;
  if (map.has(16)) score += 1.5;
  score += (map.get(15)?.length || 0) * 0.45;
  score += (map.get(14)?.length || 0) * 0.22;
  score += [...map.values()].filter((cards) => cards.length === 4).length * 2;
  if (map.has(16) && map.has(17)) score += 2;
  if (profile.planningHandLimit >= 9) {
    const longestStructure = enumeratePlayableOptions(hand)
      .filter((cards) => ['straight', 'pair_straight', 'airplane', 'airplane_single', 'airplane_pair'].includes(classifyPlay(cards).type))
      .reduce((longest, cards) => Math.max(longest, cards.length), 0);
    score += Math.max(0, longestStructure - 4) * .11;
  }
  let bid = score >= 5 ? 3 : score >= 3.2 ? 2 : score >= 2 ? 1 : 0;
  if (profile.accuracy < 1 && deterministicDecisionRoll(hand, context) > profile.accuracy) {
    const direction = deterministicDecisionRoll([...hand].reverse(), context) > .5 ? 1 : -1;
    bid = Math.max(0, Math.min(3, bid + direction));
  }
  return bid;
}

export const playNames = {
  single: '单张', pair: '对子', triple: '三张', triple_single: '三带一', triple_pair: '三带二',
  straight: '顺子', pair_straight: '连对', airplane: '飞机', airplane_single: '飞机带单', airplane_pair: '飞机带对',
  four_two_single: '四带二', four_two_pair: '四带两对', bomb: '炸弹', rocket: '王炸',
};
