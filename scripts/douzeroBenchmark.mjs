import * as ort from 'onnxruntime-web';
import { fileURLToPath } from 'node:url';
import {
  analyzeAiDecision,
  classifyPlay,
  dealWithSeed,
  nextPlayerCounterClockwise,
  removeCards,
} from '../src/gameLogic.js';
import { buildDouzeroLegalActions, buildDouzeroObservation, protectRocketOnLead } from '../src/douzeroFeatures.js';

ort.env.wasm.numThreads = 1;
const modelPaths = Object.fromEntries(['landlord', 'landlord_up', 'landlord_down'].map((role) => [
  role,
  fileURLToPath(new URL(`../public/models/douzero-wp/${role}.onnx`, import.meta.url)),
]));
const sessions = new Map();

async function sessionFor(role) {
  if (!sessions.has(role)) sessions.set(role, ort.InferenceSession.create(modelPaths[role], { executionProviders: ['wasm'] }));
  return sessions.get(role);
}

async function neuralDecision(hand, previous, context) {
  let actions = buildDouzeroLegalActions(hand, previous);
  actions = protectRocketOnLead(hand, previous, actions);
  const observation = buildDouzeroObservation(hand, previous, context, actions);
  const session = await sessionFor(observation.role);
  const output = await session.run({
    z: new ort.Tensor('float32', observation.z, [actions.length, 5, 162]),
    x: new ort.Tensor('float32', observation.x, [actions.length, observation.featureSize]),
  });
  const values = output.values.data;
  let best = 0;
  for (let index = 1; index < values.length; index += 1) if (values[index] > values[best]) best = index;
  return actions[best];
}

async function simulate(seed, neuralPlayers) {
  const dealt = dealWithSeed(seed);
  const hands = dealt.hands.map((hand, player) => player === 0 ? [...hand, ...dealt.bottom].sort((a, b) => b.value - a.value) : [...hand]);
  const publicState = {
    seenCards: [], playedByPlayer: [[], [], []], lastMoves: [[], [], []], actionHistory: [], bombCount: 0,
  };
  let current = 0;
  let lastPlay = null;
  let lastActor = null;
  let passCount = 0;
  for (let turnSerial = 0; turnSerial < 240; turnSerial += 1) {
    const context = {
      currentPlayer: current, landlord: 0, lastPlayer: lastActor,
      handSizes: hands.map((hand) => hand.length), publicCards: dealt.bottom,
      passCount, turnSerial, difficulty: 'master', ...publicState,
    };
    const decision = neuralPlayers.has(current)
      ? await neuralDecision(hands[current], lastPlay, context)
      : analyzeAiDecision(hands[current], lastPlay, context);
    if (decision.action === 'play' && decision.cards?.length) {
      const combo = classifyPlay(decision.cards);
      if (!combo) throw new Error(`invalid neural play in ${seed}`);
      hands[current] = removeCards(hands[current], decision.cards);
      publicState.seenCards.push(...decision.cards);
      publicState.playedByPlayer[current].push(...decision.cards);
      publicState.lastMoves[current] = decision.cards;
      publicState.actionHistory.push({ player: current, cards: decision.cards });
      publicState.actionHistory = publicState.actionHistory.slice(-15);
      if (['bomb', 'rocket'].includes(combo.type)) publicState.bombCount += 1;
      lastPlay = { ...combo, cards: decision.cards, player: current };
      lastActor = current;
      passCount = 0;
      if (!hands[current].length) return current;
      current = nextPlayerCounterClockwise(current);
    } else {
      if (!lastPlay) throw new Error(`passed while holding lead in ${seed}`);
      publicState.lastMoves[current] = [];
      publicState.actionHistory.push({ player: current, cards: [] });
      publicState.actionHistory = publicState.actionHistory.slice(-15);
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

const count = Math.max(1, Number(process.env.DOUZERO_BENCHMARK_GAMES) || 20);
const seeds = Array.from({ length: count }, (_, index) => `douzero-benchmark-${index}`);
let landlordWins = 0;
let farmerWins = 0;
const started = performance.now();
for (const seed of seeds) {
  if (await simulate(`${seed}-landlord`, new Set([0])) === 0) landlordWins += 1;
  if (await simulate(`${seed}-farmers`, new Set([1, 2])) !== 0) farmerWins += 1;
}
const wins = landlordWins + farmerWins;
const matches = seeds.length * 2;
console.table([{
  matchup: 'DouZero > master heuristic',
  landlord: `${landlordWins}/${seeds.length}`,
  farmers: `${farmerWins}/${seeds.length}`,
  rate: `${Math.round(wins / matches * 100)}%`,
}]);
console.log(`Completed ${matches} imperfect-information neural games in ${Math.round(performance.now() - started)}ms.`);
if (wins / matches < .55) {
  console.error('DouZero strength gate failed; expected at least 55% against the master heuristic.');
  process.exitCode = 1;
}
