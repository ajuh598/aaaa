/* 학습용 worker_threads 작업자: 한 판씩 자체 대국을 진행한다 */
'use strict';
const { parentPort } = require('worker_threads');
const { playGame } = require('./selfplay.js');

parentPort.on('message', (job) => {
  try {
    const r = playGame(job.args);
    if (!job.args.collect) delete r.positions;
    parentPort.postMessage({ id: job.id, result: r });
  } catch (err) {
    parentPort.postMessage({ id: job.id, error: String(err && err.stack || err) });
  }
});
