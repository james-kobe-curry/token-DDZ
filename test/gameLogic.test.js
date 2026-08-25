import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_DIFFICULTIES,
  analyzeAiDecision,
  canBeat,
  calculateSpring,
  chooseAiPlay,
  classifyPlay,
  dealWithSeed,
  enumeratePlayableOptions,
  estimateMinimumTurns,
  evaluatePassDecision,
  evaluatePlayDecision,
  findBestGesturePlay,
  GAME_RULES,
  matchLikelyPlay,
  matchLikelyOptions,
  nextPlayerCounterClockwise,
  recommendStrategicPlay,
  rankValue,
  rankStrategicActions,
  rankStrategicOptions,
} from '../src/gameLogic.js';

let serial = 0;
function cards(spec) {
  return spec.flatMap(([rank, amount]) => Array.from({ length: amount }, () => ({
    id: `${rank}-${serial++}`,
    rank,
    value: rankValue(rank),
    key: rank.includes('J') ? 'joker' : 'spade',
  })));
}

test('座位轮转始终按逆时针：自己到右侧，再到左侧', () => {
  assert.equal(nextPlayerCounterClockwise(0), 2);
  assert.equal(nextPlayerCounterClockwise(2), 1);
  assert.equal(nextPlayerCounterClockwise(1), 0);
});

test('同一个种子始终产生同一副牌', () => {
  const first = dealWithSeed('token-landlords-test');
  const second = dealWithSeed('token-landlords-test');
  assert.deepEqual(first.deckOrder, second.deckOrder);
  assert.deepEqual(first.hands.map((hand) => hand.length), [17, 17, 17]);
  assert.equal(first.bottom.length, 3);
  assert.equal(new Set(first.deckOrder).size, 54);
  first.hands.forEach((hand) => assert.ok(hand.every((card, index) => index === 0 || hand[index - 1].value >= card.value)));
});

test('识别基础牌型和炸弹', () => {
  assert.equal(classifyPlay(cards([['3', 1]])).type, 'single');
  assert.equal(classifyPlay(cards([['4', 2]])).type, 'pair');
  assert.equal(classifyPlay(cards([['5', 3], ['7', 2]])).type, 'triple_pair');
  assert.equal(classifyPlay(cards([['8', 4]])).type, 'bomb');
  assert.equal(classifyPlay(cards([['SJ', 1], ['BJ', 1]])).type, 'rocket');
});

