#!/usr/bin/env node
/*
 * 난이도 강도 비교: 현재 난이도 설정 vs 이전(LEGACY) 설정, 같은 AXIOM 모델로 대국
 *   node training/compare-levels.js --levels 1,2,3,4,5 --pairs 20 --time-scale 0.5
 */
'use strict';
const AI = require('../js/ai.js');
const { Pool } = require('./pool.js');
const { randomOpening, makeRng } = require('./selfplay.js');
const { stats } = require('./match.js');

async function main() {
  const o = { levels: '1,2,3,4,5', pairs: 20, 'time-scale': 0.5, seed: 31337 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, '')] = argv[i + 1];
  const scale = +o['time-scale'];
  const rules = { renju: true };
  const w = AI.MODEL.weights;
  const pool = new Pool();
  const scaled = (c) => Object.assign({}, c, { time: Math.round(c.time * scale), vctTime: c.vctTime && Math.round(c.vctTime * scale), defendTime: c.defendTime && Math.round(c.defendTime * scale) });
  for (const lv of String(o.levels).split(',').map(Number)) {
    const rng = makeRng(+o.seed + lv);
    const nw = scaled(AI.LEVELS[lv]), old = scaled(AI.LEGACY_LEVELS[lv]);
    const jobs = [], who = [];
    for (let i = 0; i < +o.pairs; i++) {
      const opening = randomOpening(rng, 3, rules);
      const seed = Math.floor(rng() * 1e9);
      jobs.push({ black: w, white: w, cfgBlack: nw, cfgWhite: old, opening, rules, seed }); who.push(1);
      jobs.push({ black: w, white: w, cfgBlack: old, cfgWhite: nw, opening, rules, seed }); who.push(2);
    }
    const t0 = Date.now();
    const res = await pool.all(jobs);
    let W = 0, L = 0, D = 0, asWhiteW = 0, asWhiteN = 0;
    res.forEach((r, k) => {
      if (who[k] === 2) asWhiteN++;
      if (r.winner === 0) D++;
      else if (r.winner === who[k]) { W++; if (who[k] === 2) asWhiteW++; }
      else L++;
    });
    const m = stats(W, L, D);
    console.log(`Lv${lv} ${AI.LEVELS[lv].name}: 새 설정 ${W}승 ${L}패 ${D}무 (승점 ${(m.score * 100).toFixed(1)}%, Elo ${m.elo >= 0 ? '+' : ''}${m.elo} ±${m.eloErr}) · 백일 때 ${asWhiteW}/${asWhiteN}승 · ${((Date.now() - t0) / 1000).toFixed(0)}초`);
  }
  pool.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
