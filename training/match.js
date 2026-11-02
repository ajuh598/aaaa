/* 두 가중치 간 평가 대국 (같은 오프닝을 흑/백 바꿔 두 판씩) */
'use strict';
const { randomOpening, makeRng } = require('./selfplay.js');

function stats(w, l, d) {
  const n = w + l + d;
  const score = n ? (w + 0.5 * d) / n : 0.5;
  const clamp = Math.min(Math.max(score, 0.001), 0.999);
  const elo = -400 * Math.log10(1 / clamp - 1);
  // 판별 점수의 표준오차 → Elo 95% 구간
  const varPer = n ? (w * (1 - score) ** 2 + l * score ** 2 + d * (0.5 - score) ** 2) / n : 0;
  const se = n ? Math.sqrt(varPer / n) : 0;
  const dElo = 400 / Math.LN10 / (clamp * (1 - clamp));
  const eloErr = 1.96 * se * dElo;
  // 우월할 확률(LOS)
  const los = w + l ? 0.5 * (1 + erf((w - l) / Math.sqrt(2 * (w + l)))) : 0.5;
  return { games: n, wins: w, losses: l, draws: d, score: +score.toFixed(4), elo: Math.round(elo), eloErr: Math.round(eloErr), los: +los.toFixed(4) };
}

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/** A(가중치 a) 관점의 평가 결과 */
async function runMatch(pool, a, b, { pairs, cfg, rules, seed, openingPlies, onProgress }) {
  const rng = makeRng(seed || 777);
  const jobs = [], who = [];
  for (let i = 0; i < pairs; i++) {
    const opening = randomOpening(rng, openingPlies || 4, rules);
    jobs.push({ black: a, white: b, opening, cfg, rules }); who.push(1);
    jobs.push({ black: b, white: a, opening, cfg, rules }); who.push(2);
  }
  const res = await pool.all(jobs, onProgress);
  let w = 0, l = 0, d = 0, blackWins = 0;
  res.forEach((r, k) => {
    if (r.winner === 1) blackWins++;
    if (r.winner === 0) d++;
    else if (r.winner === who[k]) w++;
    else l++;
  });
  return Object.assign(stats(w, l, d), { blackWinRate: +(blackWins / res.length).toFixed(3) });
}

module.exports = { runMatch, stats };
