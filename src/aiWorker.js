import { analyzeAiDecision, rankStrategicActions } from './gameLogic';

self.onmessage = (event) => {
  const { id, type, payload } = event.data || {};
  try {
    const result = type === 'decision'
      ? analyzeAiDecision(payload.hand, payload.previous, payload.context)
      : rankStrategicActions(payload.hand, payload.previous, payload.context, payload.difficulty || 'super');
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
