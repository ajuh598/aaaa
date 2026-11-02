/* AI 연산 전용 Web Worker — 메인 스레드(렌더링)가 끊기지 않도록 탐색을 분리한다. */
/* global OmokAI */
importScripts('rules.js', 'ai.js');

self.onmessage = function (e) {
  const { id, moves, level, rules } = e.data;
  try {
    const r = OmokAI.chooseMove(moves, level, rules);
    self.postMessage({ id, move: r.move, info: r.info });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