test('识别顺子、连对和飞机', () => {
  assert.equal(classifyPlay(cards([['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1]])).type, 'straight');
  assert.equal(classifyPlay(cards([['6', 2], ['7', 2], ['8', 2]])).type, 'pair_straight');
  assert.equal(classifyPlay(cards([['9', 3], ['10', 3], ['3', 1], ['4', 1]])).type, 'airplane_single');
  assert.equal(classifyPlay(cards([['J', 3], ['Q', 3], ['4', 2], ['5', 2]])).type, 'airplane_pair');
});

test('识别四带二与四带两对', () => {
  assert.equal(classifyPlay(cards([['7', 4], ['3', 1], ['5', 1]])).type, 'four_two_single');
  assert.equal(classifyPlay(cards([['9', 4], ['3', 2], ['5', 2]])).type, 'four_two_pair');
  assert.equal(classifyPlay(cards([['9', 4], ['3', 3], ['5', 1]])), null);
});

test('飞机翅膀不能复用核心点数的第四张', () => {
  assert.equal(GAME_RULES.airplaneWingsMayReuseCoreRank, false);
  assert.equal(classifyPlay(cards([['7', 4], ['8', 3], ['3', 1]])), null);
});

test('2 和王不能进入顺子', () => {
  assert.equal(classifyPlay(cards([['10', 1], ['J', 1], ['Q', 1], ['K', 1], ['A', 1]])).type, 'straight');
  assert.equal(classifyPlay(cards([['J', 1], ['Q', 1], ['K', 1], ['A', 1], ['2', 1]])), null);
});

test('比较规则正确处理同型、炸弹和王炸', () => {
  const pair7 = classifyPlay(cards([['7', 2]]));
  const pair8 = classifyPlay(cards([['8', 2]]));
  const bomb3 = classifyPlay(cards([['3', 4]]));
  const rocket = classifyPlay(cards([['SJ', 1], ['BJ', 1]]));
  assert.equal(canBeat(pair8, pair7), true);
  assert.equal(canBeat(pair7, pair8), false);
  assert.equal(canBeat(bomb3, pair8), true);
  assert.equal(canBeat(rocket, bomb3), true);
  assert.equal(canBeat(bomb3, rocket), false);
});

test('顺子和连对必须长度一致才能比较', () => {
  const straight5 = classifyPlay(cards([['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1]]));
  const straight6 = classifyPlay(cards([['4', 1], ['5', 1], ['6', 1], ['7', 1], ['8', 1], ['9', 1]]));
  const pairs3 = classifyPlay(cards([['3', 2], ['4', 2], ['5', 2]]));
  const pairs4 = classifyPlay(cards([['4', 2], ['5', 2], ['6', 2], ['7', 2]]));
  assert.equal(canBeat(straight6, straight5), false);
  assert.equal(canBeat(pairs4, pairs3), false);
});

test('王炸不可被任何牌型再次压制', () => {
  const rocket = classifyPlay(cards([['SJ', 1], ['BJ', 1]]));
  assert.equal(canBeat(rocket, rocket), false);
  assert.equal(canBeat(classifyPlay(cards([['2', 4]])), rocket), false);
});

test('机器人给出的牌一定能压过目标牌', () => {
  const hand = cards([['3', 1], ['6', 2], ['9', 3], ['K', 4], ['SJ', 1], ['BJ', 1]]);
  const target = classifyPlay(cards([['5', 2]]));
  const play = chooseAiPlay(hand, target);
  assert.ok(play);
  assert.equal(canBeat(classifyPlay(play), target), true);
});

test('机器人跟单时优先使用独立单张而不是拆对子', () => {
  const hand = cards([['6', 2], ['7', 1], ['K', 1]]);
  const target = classifyPlay(cards([['5', 1]]));
  const play = chooseAiPlay(hand, target, { currentPlayer: 0, landlord: 0, lastPlayer: 1, handSizes: [4, 6, 5] });
  assert.equal(play[0].rank, '7');
});

test('对手报单时机器人使用最高的不拆牌单张封堵', () => {
  const hand = cards([['6', 2], ['7', 1], ['K', 1], ['A', 1]]);
  const target = classifyPlay(cards([['5', 1]]));
  const play = chooseAiPlay(hand, target, { currentPlayer: 0, landlord: 0, lastPlayer: 1, handSizes: [5, 1, 4] });
  assert.equal(play[0].rank, 'A');
});

test('对手报双且机器人拥有牌权时优先打最高对子', () => {
  const hand = cards([['6', 2], ['9', 2], ['K', 1]]);
  const play = chooseAiPlay(hand, null, { currentPlayer: 0, landlord: 0, lastPlayer: null, handSizes: [5, 2, 4] });
  assert.equal(classifyPlay(play).type, 'pair');
  assert.equal(play[0].rank, '9');
});

test('农民不会无意义压过队友', () => {
  const hand = cards([['6', 1], ['9', 2], ['K', 1]]);
  const target = classifyPlay(cards([['5', 1]]));
  const play = chooseAiPlay(hand, target, { currentPlayer: 2, landlord: 0, lastPlayer: 1, handSizes: [8, 5, 4] });
  assert.equal(play, null);
});

test('农民拥有牌权时会给下家报单队友输送低单张', () => {
  const hand = cards([['3', 1], ['6', 2], ['K', 1]]);
  const play = chooseAiPlay(hand, null, { currentPlayer: 2, landlord: 0, handSizes: [7, 1, 4] });
  assert.equal(classifyPlay(play).type, 'single');
  assert.equal(play[0].rank, '3');
});

test('地主报单且将在下家行动时农民会主动接过队友牌权封堵', () => {
  const hand = cards([['6', 1], ['A', 1]]);
  const target = classifyPlay(cards([['5', 1]]));
  const play = chooseAiPlay(hand, target, { currentPlayer: 1, landlord: 0, lastPlayer: 2, handSizes: [1, 2, 5] });
  assert.equal(play[0].rank, 'A');
});

test('机器人会根据已出现高牌在收官阶段提高压制强度', () => {
  const hand = cards([['6', 1], ['9', 1], ['A', 1]]);
  const seenCards = cards([['A', 3], ['2', 4], ['SJ', 1], ['BJ', 1]]);
  const target = classifyPlay(cards([['5', 1]]));
  const play = chooseAiPlay(hand, target, { currentPlayer: 0, landlord: 0, lastPlayer: 1, handSizes: [3, 4, 6], seenCards });
  assert.equal(play[0].rank, 'A');
});

test('五档 AI 难度逐级增加记牌、搜索与协作能力', () => {
  assert.deepEqual(Object.keys(AI_DIFFICULTIES), ['super', 'master', 'elite', 'normal', 'rookie']);
  const ordered = Object.values(AI_DIFFICULTIES);
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(ordered[index - 1].memoryRatio >= ordered[index].memoryRatio);
    assert.ok(ordered[index - 1].planningHandLimit >= ordered[index].planningHandLimit);
    assert.ok(ordered[index - 1].samples >= ordered[index].samples);
    assert.ok(ordered[index - 1].teamwork >= ordered[index].teamwork);
    assert.ok(ordered[index - 1].accuracy >= ordered[index].accuracy);
  }
  assert.equal(AI_DIFFICULTIES.super.accuracy, 1);
  assert.ok(AI_DIFFICULTIES.master.accuracy >= .7);
});

test('高阶农民在队友即将走完时不会用炸弹抢牌权', () => {
  const hand = cards([['6', 4], ['9', 1]]);
  const target = { ...classifyPlay(cards([['5', 1]])), player: 1 };
  const action = rankStrategicActions(hand, target, { currentPlayer: 2, landlord: 0, lastPlayer: 1, handSizes: [8, 1, 5] }, 'super')[0];
  assert.equal(action.action, 'pass');
  assert.match(action.reason, /队友|牌权/);
});

test('超强 AI 会评估给下家队友直接走完的概率', () => {
  const hand = cards([['3', 1], ['5', 2], ['9', 1]]);
  const ranking = rankStrategicOptions(hand, null, { currentPlayer: 2, landlord: 0, handSizes: [8, 1, 4], seenCards: [], publicCards: [], turnSerial: 8 }, 'super');
  assert.equal(ranking[0].combo.type, 'single');
  assert.equal(typeof ranking[0].teammateFinishRate, 'number');
  assert.ok(ranking[0].teammateFinishRate > 0);
});

test('高难度会用公开记牌判断收官控制，菜鸟仍倾向低牌', () => {
  const hand = cards([['6', 1], ['9', 1], ['A', 1]]);
  const seenCards = cards([['A', 3], ['2', 4], ['SJ', 1], ['BJ', 1]]);
  const target = classifyPlay(cards([['5', 1]]));
  const context = { currentPlayer: 0, landlord: 0, lastPlayer: 1, handSizes: [3, 4, 6], seenCards, turnSerial: 2 };
  const superRanking = rankStrategicOptions(hand, target, context, 'super');
  const rookieRanking = rankStrategicOptions(hand, target, context, 'rookie');
  assert.equal(superRanking[0].cards[0].rank, 'A');
  assert.equal(rookieRanking[0].cards[0].rank, '6');
});

test('高难度配合队友让牌，菜鸟可能无意义抢队友牌权', () => {
  const hand = cards([['6', 1], ['9', 2], ['K', 1]]);
  const target = classifyPlay(cards([['5', 1]]));
  const context = { currentPlayer: 2, landlord: 0, lastPlayer: 1, handSizes: [8, 5, 4], turnSerial: 1 };
  assert.equal(chooseAiPlay(hand, target, { ...context, difficulty: 'super' }), null);
  assert.equal(rankStrategicActions(hand, target, context, 'rookie')[0].action, 'play');
});

test('策略提示优先保留完整炸弹并说明后续牌路', () => {
  const hand = cards([['6', 4], ['7', 1], ['9', 1]]);
  const target = classifyPlay(cards([['5', 1]]));
  const ranked = rankStrategicOptions(hand, target, { currentPlayer: 0, landlord: 0, handSizes: [6, 8, 7] }, 'super');
  assert.equal(classifyPlay(ranked[0].cards).type, 'single');
  assert.equal(ranked[0].cards[0].rank, '7');
  assert.equal(ranked[0].grade, '首选');
  assert.ok(ranked[0].reason.length > 8);
  assert.ok(ranked.findIndex((candidate) => classifyPlay(candidate.cards).type === 'bomb') > 0);
});

test('AI 决策不读取上下文中额外传入的对手暗牌', () => {
  const hand = cards([['4', 1], ['7', 2], ['10', 1], ['A', 1]]);
  const target = classifyPlay(cards([['6', 1]]));
  const context = { currentPlayer: 1, landlord: 0, lastPlayer: 0, handSizes: [8, 5, 7], seenCards: [], difficulty: 'super', turnSerial: 5 };
  const withoutHidden = chooseAiPlay(hand, target, context);
  const withHidden = chooseAiPlay(hand, target, { ...context, opponentHands: [cards([['BJ', 1]]), cards([['3', 4]])] });
  assert.deepEqual(withHidden.map((card) => card.id), withoutHidden.map((card) => card.id));
});

test('超强与大师持有双王时不会把王炸拆成单王', () => {
  const hand = cards([['3', 1], ['7', 2], ['2', 1], ['SJ', 1], ['BJ', 1]]);
  const target = classifyPlay(cards([['2', 1]]));
  for (const difficulty of ['super', 'master']) {
    const leadRanking = rankStrategicOptions(hand, null, { currentPlayer: 0, landlord: 0, handSizes: [6, 5, 7] }, difficulty);
    assert.ok(leadRanking.every((candidate) => candidate.cards.filter((card) => card.value >= 16).length !== 1));
    const response = chooseAiPlay(hand, target, { currentPlayer: 0, landlord: 0, lastPlayer: 1, handSizes: [6, 1, 7], difficulty });
    assert.equal(classifyPlay(response).type, 'rocket');
  }
});

test('超强使用公开信息采样接牌概率，菜鸟不进行未知手牌推演', () => {
  const hand = cards([['5', 1], ['8', 2], ['J', 1], ['A', 1]]);
  const context = { currentPlayer: 0, landlord: 0, handSizes: [5, 7, 8], seenCards: cards([['3', 4], ['4', 3]]), publicCards: [], turnSerial: 9 };
  const advanced = rankStrategicOptions(hand, null, context, 'super')[0];
  const beginner = rankStrategicOptions(hand, null, context, 'rookie')[0];
  assert.equal(typeof advanced.responseRate, 'number');
  assert.equal(typeof advanced.recaptureRate, 'number');
  assert.equal(beginner.responseRate, undefined);
});

test('统一策略排名会把不出作为队友配合候选并在对手报单时降低其优先级', () => {
  const hand = cards([['6', 1], ['9', 2], ['K', 1]]);
  const target = { ...classifyPlay(cards([['5', 1]])), player: 1 };
  const teammateActions = rankStrategicActions(hand, target, { currentPlayer: 2, landlord: 0, lastPlayer: 1, handSizes: [8, 5, 4] }, 'super');
  const threatActions = rankStrategicActions(hand, { ...target, player: 0 }, { currentPlayer: 2, landlord: 0, lastPlayer: 0, handSizes: [1, 5, 4] }, 'super');
  assert.equal(teammateActions[0].action, 'pass');
  assert.equal(threatActions[0].action, 'play');
});

test('AI 决策提供可展示的策略理由和前三候选', () => {
  const hand = cards([['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1], ['9', 2]]);
  const decision = analyzeAiDecision(hand, null, { currentPlayer: 0, landlord: 0, handSizes: [7, 6, 7], difficulty: 'super', turnSerial: 3 });
  assert.equal(decision.action, 'play');
  assert.ok(decision.reason.length > 8);
  assert.ok(decision.alternatives.length >= 2);
});

test('高阶 AI 有完整组合可出时不会拆散顺子、连对或对子', () => {
  const hand = cards([['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1], ['9', 2]]);
  const ranked = rankStrategicOptions(hand, null, { currentPlayer: 0, landlord: 0, handSizes: [7, 8, 6] }, 'super');
  assert.ok(ranked.length > 0);
  assert.ok(ranked.every((candidate) => ['straight', 'pair'].includes(candidate.combo.type)));
});

test('正确识别春天与反春天', () => {
  assert.equal(calculateSpring([3, 0, 0], 0, 0), 'spring');
  assert.equal(calculateSpring([1, 3, 2], 0, 1), 'anti_spring');
  assert.equal(calculateSpring([2, 3, 2], 0, 1), null);
});

test('提示选项按从小到大排列并把炸弹放在普通牌之后', () => {
  const hand = cards([['6', 2], ['8', 2], ['10', 2], ['K', 4], ['SJ', 1], ['BJ', 1]]);
  const target = classifyPlay(cards([['5', 2]]));
  const options = enumeratePlayableOptions(hand, target);
  const combos = options.map(classifyPlay);
  assert.deepEqual(combos.slice(0, 3).map((combo) => combo.rank), [rankValue('6'), rankValue('8'), rankValue('10')]);
  assert.equal(combos.at(-1).type, 'rocket');
});

test('玩家智能提示可保留多条合法备选而 AI 仍使用结构剪枝', () => {
  const hand = cards([['6', 2], ['8', 2], ['10', 2], ['K', 4]]);
  const target = classifyPlay(cards([['5', 1]]));
  const context = { currentPlayer: 0, landlord: 0, handSizes: [10, 8, 7] };
  const aiActions = rankStrategicActions(hand, target, context, 'super').filter((action) => action.action === 'play');
  const hintActions = rankStrategicActions(hand, target, { ...context, includeAlternatives: true }, 'super').filter((action) => action.action === 'play');
  assert.ok(hintActions.length > aiActions.length);
  assert.ok(hintActions.some((action) => action.cards[0]?.rank === '6'));
  assert.ok(hintActions.some((action) => action.cards[0]?.rank === '8'));
});

test('智能匹配可以根据一张牌补全对子', () => {
  const hand = cards([['4', 1], ['7', 2], ['9', 1]]);
  const target = classifyPlay(cards([['6', 2]]));
  const selected = [hand.find((card) => card.rank === '7')];
  const matched = matchLikelyPlay(hand, selected, target);
  assert.equal(matched.length, 2);
  assert.equal(classifyPlay(matched).type, 'pair');
  assert.equal(canBeat(classifyPlay(matched), target), true);
});

test('完整三张会给出三带一和三带二候选', () => {
  const hand = cards([['3', 1], ['4', 2], ['7', 3], ['9', 1]]);
  const selected = hand.filter((card) => card.rank === '7');
  const types = matchLikelyOptions(hand, selected).map((option) => classifyPlay(option).type);
  assert.ok(types.includes('triple_single'));
  assert.ok(types.includes('triple_pair'));
});

test('复杂带牌会枚举全部合法翅膀而不只使用最低牌', () => {
  const hand = cards([['3', 1], ['4', 1], ['5', 1], ['7', 3]]);
  const options = enumeratePlayableOptions(hand).filter((option) => classifyPlay(option).type === 'triple_single');
  assert.deepEqual(new Set(options.map((option) => option.find((card) => card.rank !== '7').rank)), new Set(['3', '4', '5']));
});

test('滑动包含多余牌时吸附为重合度高且更利于收尾的顺子', () => {
  const hand = cards([['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1], ['8', 1], ['K', 1]]);
  const gesture = hand.filter((card) => card.rank !== '8');
  const matched = findBestGesturePlay(hand, gesture);
  assert.equal(classifyPlay(matched).type, 'straight');
  assert.deepEqual(matched.map((card) => card.rank).sort(), ['3', '4', '5', '6', '7', '8']);
});

test('滑过三组对子和一张杂牌时优先吸附连对', () => {
  const hand = cards([['3', 2], ['4', 2], ['5', 2], ['6', 1], ['K', 1]]);
  const gesture = hand.filter((card) => card.rank !== 'K');
  const matched = findBestGesturePlay(hand, gesture);
  assert.equal(classifyPlay(matched).type, 'pair_straight');
  assert.equal(matched.length, 6);
});

test('提示会优先保留炸弹和完整对子', () => {
  const hand = cards([['6', 4], ['7', 1], ['9', 1]]);
  const target = classifyPlay(cards([['5', 1]]));
  const options = enumeratePlayableOptions(hand, target);
  assert.equal(options[0][0].rank, '7');
});

test('三带一优先使用单张而不是拆低位对子', () => {
  const hand = cards([['3', 2], ['7', 3], ['9', 1]]);
  const option = enumeratePlayableOptions(hand).find((play) => classifyPlay(play).type === 'triple_single' && classifyPlay(play).rank === rankValue('7'));
  assert.ok(option.some((card) => card.rank === '9'));
  assert.equal(option.some((card) => card.rank === '3'), false);
});

test('终局规划能算出最少出牌手数', () => {
  const hand = cards([['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1], ['9', 2]]);
  assert.equal(estimateMinimumTurns(hand), 2);
});

test('机器人在小手牌阶段优先选择能缩短整手牌路的方案', () => {
  const hand = cards([['3', 1], ['4', 1], ['5', 1], ['6', 1], ['7', 1], ['9', 2]]);
  const play = chooseAiPlay(hand, null, { currentPlayer: 0, landlord: 0, handSizes: [7, 5, 6] });
  assert.equal(estimateMinimumTurns(hand.filter((card) => !play.some((used) => used.id === card.id))), 1);
});

test('战术推荐优先使用普通牌压制并保留炸弹', () => {
  const hand = cards([['6', 1], ['9', 4], ['K', 1]]);
  const target = classifyPlay(cards([['5', 1]]));
  const recommended = recommendStrategicPlay(hand, target);
  assert.equal(classifyPlay(recommended).type, 'single');
  assert.equal(recommended[0].rank, '6');
});

test('有普通解时过早使用炸弹会被标记为关键问题', () => {
  const hand = cards([['6', 1], ['9', 4], ['K', 1]]);
  const target = classifyPlay(cards([['5', 1]]));
  const bomb = hand.filter((card) => card.rank === '9');
  const analysis = evaluatePlayDecision(hand, target, bomb);
  assert.equal(analysis.tone, 'critical');
  assert.equal(classifyPlay(analysis.recommended).type, 'single');
});

test('拆对子出单张会给出保留结构建议', () => {
  const hand = cards([['6', 2], ['7', 1], ['K', 1]]);
  const target = classifyPlay(cards([['5', 1]]));
  const splitPair = hand.filter((card) => card.rank === '6').slice(0, 1);
  const analysis = evaluatePlayDecision(hand, target, splitPair);
  assert.equal(analysis.tone, 'watch');
  assert.equal(analysis.recommended[0].rank, '7');
});

test('对手报双时有牌可压却不出会被标记为高风险', () => {
  const hand = cards([['6', 1], ['9', 1]]);
  const target = { ...classifyPlay(cards([['5', 1]])), player: 1 };
  const analysis = evaluatePassDecision(hand, target, { currentPlayer: 0, landlord: 0, lastPlayer: 1, handSizes: [2, 2, 5] });
  assert.equal(analysis.tone, 'critical');
  assert.equal(analysis.recommended[0].rank, '6');
});
