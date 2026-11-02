/*
 * 오목 AI 엔진
 *  - 9칸 라인 패턴 룩업 테이블(3^8 = 6561)로 각 빈칸의 공격/수비 형태를 증분 계산
 *  - 위협 기반 후보수 생성(5목 > 열린4 > 열린3 방어 강제)
 *  - Negamax + Alpha-Beta + 반복 심화 + 트랜스포지션 테이블(Zobrist)
 *  - VCF(연속 4로 이기는 수읽기) 공격 / 방어
 * 난이도(1~5)에 따라 탐색 깊이·후보 폭·무작위성·VCF 사용 여부가 달라진다.
 */
(function (root, factory) {
  const R = (typeof module !== 'undefined' && module.exports) ? require('./rules.js') : root.OmokRules;
  const api = factory(R);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OmokAI = api;
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  const N = 15, SIZE = 225, CENTER = 112;
  const DX = [1, 0, 1, 1], DY = [0, 1, 1, -1];

  // 한 방향 형태 코드
  const S_NONE = 0, S_B2 = 1, S_L2 = 2, S_B3 = 3, S_L3 = 4, S_B4 = 5, S_L4 = 6, S_D4 = 7, S_FIVE = 8;
  // 형태별 평가 가중치 (해당 칸에 두었을 때의 잠재력)
  const W = [0, 8, 45, 50, 260, 300, 2600, 2600, 20000];
  // 칸 위협 레벨: 0 없음, 1 열린3, 2 4, 3 삼삼, 4 사삼, 5 열린4/사사, 6 5목
  const LS = [0, 700, 1000, 20000, 40000, 150000, 5000000];

  const WIN = 100000000;
  const WIN_TH = WIN - 1000;
  const INF = WIN * 2;

  // ---------------------------------------------------------------------------
  // 기하 정보 미리 계산
  // ---------------------------------------------------------------------------
  const LINE = new Int16Array(SIZE * 4 * 9);
  const NEIGH = [];
  (function () {
    for (let i = 0; i < SIZE; i++) {
      const x = i % N, y = (i / N) | 0;
      for (let d = 0; d < 4; d++) {
        for (let s = 0; s < 9; s++) {
          const k = s - 4, xx = x + k * DX[d], yy = y + k * DY[d];
          LINE[(i * 4 + d) * 9 + s] = (xx >= 0 && yy >= 0 && xx < N && yy < N) ? yy * N + xx : -1;
        }
      }
      const nb = [];
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < N && yy < N) nb.push(yy * N + xx);
        }
      NEIGH.push(Int16Array.from(nb));
    }
  })();

  // Zobrist
  const Z1 = [null, new Int32Array(SIZE), new Int32Array(SIZE)];
  const Z2 = [null, new Int32Array(SIZE), new Int32Array(SIZE)];
  (function () {
    let s = 0x9E3779B9;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return s | 0; };
    for (let c = 1; c <= 2; c++) for (let i = 0; i < SIZE; i++) { Z1[c][i] = rnd(); Z2[c][i] = rnd(); }
  })();

  // ---------------------------------------------------------------------------
  // 패턴 테이블: 9칸(가운데가 자기 돌) 라인 → 형태 코드
  //   칸 값: 0 빈칸, 1 자기 돌, 2 상대 돌/벽
  // ---------------------------------------------------------------------------
  const tables = {};

  function getTable(exact) {
    const key = exact ? 'exact' : 'free';
    if (!tables[key]) tables[key] = buildTable(exact);
    return tables[key];
  }

  function buildTable(exact) {
    const T = new Uint8Array(6561);
    const line = new Int8Array(9);
    for (let id = 0; id < 6561; id++) {
      let v = id;
      for (let s = 0; s < 8; s++) { line[s < 4 ? s : s + 1] = v % 3; v = (v / 3) | 0; }
      line[4] = 1;
      T[id] = classify(line, exact);
    }
    return T;
  }

  function centerRun(line) {
    let s = 4, e = 4;
    while (s > 0 && line[s - 1] === 1) s--;
    while (e < 8 && line[e + 1] === 1) e++;
    return e - s + 1;
  }

  function isFive(line, exact) {
    const r = centerRun(line);
    return exact ? r === 5 : r >= 5;
  }

  // 0 없음, 1 막힌4, 2 열린4, 3 한줄 사사
  function fourType(line, exact) {
    const pts = [];
    for (let j = 0; j < 9; j++) {
      if (line[j] !== 0) continue;
      line[j] = 1;
      if (isFive(line, exact)) pts.push(j);
      line[j] = 0;
    }
    if (pts.length === 0) return 0;
    if (pts.length === 1) return 1;
    if (pts.length === 2 && pts[1] - pts[0] === 5) return 2;
    return 3;
  }

  // 0 없음, 1 닫힌3, 2 열린3
  function threeType(line, exact) {
    let best = 0;
    for (let j = 0; j < 9; j++) {
      if (line[j] !== 0) continue;
      line[j] = 1;
      if (!isFive(line, exact) && centerRun(line) <= 4) {
        const g = fourType(line, exact);
        if (g >= 2) best = 2;
        else if (g === 1 && best < 1) best = 1;
      }
      line[j] = 0;
      if (best === 2) break;
    }
    return best;
  }

  function classify(line, exact) {
    if (isFive(line, exact)) return S_FIVE;
    if (centerRun(line) >= 5) return S_NONE; // 장목(5목으로 인정 안 됨)
    const f = fourType(line, exact);
    if (f === 2) return S_L4;
    if (f === 3) return S_D4;
    if (f === 1) return S_B4;
    const t = threeType(line, exact);
    if (t === 2) return S_L3;
    if (t === 1) return S_B3;
    let two = 0;
    for (let j = 0; j < 9; j++) {
      if (line[j] !== 0) continue;
      line[j] = 1;
      if (centerRun(line) <= 4) {
        const g = threeType(line, exact);
        if (g > two) two = g;
      }
      line[j] = 0;
      if (two === 2) break;
    }
    return two === 2 ? S_L2 : two === 1 ? S_B2 : S_NONE;
  }

  class Abort extends Error {}
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // ---------------------------------------------------------------------------
  // 엔진
  // ---------------------------------------------------------------------------
  class Engine {
    constructor(rules) {
      rules = rules || {};
      this.renju = !!rules.renju;
      this.allowOverline = !!rules.allowOverline;
      const blackExact = this.renju || !this.allowOverline;
      const whiteExact = this.renju ? false : !this.allowOverline;
      this.tab = [null, getTable(blackExact), getTable(whiteExact)];
      this.free = getTable(false);

      this.board = new Int8Array(SIZE);
      this.shape = [null, new Uint8Array(SIZE * 4), new Uint8Array(SIZE * 4)];
      this.level = [null, new Uint8Array(SIZE), new Uint8Array(SIZE)];
      this.ceval = [null, new Int32Array(SIZE), new Int32Array(SIZE)];
      this.cnt = [null, new Int32Array(7), new Int32Array(7)];
      this.total = [0, 0, 0];
      this.forb = new Uint8Array(SIZE);
      this.overDir = new Uint8Array(SIZE);
      this.nb = new Uint8Array(SIZE);
      this.stack = [];
      this.h1 = 0; this.h2 = 0;
      this.tt = new Map();
      this.nodes = 0;
      this.deadline = Infinity;
      this.maxPly = 30;

      for (let i = 0; i < SIZE; i++) for (let d = 0; d < 4; d++) this.computeShape(i, d);
      for (let i = 0; i < SIZE; i++) this.addCell(i);
    }

    get count() { return this.stack.length; }

    computeShape(i, d) {
      const b = this.board, base = (i * 4 + d) * 9;
      let id1 = 0, id2 = 0, mul = 1;
      for (let s = 0; s < 9; s++) {
        if (s === 4) continue;
        const j = LINE[base + s];
        let v1, v2;
        if (j < 0) { v1 = 2; v2 = 2; }
        else {
          const c = b[j];
          if (c === 0) { v1 = 0; v2 = 0; } else if (c === 1) { v1 = 1; v2 = 2; } else { v1 = 2; v2 = 1; }
        }
        id1 += v1 * mul; id2 += v2 * mul; mul *= 3;
      }
      const k = i * 4 + d;
      this.shape[1][k] = this.tab[1][id1];
      this.shape[2][k] = this.tab[2][id2];
      if (this.renju) {
        if (this.free[id1] === S_FIVE && this.tab[1][id1] !== S_FIVE) this.overDir[i] |= (1 << d);
        else this.overDir[i] &= ~(1 << d);
      }
    }

    computeCell(i, c) {
      if (this.board[i] !== 0) { this.level[c][i] = 0; this.ceval[c][i] = 0; return; }
      const sh = this.shape[c];
      let five = 0, l4 = 0, d4 = 0, b4 = 0, l3 = 0, ev = 0;
      for (let d = 0; d < 4; d++) {
        const s = sh[i * 4 + d];
        ev += W[s];
        if (s === S_FIVE) five++;
        else if (s === S_L4) l4++;
        else if (s === S_D4) d4++;
        else if (s === S_B4) b4++;
        else if (s === S_L3) l3++;
      }
      const fours = l4 + b4 + 2 * d4;
      let lv = five ? 6 : (l4 || fours >= 2) ? 5 : (fours && l3) ? 4 : (l3 >= 2) ? 3 : fours ? 2 : l3 ? 1 : 0;
      if (c === 1 && this.renju) {
        let fb = 0;
        if (!five && (this.overDir[i] || fours >= 2 || l3 >= 2)) {
          fb = R.forbiddenType(this.board, i, 2) ? 1 : 0;
        }
        this.forb[i] = fb;
        if (fb) { lv = 0; ev = 0; }
      }
      if (lv === 4) ev += 3000; else if (lv === 3) ev += 1500;
      this.level[c][i] = lv;
      this.ceval[c][i] = ev;
    }

    addCell(i) {
      for (let c = 1; c <= 2; c++) {
        this.computeCell(i, c);
        if (this.board[i] === 0) {
          this.total[c] += this.ceval[c][i];
          this.cnt[c][this.level[c][i]]++;
        }
      }
    }

    removeCell(i) {
      if (this.board[i] !== 0) return;
      for (let c = 1; c <= 2; c++) {
        this.total[c] -= this.ceval[c][i];
        this.cnt[c][this.level[c][i]]--;
      }
    }

    updateAround(i) {
      for (let d = 0; d < 4; d++) {
        const base = (i * 4 + d) * 9;
        for (let s = 0; s < 9; s++) {
          if (s === 4) continue;
          const j = LINE[base + s];
          if (j < 0 || this.board[j] !== 0) continue;
          this.removeCell(j);
          this.computeShape(j, d);
          this.addCell(j);
        }
      }
    }

    make(i, c) {
      this.removeCell(i);
      this.board[i] = c;
      this.level[1][i] = 0; this.level[2][i] = 0;
      this.ceval[1][i] = 0; this.ceval[2][i] = 0;
      this.forb[i] = 0;
      this.h1 ^= Z1[c][i]; this.h2 ^= Z2[c][i];
      const nb = NEIGH[i];
      for (let k = 0; k < nb.length; k++) this.nb[nb[k]]++;
      this.stack.push(i);
      this.updateAround(i);
    }

    unmake() {
      const i = this.stack.pop();
      const c = this.board[i];
      this.board[i] = 0;
      this.h1 ^= Z1[c][i]; this.h2 ^= Z2[c][i];
      const nb = NEIGH[i];
      for (let k = 0; k < nb.length; k++) this.nb[nb[k]]--;
      for (let d = 0; d < 4; d++) this.computeShape(i, d);
      this.addCell(i);
      this.updateAround(i);
    }

    hasFour(p, i) {
      const sh = this.shape[p];
      for (let d = 0; d < 4; d++) { const s = sh[i * 4 + d]; if (s >= S_B4) return true; }
      return false;
    }

    findLevel(p, lv) {
      const b = this.board, L = this.level[p];
      for (let i = 0; i < SIZE; i++) if (b[i] === 0 && L[i] === lv && !(p === 1 && this.forb[i])) return i;
      return -1;
    }

    orderScore(p, i) {
      const o = 3 - p;
      return LS[this.level[p][i]] + this.ceval[p][i] + 0.85 * (LS[this.level[o][i]] + this.ceval[o][i]);
    }

    /** 후보수 생성 (위협 상황이면 강제수만) */
    genMoves(p, K) {
      const o = 3 - p, b = this.board, lp = this.level[p], lo = this.level[o];
      if (this.count === 0) return [CENTER];
      if (this.cnt[p][6] > 0) { const m = this.findLevel(p, 6); if (m >= 0) return [m]; }
      if (this.cnt[o][6] > 0) {
        const r = [];
        for (let i = 0; i < SIZE; i++)
          if (b[i] === 0 && lo[i] === 6 && !(p === 1 && this.forb[i])) r.push(i);
        return r; // 비어 있으면 막을 수 없음(패배)
      }
      if (this.cnt[p][5] > 0) { const m = this.findLevel(p, 5); if (m >= 0) return [m]; }

      const defending = this.cnt[o][5] > 0;
      const limit = defending ? Math.max(K, 14) : K;
      const mv = new Int16Array(limit), sc = new Float64Array(limit);
      let n = 0;
      for (let i = 0; i < SIZE; i++) {
        if (b[i] !== 0 || this.nb[i] === 0) continue;
        if (p === 1 && this.forb[i]) continue;
        if (defending && lp[i] < 2 && lo[i] < 2) continue;
        const s = this.orderScore(p, i);
        if (n === limit && s <= sc[n - 1]) continue;
        let j = n < limit ? n++ : n - 1;
        while (j > 0 && sc[j - 1] < s) { sc[j] = sc[j - 1]; mv[j] = mv[j - 1]; j--; }
        sc[j] = s; mv[j] = i;
      }
      return Array.from(mv.subarray(0, n));
    }

    evaluate(p, ply) {
      const o = 3 - p;
      if (this.cnt[p][6] > 0) return WIN - ply - 1;
      if (this.cnt[o][6] >= 2) return -(WIN - ply - 2);
      if (this.cnt[o][6] === 0 && this.cnt[p][5] > 0) {
        const oFours = this.cnt[o][2] + this.cnt[o][4] + this.cnt[o][5];
        if (oFours === 0) return WIN - ply - 3;
        return this.total[p] - this.total[o] + 30000;
      }
      return this.total[p] - this.total[o] + 150; // 둘 차례인 쪽의 템포 보너스
    }

    key() { return (this.h1 >>> 0) * 2097152 + (this.h2 & 0x1FFFFF); }

    search(p, depth, alpha, beta, ply) {
      this.nodes++;
      if ((this.nodes & 1023) === 0 && now() > this.deadline) throw new Abort();
      if (this.count >= SIZE) return 0;

      const key = this.key() * 2 + (p - 1);
      const e = this.tt.get(key);
      let ttMove = -1;
      if (e) {
        ttMove = e.m;
        if (e.d >= depth) {
          let s = e.s;
          if (s > WIN_TH) s -= ply; else if (s < -WIN_TH) s += ply;
          if (e.f === 0) return s;
          if (e.f === 1 && s >= beta) return s;
          if (e.f === 2 && s <= alpha) return s;
        }
      }
      if (depth <= 0 || ply >= this.maxPly) return this.evaluate(p, ply);

      const moves = this.genMoves(p, this.K);
      if (moves.length === 0) return -(WIN - ply);
      if (ttMove >= 0) {
        const k = moves.indexOf(ttMove);
        if (k > 0) { moves.splice(k, 1); moves.unshift(ttMove); }
      }
      const forced = moves.length === 1;
      const nd = forced ? depth : depth - 1; // 강제수는 깊이를 소모하지 않음

      const a0 = alpha;
      let best = -INF, bestM = moves[0];
      for (let k = 0; k < moves.length; k++) {
        const m = moves[k];
        let s;
        if (this.level[p][m] === 6) s = WIN - ply - 1;
        else {
          this.make(m, p);
          s = -this.search(3 - p, nd, -beta, -alpha, ply + 1);
          this.unmake();
        }
        if (s > best) { best = s; bestM = m; }
        if (s > alpha) alpha = s;
        if (alpha >= beta) break;
      }

      let ts = best;
      if (ts > WIN_TH) ts += ply; else if (ts < -WIN_TH) ts -= ply;
      if (this.tt.size > 1500000) this.tt.clear();
      this.tt.set(key, { d: depth, s: ts, f: best <= a0 ? 2 : best >= beta ? 1 : 0, m: bestM });
      return best;
    }

    // -------------------------------------------------------------------------
    // VCF: 4를 연속으로 두어 이기는 수순 탐색. 성공하면 첫 수, 아니면 -1
    // -------------------------------------------------------------------------
    vcf(p, maxDepth, nodeLimit) {
      this.vcfNodes = 0;
      this.vcfLimit = nodeLimit || 20000;
      this.vcfFail = new Map();
      const base = this.count;
      try {
        return this._vcf(p, maxDepth);
      } catch (err) {
        if (!(err instanceof Abort)) throw err;
        while (this.count > base) this.unmake();
        return -1;
      }
    }

    _vcf(p, depth) {
      const o = 3 - p, b = this.board;
      if (this.cnt[p][6] > 0) { const m = this.findLevel(p, 6); if (m >= 0) return m; }
      if (depth <= 0) return -1;
      if (++this.vcfNodes > this.vcfLimit) return -1;
      if ((this.vcfNodes & 255) === 0 && now() > this.deadline) throw new Abort();

      const key = this.key() * 2 + (p - 1);
      const failed = this.vcfFail.get(key);
      if (failed !== undefined && failed >= depth) return -1;

      let cands = [];
      if (this.cnt[o][6] > 0) {
        const blocks = [];
        for (let i = 0; i < SIZE; i++) if (b[i] === 0 && this.level[o][i] === 6) blocks.push(i);
        if (blocks.length !== 1) { this.vcfFail.set(key, depth); return -1; }
        const c = blocks[0];
        if ((p === 1 && this.forb[c]) || !this.hasFour(p, c)) { this.vcfFail.set(key, depth); return -1; }
        cands.push(c);
      } else {
        for (let i = 0; i < SIZE; i++) {
          if (b[i] !== 0 || this.nb[i] === 0) continue;
          if (p === 1 && this.forb[i]) continue;
          if (this.hasFour(p, i)) cands.push(i);
        }
        cands.sort((a, c) => this.level[p][c] - this.level[p][a] || this.ceval[p][c] - this.ceval[p][a]);
      }

      for (const c of cands) {
        this.make(c, p);
        let result = -1;
        if (this.cnt[o][6] === 0) {
          // 상대는 내 5목 자리를 막아야 한다
          const fives = [];
          for (let i = 0; i < SIZE && fives.length < 2; i++)
            if (b[i] === 0 && this.level[p][i] === 6) fives.push(i);
          if (fives.length >= 2) result = c;
          else if (fives.length === 1) {
            const d = fives[0];
            if (o === 1 && this.forb[d]) result = c; // 흑이 금수라 막을 수 없음
            else {
              this.make(d, o);
              if (this._vcf(p, depth - 1) >= 0) result = c;
              this.unmake();
            }
          }
        }
        this.unmake();
        if (result >= 0) return result;
      }
      this.vcfFail.set(key, depth);
      return -1;
    }

    // -------------------------------------------------------------------------
    // 루트 탐색 (반복 심화)
    // -------------------------------------------------------------------------
    rootSearch(p, cfg, moves) {
      const o = 3 - p;
      this.K = cfg.K;
      let best = moves[0], bestScore = -INF, depthDone = 0;
      let order = moves.slice();
      let scores = new Map();
      const start = now();
      for (let depth = 1; depth <= cfg.depth; depth++) {
        const base = this.count;
        try {
          let alpha = -INF, iterBest = order[0], iterScore = -INF;
          const sc = new Map();
          for (const m of order) {
            let s;
            if (this.level[p][m] === 6) s = WIN - 1;
            else {
              this.make(m, p);
              s = -this.search(o, depth - 1, -INF, cfg.exactRoot ? INF : -alpha, 1);
              this.unmake();
            }
            sc.set(m, s);
            if (s > iterScore) { iterScore = s; iterBest = m; }
            if (s > alpha) alpha = s;
          }
          best = iterBest; bestScore = iterScore; depthDone = depth; scores = sc;
          order = order.slice().sort((a, c) => sc.get(c) - sc.get(a));
          if (iterScore > WIN_TH || iterScore < -WIN_TH) break;
        } catch (err) {
          if (!(err instanceof Abort)) throw err;
          while (this.count > base) this.unmake();
          break;
        }
        const el = now() - start;
        if (el > cfg.time * 0.45) break;
      }
      return { best, bestScore, depthDone, order, scores };
    }

    think(p, cfg, rng) {
      rng = rng || Math.random;
      const t0 = now();
      this.nodes = 0;
      this.deadline = t0 + cfg.time;
      const o = 3 - p;
      const info = { depth: 0, nodes: 0, score: 0, vcf: false, time: 0 };
      const done = (m) => { info.nodes = this.nodes; info.time = Math.round(now() - t0); return { move: m, info }; };

      if (this.count === 0) return done(CENTER);

      if (cfg.mode === 'greedy') return done(this.greedy(p, cfg, rng));

      const moves = this.genMoves(p, cfg.rootK || cfg.K);
      if (moves.length === 0) return done(this.anyMove(p));
      if (moves.length === 1) return done(moves[0]);

      // 수읽기: 연속 4로 이기는 길
      if (cfg.vcf) {
        const v = this.vcf(p, cfg.vcf, cfg.vcfNodes);
        if (v >= 0) { info.vcf = true; return done(v); }
      }

      const res = this.rootSearch(p, cfg, moves);
      info.depth = res.depthDone;
      info.score = res.bestScore;
      let move = res.best;

      // 난이도용 무작위성 (보통)
      if (cfg.noise && res.bestScore < WIN_TH && res.bestScore > -WIN_TH) {
        let bestNoisy = -INF;
        for (const m of res.order) {
          const s = res.scores.get(m);
          if (s === undefined || s < -WIN_TH) continue;
          const ns = s + (rng() * 2 - 1) * cfg.noise;
          if (ns > bestNoisy) { bestNoisy = ns; move = m; }
        }
        if (cfg.blunder && rng() < cfg.blunder) {
          const ok = res.order.filter(m => { const s = res.scores.get(m); return s !== undefined && s > -WIN_TH; });
          if (ok.length > 1) move = ok[1 + Math.floor(rng() * Math.min(2, ok.length - 1))];
        }
      }

      // 상대 VCF 방어: 고른 수 이후 상대가 연속 4로 이기면 다른 후보를 검토
      if (cfg.defendVcf && res.bestScore < WIN_TH) {
        this.deadline = Math.max(this.deadline, now() + 800);
        const tryList = [move].concat(res.order.filter(m => m !== move)).slice(0, cfg.defendTries || 6);
        for (const m of tryList) {
          const s = res.scores.get(m);
          if (s !== undefined && s < -WIN_TH && m !== move) continue;
          this.make(m, p);
          const threat = this.vcf(o, cfg.defendVcf, cfg.vcfNodes ? Math.floor(cfg.vcfNodes / 4) : 4000);
          this.unmake();
          if (threat < 0) { move = m; break; }
        }
      }
      return done(move);
    }

    /** 쉬움: 1수 앞 평가 + 무작위성, 방어를 자주 놓친다 */
    greedy(p, cfg, rng) {
      const o = 3 - p, b = this.board;
      const winMove = this.findLevel(p, 6);
      if (winMove >= 0 && rng() > cfg.missWin) return winMove;
      const blockMove = this.findLevel(o, 6);
      if (blockMove >= 0 && rng() > cfg.missBlock && !(p === 1 && this.forb[blockMove])) return blockMove;

      const defW = rng() < cfg.missDefense ? 0.05 : 0.6;
      const list = [];
      for (let i = 0; i < SIZE; i++) {
        if (b[i] !== 0 || this.nb[i] === 0) continue;
        if (p === 1 && this.forb[i]) continue;
        const a = LS[this.level[p][i]] * 0.02 + this.ceval[p][i];
        const d = LS[this.level[o][i]] * 0.02 + this.ceval[o][i];
        list.push({ i, s: (a + defW * d + 5) * (0.5 + rng()) });
      }
      if (!list.length) return this.anyMove(p);
      list.sort((x, y) => y.s - x.s);
      const top = Math.min(list.length, cfg.top || 3);
      return list[Math.floor(rng() * top)].i;
    }

    anyMove(p) {
      let best = -1, bs = -1;
      for (let i = 0; i < SIZE; i++) {
        if (this.board[i] !== 0) continue;
        if (p === 1 && this.renju && R.forbiddenType(this.board, i)) continue;
        const x = i % N, y = (i / N) | 0;
        const s = this.nb[i] * 10 - Math.abs(x - 7) - Math.abs(y - 7);
        if (s > bs) { bs = s; best = i; }
      }
      return best;
    }
  }

  // ---------------------------------------------------------------------------
  // 난이도 설정
  // ---------------------------------------------------------------------------
  const LEVELS = {
    1: { name: '쉬움', mode: 'greedy', missWin: 0.15, missBlock: 0.45, missDefense: 0.5, top: 4, time: 300 },
    2: { name: '보통', mode: 'search', depth: 2, K: 8, time: 700, exactRoot: true, noise: 400, blunder: 0.15 },
    3: { name: '어려움', mode: 'search', depth: 4, K: 10, time: 1500 },
    4: { name: '매우 어려움', mode: 'search', depth: 6, K: 10, rootK: 14, time: 2500, vcf: 12, vcfNodes: 15000, defendVcf: 10, defendTries: 5 },
    5: { name: '익스트림', mode: 'search', depth: 12, K: 12, rootK: 18, time: 4000, vcf: 24, vcfNodes: 60000, defendVcf: 16, defendTries: 8 }
  };

  /** moves: 지금까지의 착수(칸 인덱스) 순서. 흑부터 번갈아 둔 것으로 본다. */
  function chooseMove(moves, level, rules, opts) {
    opts = opts || {};
    const eng = new Engine(rules);
    for (let k = 0; k < moves.length; k++) eng.make(moves[k], k % 2 === 0 ? 1 : 2);
    const p = moves.length % 2 === 0 ? 1 : 2;
    const cfg = Object.assign({}, LEVELS[level] || LEVELS[3], opts.override || {});
    const r = eng.think(p, cfg, opts.rng);
    if (r.move < 0 || eng.board[r.move] !== 0) r.move = eng.anyMove(p);
    return r;
  }

  return { Engine, LEVELS, chooseMove, WIN, _getTable: getTable, S: { S_NONE, S_B2, S_L2, S_B3, S_L3, S_B4, S_L4, S_D4, S_FIVE } };
});
