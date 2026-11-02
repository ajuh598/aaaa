#!/usr/bin/env node
/*
 * AXIOM 학습 파이프라인
 *
 *   1) 자체 대국: 현재 챔피언 가중치로 스스로 대국하며(초반 무작위 탐험 포함) 국면과 결과를 모은다.
 *      --human 으로 내보낸 실제 플레이어 대국 기록도 학습 데이터/오프닝 북에 더한다.
 *   2) 학습: 국면 특징 → 최종 승패를 예측하도록 평가 가중치를 회귀(Texel 방식)로 조정한다.
 *   3) 평가: 후보 vs 챔피언을 같은 오프닝으로 흑/백 바꿔 대국한다(순차 검정).
 *      일정 판수씩 추가하며 우월할 확률(LOS)이 기준 이상이면 채택, 확실히 아니면 기각.
 *      채택되면 챔피언 교체. 이를 세대(generation)만큼 반복.
 *   4) 최종 모델을 출발 모델(부모)과 다시 대국해 공식 평가 결과를 기록하고
 *      training/models/axiom-<버전>.json 으로 저장. --promote 시 게임에 바로 적용(js/axiom-model.js).
 *
 * 사용 예:
 *   node training/train.js                         # 현재 모델 → 다음 버전 후보 생성
 *   node training/train.js --promote               # 통과 시 게임에 적용
 *   node training/train.js --human axiom-games.json --promote
 *   node training/train.js --base baseline --version v1 --gens 4 --promote
 */
'use strict';
const fs = require('fs');
const path = require('path');
const AI = require('../js/ai.js');
const { Pool } = require('./pool.js');
const { randomOpening, makeRng } = require('./selfplay.js');
const { runMatch, stats } = require('./match.js');
const { fitScale, fitWeights, mse } = require('./fit.js');
const io = require('./model-io.js');

function parseArgs(argv) {
  const a = {
    base: 'current', version: null, gens: 4, games: 3000, pairs: 250, maxPairs: 1500, finalPairs: 800,
    dataDepth: 3, gateDepth: 3, evalDepth: 4, los: 0.95, promote: false, human: [], seed: 20261102, workers: 0, keepGens: 3
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, ''), v = argv[i + 1];
    switch (k) {
      case 'base': a.base = v; i++; break;
      case 'version': a.version = v; i++; break;
      case 'gens': a.gens = +v; i++; break;
      case 'games': a.games = +v; i++; break;
      case 'pairs': a.pairs = +v; i++; break;
      case 'max-pairs': a.maxPairs = +v; i++; break;
      case 'gate-depth': a.gateDepth = +v; i++; break;
      case 'final-pairs': a.finalPairs = +v; i++; break;
      case 'data-depth': a.dataDepth = +v; i++; break;
      case 'eval-depth': a.evalDepth = +v; i++; break;
      case 'los': a.los = +v; i++; break;
      case 'seed': a.seed = +v; i++; break;
      case 'workers': a.workers = +v; i++; break;
      case 'human': a.human.push(...v.split(',')); i++; break;
      case 'promote': a.promote = true; break;
      default: throw new Error('알 수 없는 옵션: ' + argv[i]);
    }
  }
  return a;
}

const RULES = { renju: true }; // 게임 기본 룰(렌주)로 학습
const searchCfg = (depth) => ({ mode: 'search', depth, K: depth >= 4 ? 10 : 8, time: 1e9 });
const label = (winner, p) => (winner === 0 ? 0.5 : winner === p ? 1 : 0);
const fmtW = (w) => w.map((x) => Math.round(x));
const fmtMatch = (m) => `${m.wins}승 ${m.losses}패 ${m.draws}무, 점수 ${(m.score * 100).toFixed(1)}%, Elo ${m.elo >= 0 ? '+' : ''}${m.elo} ±${m.eloErr}, LOS ${(m.los * 100).toFixed(1)}%`;

