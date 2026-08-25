import * as ort from 'onnxruntime-web/wasm';
import { classifyPlay } from './gameLogic.js';
import { buildDouzeroLegalActions, buildDouzeroObservation, protectRocketOnLead } from './douzeroFeatures.js';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

const appRoot = new URL('../', self.location.href);
const MODEL_URLS = Object.freeze(Object.fromEntries(['landlord', 'landlord_up', 'landlord_down']
  .map((role) => [role, new URL(`models/douzero-wp/${role}.onnx`, appRoot).href])));
const sessions = new Map();

async function getSession(role) {
  if (!sessions.has(role)) {
    const promise = ort.InferenceSession.create(MODEL_URLS[role], {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }).catch((error) => {
      sessions.delete(role);
      throw error;
    });
    sessions.set(role, promise);
  }
  return sessions.get(role);
}

function describeDecision(action, value, optionCount) {
  if (action.action === 'pass') return `DouZero 综合 ${optionCount} 条牌路后选择让牌，保留本方后续控制力`;
  const combo = classifyPlay(action.cards);
  const valueText = Number.isFinite(value) ? `，胜势值 ${value.toFixed(2)}` : '';
  return `DouZero 对 ${optionCount} 种合法出法逐一评估${valueText}，优先选择当前长期收益最高的${combo?.type ? '牌路' : '出法'}`;
}

export async function decideWithDouzero(hand, previous, context = {}) {
  let actions = buildDouzeroLegalActions(hand, previous);
  actions = protectRocketOnLead(hand, previous, actions);
  const observation = buildDouzeroObservation(hand, previous, context, actions);
  const session = await getSession(observation.role);
  const feeds = {
    z: new ort.Tensor('float32', observation.z, [actions.length, 5, 162]),
    x: new ort.Tensor('float32', observation.x, [actions.length, observation.featureSize]),
  };
  const outputs = await session.run(feeds);
  const values = Array.from(outputs.values?.data || Object.values(outputs)[0]?.data || []);
  if (values.length !== actions.length) throw new Error('DouZero 模型返回的动作评分数量不正确');
  const ranked = actions.map((action, index) => ({ ...action, value: Number(values[index]) }))
    .sort((actionA, actionB) => actionB.value - actionA.value);
  const chosen = ranked[0];
  return {
    action: chosen.action,
    cards: chosen.cards,
    reason: describeDecision(chosen, chosen.value, actions.length),
    difficulty: 'super',
    engine: 'douzero-wp',
    value: chosen.value,
    alternatives: ranked.slice(0, 3).map((candidate, index) => ({
      ...candidate,
      combo: candidate.action === 'play' ? classifyPlay(candidate.cards) : null,
      grade: index === 0 ? '首选' : index === 1 ? '稳健' : '备选',
    })),
  };
}
