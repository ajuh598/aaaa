#!/usr/bin/env node
/*
 * 두 AXIOM 모델 평가 대국
 *   node training/evaluate.js --a current --b baseline --pairs 200 --depth 4
 *   (a, b: 'current' | 'baseline' | 모델 파일 경로)
 */
'use strict';
const AI = require('../js/ai.js');
const { Pool } = require('./pool.js');
const { runMatch } = require('./match.js');
const io = require('./model-io.js');

async function main() {
  const o = { a: 'current', b: 'baseline', pairs: 200, depth: 4, seed: 4242 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  const A = io.loadModel(o.a), B = io.loadModel(o.b);
  const pool = new Pool();
  const depth = +o.depth;
  console.log(`${AI.modelLabel(A)} vs ${AI.modelLabel(B)} — ${o.pairs * 2}판, 탐색 깊이 ${depth}, 렌주룰`);
  let last = 0;
  const m = await runMatch(pool, A.weights, B.weights, {
    pairs: +o.pairs, cfg: { mode: 'search', depth, K: depth >= 4 ? 10 : 8, time: 1e9 }, rules: { renju: true }, seed: +o.seed,
    onProgress: (d, n) => { if (Date.now() - last > 2000 || d === n) { last = Date.now(); process.stdout.write(`\r  ${d}/${n}`); } }
  });
  pool.close();
  console.log(`\n${AI.modelLabel(A)}: ${m.wins}승 ${m.losses}패 ${m.draws}무, 점수 ${(m.score * 100).toFixed(1)}%, Elo ${m.elo >= 0 ? '+' : ''}${m.elo} ±${m.eloErr}, LOS ${(m.los * 100).toFixed(1)}%  (흑 승률 ${(m.blackWinRate * 100).toFixed(1)}%)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