/** 순차 검정: pairs 씩 추가 대국하며 결론이 날 때까지 (최대 maxPairs) */
async function gate(pool, cand, champ, args, rng) {
  let w = 0, l = 0, d = 0, pairs = 0, m = null;
  while (pairs < args.maxPairs) {
    const r = await runMatch(pool, cand, champ, {
      pairs: args.pairs, cfg: searchCfg(args.gateDepth), rules: RULES, seed: Math.floor(rng() * 1e9), onProgress: progress('평가 대국')
    });
    w += r.wins; l += r.losses; d += r.draws; pairs += args.pairs;
    m = stats(w, l, d);
    console.log(`  └ ${pairs * 2}판: ${fmtMatch(m)}`);
    if (m.los >= args.los) return Object.assign(m, { accepted: true });
    if (pairs >= 2 * args.pairs && m.los <= 0.3) break; // 더 해봐야 통과 가능성 낮음
  }
  return Object.assign(m, { accepted: m.los >= args.los });
}

function progress(tag) {
  let last = 0;
  return (d, n) => {
    const now = Date.now();
    if (d === n || now - last > 2000) { last = now; process.stdout.write(`\r  ${tag} ${d}/${n}   `); if (d === n) process.stdout.write('\n'); }
  };
}

/** 내보낸 플레이어 대국 기록 → (회귀 데이터, 경험 항목) */
function loadHumanGames(files) {
  const data = [], exp = [];
  let games = 0;
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const g of (j.games || [])) {
      if (!Array.isArray(g.moves) || g.moves.length < 5) continue;
      const rules = g.rules || RULES;
      if (!rules.renju) continue; // 현재 학습은 렌주룰 기준
      const aiColor = g.aiColor || 2, playerColor = 3 - aiColor;
      const winner = g.result === 'w' ? playerColor : g.result === 'l' ? aiColor : 0;
      const aiResult = winner === 0 ? 'd' : winner === aiColor ? 'w' : 'l';
      exp.push(...AI.experienceFromGame(g.moves, rules, aiColor, aiResult, 20));
      const e = new AI.Engine(rules);
      g.moves.forEach((m, k) => {
        const p = k % 2 === 0 ? 1 : 2;
        if (k >= 4 && e.isQuiet(p)) data.push({ f: e.features(p), y: label(winner, p) });
        e.make(m, p);
      });
      games++;
    }
  }
  return { data, exp, games };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = io.loadModel(args.base);
  const version = args.version || io.nextVersion(base.version);
  const pool = new Pool(args.workers || undefined);
  const rng = makeRng(args.seed);
  const t0 = Date.now();

  console.log(`AXIOM 학습 시작: ${AI.modelLabel(base)} → AXIOM-${version}  (작업자 ${pool.size}개)`);
  const human = loadHumanGames(args.human);
  if (args.human.length) console.log(`플레이어 대국 ${human.games}판, 학습 국면 ${human.data.length}개, 경험 ${human.exp.length}개`);

  let champion = base.weights.slice();
  const history = [];
  const dataWindow = [];
  let totalSelfPlay = 0, totalPositions = 0, evalGames = 0;

  for (let gen = 1; gen <= args.gens; gen++) {
    console.log(`\n[세대 ${gen}/${args.gens}]`);
    // 1) 자체 대국
    const jobs = [];
    for (let g = 0; g < args.games; g++) {
      jobs.push({
        black: champion, white: champion, rules: RULES, cfg: searchCfg(args.dataDepth),
        opening: randomOpening(rng, 2 + Math.floor(rng() * 4), RULES),
        explore: { plies: 14, eps: 0.25 }, collect: true, seed: Math.floor(rng() * 1e9)
      });
    }
    const games = await pool.all(jobs, progress('자체 대국'));
    const genData = [];
    const outcome = [0, 0, 0];
    for (const r of games) {
      outcome[r.winner]++;
      for (const pos of r.positions) genData.push({ f: pos.f, y: label(r.winner, pos.p) });
    }
    totalSelfPlay += games.length;
    totalPositions += genData.length;
    dataWindow.push(genData);
    while (dataWindow.length > args.keepGens) dataWindow.shift();
    console.log(`  결과 흑 ${outcome[1]} / 백 ${outcome[2]} / 무 ${outcome[0]},  국면 ${genData.length}개`);

    // 2) 학습
    const all = [].concat(...dataWindow, human.data);
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    const nVal = Math.floor(all.length * 0.1);
    const val = all.slice(0, nVal), train = all.slice(nVal);
    const k = fitScale(train, champion);
    const before = mse(val, champion, k);
    const fit = fitWeights(train, val, champion, k);
    const candidate = fit.w;
    console.log(`  학습: 검증 오차 ${before.toFixed(5)} → ${fit.loss.toFixed(5)} (k=${k.toExponential(2)}, epoch ${fit.epoch})`);

    // 3) 평가 대국 (순차 검정)
    const m = await gate(pool, candidate, champion, args, rng);
    evalGames += m.games;
    const accepted = m.accepted && m.score > 0.5;
    console.log(`  후보 vs 챔피언 → ${accepted ? '채택' : '기각'}`);
    history.push({ gen, selfPlayGames: games.length, positions: genData.length, valLossBefore: +before.toFixed(5), valLossAfter: +fit.loss.toFixed(5), match: m, accepted, weights: fmtW(candidate) });
    if (accepted) champion = candidate;
  }

  // 4) 최종 평가: 최종 챔피언 vs 출발 모델
  const improved = champion.some((v, i) => v !== base.weights[i]);
  let final = null;
  if (improved) {
    console.log(`\n[최종 평가] AXIOM-${version} vs ${AI.modelLabel(base)}`);
    final = await runMatch(pool, champion, base.weights, {
      pairs: args.finalPairs, cfg: searchCfg(args.evalDepth), rules: RULES, seed: args.seed + 1, onProgress: progress('최종 평가')
    });
    evalGames += final.games;
    console.log(`  ${fmtMatch(final)}`);
  }
  pool.close();

  const passed = improved && final && final.los >= args.los && final.score > 0.5;
  const book = AI.addExperience(JSON.parse(JSON.stringify(base.book || {})), human.exp);
  const prevTraining = base.training || { selfPlayGames: 0, positions: 0, humanGames: 0, evalGames: 0 };
  const model = {
    name: 'AXIOM',
    version,
    parent: AI.modelLabel(base),
    createdAt: new Date().toISOString(),
    features: AI.FEATURE_NAMES,
    weights: fmtW(champion),
    training: {
      // 누적 학습량 (부모 모델까지 포함)
      selfPlayGames: prevTraining.selfPlayGames + totalSelfPlay,
      positions: prevTraining.positions + totalPositions,
      humanGames: (prevTraining.humanGames || 0) + human.games,
      evalGames: (prevTraining.evalGames || 0) + evalGames,
      generations: (prevTraining.generations || 0) + args.gens,
      thisRun: { selfPlayGames: totalSelfPlay, positions: totalPositions, humanGames: human.games, evalGames, minutes: +((Date.now() - t0) / 60000).toFixed(1), dataDepth: args.dataDepth, gateDepth: args.gateDepth, evalDepth: args.evalDepth }
    },
    evaluation: final ? Object.assign({ opponent: AI.modelLabel(base), rules: 'renju', depth: args.evalDepth }, final) : (base.evaluation || null),
    history: (base.history || []).concat([{ version, parent: AI.modelLabel(base), createdAt: new Date().toISOString(), passed: !!passed, evaluation: final }]),
    book
  };
  const file = io.saveModelJson(model);
  const logDir = path.join(__dirname, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `train-${version}.json`), JSON.stringify({ args, history, final }, null, 2) + '\n');
  console.log(`\n모델 저장: ${path.relative(process.cwd(), file)}`);
  console.log(`가중치: ${JSON.stringify(model.weights)}`);

  if (!passed) {
    console.log('결과: 출발 모델보다 유의미하게 강해지지 않아 게임에 적용하지 않습니다.');
  } else if (args.promote) {
    io.writeRuntimeModel(model);
    console.log(`결과: 평가 통과 → 게임에 AXIOM-${version} 적용 (js/axiom-model.js)`);
  } else {
    console.log(`결과: 평가 통과. 게임에 적용하려면 --promote 를 붙여 다시 실행하거나 아래를 실행하세요:\n  node training/promote.js ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
