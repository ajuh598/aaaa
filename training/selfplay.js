/* AXIOM 자체 대국(self-play) — 오프닝 생성과 한 판 진행 */
'use strict';
const AI = require('../js/ai.js');
const R = require('../js/rules.js');

const N = 15, CENTER = 112;

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** 중앙 근처 무작위 오프닝 (흑 중앙 시작, plies 수만큼) */
function randomOpening(rng, plies, rules) {
  const b = new Int8Array(225), moves = [CENTER];
  b[CENTER] = 1;
  let guard = 0;
  while (moves.length < plies && guard++ < 1000) {
    const r = moves.length <= 2 ? 1 : 2;
    const x = 7 + Math.floor(rng() * (2 * r + 1)) - r;
    const y = 7 + Math.floor(rng() * (2 * r + 1)) - r;
    const i = y * N + x;
    if (b[i]) continue;
    const c = moves.length % 2 === 0 ? 1 : 2;
    if (c === 1 && rules.renju && R.forbiddenType(b, i)) continue;
    b[i] = c;
    if (R.winningLine(b, i, c, rules)) { b[i] = 0; continue; }
    moves.push(i);
  }
  return moves;
}

/**
 * 한 판 진행.
 *  black/white: 가중치 배열
 *  cfg: 탐색 설정 (LEVELS 형식, 고정 깊이 권장)
 *  explore: { plies, eps } — 데이터 수집용 탐험 (초반 plies 수 동안 eps 확률로 상위 3수 중 무작위)
 *  collect: true 이면 조용한 국면의 특징 벡터를 수집
 * 반환: { winner: 0|1|2, moves, positions: [{ f, p }] }
 */
function playGame({ black, white, opening, cfg, cfgBlack, cfgWhite, rules, collect, explore, seed }) {
  const cfgs = [null, cfgBlack || cfg, cfgWhite || cfg];
  const rng = makeRng(seed || 1);
  const eng = [null, new AI.Engine(rules, black), new AI.Engine(rules, white)];
  const moves = [];
  const positions = [];
  const put = (m, c) => { eng[1].make(m, c); eng[2].make(m, c); moves.push(m); };
  for (const m of opening) put(m, moves.length % 2 === 0 ? 1 : 2);

  while (moves.length < 225) {
    const p = moves.length % 2 === 0 ? 1 : 2;
    const e = eng[p];
    if (collect && moves.length >= 4 && e.isQuiet(p)) positions.push({ f: e.features(p), p, ply: moves.length });

    let m;
    if (explore && moves.length < explore.plies && rng() < explore.eps) {
      const cand = e.genMoves(p, 3);
      m = cand.length ? cand[Math.floor(rng() * cand.length)] : e.think(p, cfgs[p], rng).move;
    } else {
      m = e.think(p, cfgs[p], rng).move;
    }
    if (m < 0 || e.board[m] !== 0) return { winner: 3 - p, moves, positions, reason: 'illegal' };
    if (p === 1 && rules.renju && R.forbiddenType(e.board, m)) return { winner: 2, moves, positions, reason: 'forbidden' };
    put(m, p);
    if (R.winningLine(e.board, m, p, rules)) return { winner: p, moves, positions, reason: 'five' };
  }
  return { winner: 0, moves, positions, reason: 'full' };
}

module.exports = { makeRng, randomOpening, playGame };
