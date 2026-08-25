import { analyzeAiDecision, rankStrategicActions } from './gameLogic';
import { decideWithDouzero } from './douzeroAi';

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};
  try {
    const result = type === 'decision' && payload.context?.difficulty === 'super'
      ? await decideWithDouzero(payload.hand, payload.previous, payload.context)
      : type === 'decision'
        ? analyzeAiDecision(payload.hand, payload.previous, payload.context)
      : rankStrategicActions(payload.hand, payload.previous, payload.context, payload.difficulty || 'super');
    self.postMessage({ id, result });
  } catch (error) {
    try {
      const fallback = type === 'decision'
        ? analyzeAiDecision(payload.hand, payload.previous, payload.context)
        : rankStrategicActions(payload.hand, payload.previous, payload.context, payload.difficulty || 'super');
      self.postMessage({ id, result: { ...fallback, engine: 'heuristic-fallback' } });
    } catch (fallbackError) {
      self.postMessage({ id, error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) });
    }
  }
};
