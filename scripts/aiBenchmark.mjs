import { analyzeAiDecision, classifyPlay, dealWithSeed, nextPlayerCounterClockwise, removeCards } from '../src/gameLogic.js';

function simulate(seed, levels) {
  const dealt = dealWithSeed(seed);
  const hands = dealt.hands.map((hand, player) => player === 0 ? [...hand, ...dealt.bottom].sort((a, b) => b.value - a.value) : [...hand]);
  const seenCards = [];
  let current = 0;
  let lastPlay = null;
  let lastActor = null;
  let passCount = 0;
  for (let turnSerial = 0; turnSerial < 240; turnSerial += 1) {
    const decision = analyzeAiDecision(hands[current], lastPlay, {
      currentPlayer: current,
      landlord: 0,
      lastPlayer: lastActor,
      handSizes: hands.map((hand) => hand.length),
      seenCards,
      publicCards: dealt.bottom,
      turnSerial,
      difficulty: levels[current],
    });
    if (decision.action === 'play' && decision.cards?.length) {
      const combo = classifyPlay(decision.cards);
      if (!combo) throw new Error(`${levels[current]} produced an invalid play`);
      hands[current] = removeCards(hands[current], decision.cards);
      seenCards.push(...decision.cards);
      lastPlay = { ...combo, cards: decision.cards, player: current };
      lastActor = current;
      passCount = 0;
      if (!hands[current].length) return current;
      current = nextPlayerCounterClockwise(current);
    } else {
      if (!lastPlay) throw new Error(`${levels[current]} passed while holding the lead`);
      passCount += 1;
      if (passCount >= 2) {
        current = lastActor;
        lastPlay = null;
        passCount = 0;
      } else current = nextPlayerCounterClockwise(current);
    }
  }
  throw new Error(`simulation exceeded turn limit for ${seed}`);
}

const pairs = [['super', 'master'], ['master', 'elite'], ['elite', 'normal'], ['normal', 'rookie']];
const seeds = Array.from({ length: 20 }, (_, index) => `ai-benchmark-${index}`);
const rows = [];
const started = performance.now();
for (const [strong, weak] of pairs) {
  let strongWins = 0;
  let strongLandlordWins = 0;
  let strongFarmerWins = 0;
  let matches = 0;
  for (const seed of seeds) {
    const strongLandlordWinner = simulate(`${seed}-landlord`, [strong, weak, weak]);
    strongLandlordWins += strongLandlordWinner === 0 ? 1 : 0;
    strongWins += strongLandlordWinner === 0 ? 1 : 0;
    matches += 1;
    const strongFarmerWinner = simulate(`${seed}-farmer`, [weak, strong, strong]);
    strongFarmerWins += strongFarmerWinner !== 0 ? 1 : 0;
    strongWins += strongFarmerWinner !== 0 ? 1 : 0;
    matches += 1;
  }
  rows.push({
    matchup: `${strong} > ${weak}`,
    landlord: `${strongLandlordWins}/${seeds.length}`,
    farmers: `${strongFarmerWins}/${seeds.length}`,
    strongWins,
    matches,
    rate: `${Math.round(strongWins / matches * 100)}%`,
  });
}
console.table(rows);
console.log(`Completed ${rows.reduce((sum, row) => sum + row.matches, 0)} public-information games in ${Math.round(performance.now() - started)}ms.`);
const minimumRate = 0.55;
const failures = rows.filter((row) => row.strongWins / row.matches < minimumRate);
if (failures.length) {
  console.error(`AI strength gate failed: ${failures.map((row) => `${row.matchup} ${row.rate}`).join(', ')}; expected at least ${Math.round(minimumRate * 100)}%.`);
  process.exitCode = 1;
}
