/* 웹 오목 마스터 — 화면/입력/렌더링/게임 진행 + AXIOM 경험 학습 */
(function () {
  'use strict';

  const R = window.OmokRules;
  const AX = window.OmokAI;
  const AXIOM = AX.modelLabel(); // 예: AXIOM-v1
  const N = 15, SIZE = 225;
  const MIN_AI_DELAY = 420; // AI 착수 최소 연출 시간(ms)

  const LEVEL_INFO = [null,
    { name: '쉬움', desc: '1수 앞 판단 · 가끔 방어를 놓침 · 입문자' },
    { name: '보통', desc: '3수 앞 수읽기 + 짧은 연속 4 · 기본기 점검' },
    { name: '어려움', desc: '6수 앞 알파베타 + 연속 4 공방 · 수싸움' },
    { name: '매우 어려움', desc: '10수 앞 + 3·4 연속 공격(VCT) 공방 · 상급' },
    { name: '익스트림', desc: '최대 16수 반복 심화 + 깊은 VCF·VCT · 고수' }
  ];

  // ---------------------------------------------------------------------------
  // 저장소
  // ---------------------------------------------------------------------------
  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 불가 환경 */ } }
  };
  const SETTINGS_KEY = 'omok.settings.v1', STATS_KEY = 'omok.stats.v1';
  const settings = Object.assign(
    { level: 2, renju: true, allowOverline: false, showForbidden: true, numbers: false },
    store.get(SETTINGS_KEY, {})
  );
  delete settings.timer; // 제한 시간 기능 제거 (이전 저장값 정리)
  let stats = store.get(STATS_KEY, null);
  if (!stats || typeof stats !== 'object' || !stats.levels) stats = { levels: {}, history: [] };
  const saveSettings = () => store.set(SETTINGS_KEY, settings);
  const saveStats = () => store.set(STATS_KEY, stats);

  // AXIOM 경험(이 브라우저에서 둔 대국에서 배운 국면) & 대국 기록(학습 데이터 내보내기용)
  const EXP_KEY = 'axiom.experience.v1', GAMES_KEY = 'axiom.games.v1';
  const MAX_EXP = 6000, MAX_GAMES = 300;
  let experience = store.get(EXP_KEY, null);
  if (!experience || typeof experience !== 'object') experience = {};
  let gameLog = store.get(GAMES_KEY, null);
  if (!Array.isArray(gameLog)) gameLog = [];

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const el = {
    main: $('screen-main'), game: $('screen-game'),
    levels: $('levels'), start: $('btn-start'), rulesBtn: $('btn-rules'), statsBtn: $('btn-stats'),
    rulesSummary: $('rules-summary'), statsSummary: $('stats-summary'),
    home: $('btn-home'), gameLevel: $('game-level'), gameRules: $('game-rules'),
    pBlack: $('p-black'), pWhite: $('p-white'), aiLevelLabel: $('ai-level-label'), aiName: $('ai-name'),
    axiomBtn: $('btn-axiom'), axiomVersion: $('axiom-version'), axiomSummary: $('axiom-summary'),
    axiomModelInfo: $('axiom-model-info'), axiomLocalInfo: $('axiom-local-info'),
    exportBtn: $('btn-export'), resetExp: $('btn-reset-exp'),
    status: $('status'), wrap: $('board-wrap'), canvas: $('board'),
    moveCount: $('move-count'), aiInfo: $('ai-info'), resign: $('btn-resign'), again: $('btn-again'),
    optRenju: $('opt-renju'), optOverline: $('opt-overline'), optOverlineRow: $('opt-overline-row'),
    optShowForb: $('opt-showforb'), optNumbers: $('opt-numbers'),
    statsBody: $('stats-body'), statsHistory: $('stats-history'), resetStats: $('btn-reset-stats'),
    confirmText: $('confirm-text'), confirmTitle: $('confirm-title'), confirmOk: $('confirm-ok'),
    resultIcon: $('result-icon'), resultTitle: $('result-title'), resultText: $('result-text'),
    resultAgain: $('result-again'), resultReview: $('result-review'), resultHome: $('result-home')
  };
  const ctx = el.canvas.getContext('2d');

  // ---------------------------------------------------------------------------
  // 게임 상태
  // ---------------------------------------------------------------------------
  const game = {
    board: new Int8Array(SIZE), moves: [], turn: 1, over: true, result: null,
    winLine: null, forbidden: [], hover: -1, pending: -1, cursor: 112,
    level: 2, rules: { renju: true, allowOverline: false },
    waiting: null, reqId: 0, aiStart: 0, anim: null
  };

  // ---------------------------------------------------------------------------
  // AI 실행 (Web Worker, 불가하면 메인 스레드)
  // ---------------------------------------------------------------------------
  let worker = null;
  function createWorker() {
    try {
      worker = new Worker('js/ai-worker.js');
      worker.onmessage = onAIMessage;
      worker.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        worker = null; // file:// 등 워커 사용 불가 → 메인 스레드로 전환
        if (game.waiting) runLocal(game.waiting);
      };
    } catch (e) { worker = null; }
  }
  function resetWorker() {
    if (worker && game.waiting) { worker.terminate(); createWorker(); }
    game.waiting = null;
  }
  function requestAI() {
    // 모델 오프닝 북 + 이 브라우저의 경험에서 현재 국면 통계를 찾아 함께 보낸다
    const exp = AX.lookupExperience(game.moves, game.rules, [AX.MODEL.book, experience]);
    const req = { id: ++game.reqId, moves: game.moves.slice(), level: game.level, rules: game.rules, exp };
    game.waiting = req;
    game.aiStart = performance.now();
    if (worker) worker.postMessage(req); else runLocal(req);
  }
  function runLocal(req) {
    setTimeout(() => {
      if (!game.waiting || game.waiting.id !== req.id) return;
      const r = AX.chooseMove(req.moves, req.level, req.rules, { exp: req.exp || null });
      onAIMessage({ data: { id: req.id, move: r.move, info: r.info } });
    }, 40);
  }
  function onAIMessage(e) {
    const d = e.data;
    if (!game.waiting || d.id !== game.waiting.id) return;
    if (d.error) { const req = game.waiting; worker = null; runLocal(req); return; }
    game.waiting = null;
    const wait = Math.max(0, MIN_AI_DELAY - (performance.now() - game.aiStart));
    const id = d.id;
    setTimeout(() => { if (id === game.reqId && !game.over) aiMoved(d.move, d.info); }, wait);
  }

  // ---------------------------------------------------------------------------
  // 진행
  // ---------------------------------------------------------------------------
  function newGame() {
    resetWorker();
    game.board = new Int8Array(SIZE);
    game.moves = [];
    game.turn = 1;
    game.over = false;
    game.result = null;
    game.winLine = null;
    game.forbidden = [];
    game.hover = -1; game.pending = -1; game.cursor = 112;
    game.level = settings.level;
    game.rules = { renju: !!settings.renju, allowOverline: settings.renju ? false : !!settings.allowOverline };
    game.reqId++;

    el.gameLevel.textContent = `Lv.${game.level} ${LEVEL_INFO[game.level].name}`;
    el.aiName.textContent = AXIOM;
    el.aiLevelLabel.textContent = `백 · ${LEVEL_INFO[game.level].name}`;
    el.gameRules.textContent = rulesText(game.rules);
    el.aiInfo.textContent = '';
    el.resign.classList.remove('hidden');
    el.again.classList.add('hidden');
    closeModal('modal-result');
    showScreen('game');
    playerTurn();
  }

  function playerTurn() {
    game.turn = 1;
    game.pending = -1;
    updateForbidden();
    const threats = R.fiveThreats(game.board, 2, game.rules);
    if (threats.length) setStatus('⚠ 백이 4를 만들었습니다! 막아야 합니다', 'warn');
    else setStatus(game.moves.length === 0 ? '플레이어(흑)의 차례입니다 · 첫 수를 두세요' : '플레이어(흑)의 차례입니다');
    updatePanels();
    render();
  }

  function tryPlayerMove(idx) {
    if (game.over || game.turn !== 1 || idx < 0 || game.board[idx]) return false;
    if (game.rules.renju) {
      const f = R.forbiddenType(game.board, idx);
      if (f) { setStatus(R.FORBIDDEN_LABEL[f], 'warn', true); game.pending = -1; render(); return false; }
    }
    place(idx, 1);
    return true;
  }

  function place(idx, color) {
    game.board[idx] = color;
    game.moves.push(idx);
    game.pending = -1;
    game.forbidden = [];
    game.anim = { idx, t0: performance.now() };
    animate();

    const line = R.winningLine(game.board, idx, color, game.rules);
    if (line) {
      game.winLine = line;
      finish(color === 1 ? 'win' : 'lose', color === 1 ? '5목을 완성했습니다!' : `${AXIOM}이 5목을 완성했습니다.`);
      return;
    }
    if (game.moves.length >= SIZE) { finish('draw', '판이 가득 찼습니다.'); return; }

    if (color === 1) {
      game.turn = 2;
      setStatus(`${AXIOM}(백)이 생각 중입니다…`);
      updatePanels();
      render();
      requestAI();
    } else {
      playerTurn();
    }
  }

  function aiMoved(move, info) {
    if (game.over || game.turn !== 2) return;
    if (move < 0 || game.board[move]) { // 안전장치
      move = game.board.findIndex((v) => v === 0);
      if (move < 0) { finish('draw', '판이 가득 찼습니다.'); return; }
    }
    if (info) {
      const t = (info.time / 1000).toFixed(2);
      const parts = [];
      if (info.vcf) parts.push('연속 4 수읽기 성공');
      else if (info.vct) parts.push('3·4 연속 공격 수읽기 성공');
      else if (info.depth && game.level >= 3) parts.push(`탐색 깊이 ${info.depth}`);
      if (info.defended) parts.push('상대 연속 공격 차단');
      if (info.experience) parts.push('지난 대국 경험 반영');
      el.aiInfo.textContent = parts.length ? `${AXIOM} · ${parts.join(' · ')} · ${t}초` : '';
    }
    place(move, 2);
  }

  function finish(result, reason) {
    game.over = true;
    game.result = result;
    game.forbidden = [];
    game.hover = -1; game.pending = -1;
    resetWorker();
    recordResult(result, reason);
    learnFromGame(result, reason);
    updatePanels();
    el.resign.classList.add('hidden');
    el.again.classList.remove('hidden');
    const title = result === 'win' ? '승리!' : result === 'lose' ? '패배' : '무승부';
    setStatus(`${title} — ${reason}`, result === 'win' ? 'good' : result === 'lose' ? 'warn' : '');
    render();
    setTimeout(() => {
      if (!game.over || game.result !== result) return;
      el.resultIcon.textContent = result === 'win' ? '🏆' : result === 'lose' ? '💭' : '🤝';
      el.resultTitle.textContent = title;
      el.resultText.textContent = `${reason} (${game.moves.length}수 · ${AXIOM} ${LEVEL_INFO[game.level].name})`;
      if (el.game.classList.contains('active')) openModal('modal-result');
    }, game.winLine ? 900 : 250);
  }

  function recordResult(result, reason) {
    const k = String(game.level);
    const s = stats.levels[k] || (stats.levels[k] = { w: 0, l: 0, d: 0 });
    const r = result === 'win' ? 'w' : result === 'lose' ? 'l' : 'd';
    s[r]++;
    stats.history.unshift({ t: Date.now(), lv: game.level, r, n: game.moves.length, reason, ai: AXIOM });
    stats.history = stats.history.slice(0, 30);
    saveStats();
    updateMenuSummary();
  }

  // ---------------------------------------------------------------------------
  // AXIOM 경험 학습: 끝난 대국의 AI 수를 결과와 함께 기억해 같은 국면에서 반영
  // ---------------------------------------------------------------------------
  function learnFromGame(result, reason) {
    if (game.moves.length < 2) return;
    const aiResult = result === 'win' ? 'l' : result === 'lose' ? 'w' : 'd';
    AX.addExperience(experience, AX.experienceFromGame(game.moves, game.rules, 2, aiResult, 20));
    const keys = Object.keys(experience);
    for (let i = 0; i < keys.length - MAX_EXP; i++) delete experience[keys[i]]; // 오래된 경험부터 정리
    store.set(EXP_KEY, experience);

    gameLog.push({
      t: Date.now(), ai: AXIOM, level: game.level, rules: game.rules, aiColor: 2,
      moves: game.moves.slice(), result: result === 'win' ? 'w' : result === 'lose' ? 'l' : 'd', reason
    });
    if (gameLog.length > MAX_GAMES) gameLog = gameLog.slice(-MAX_GAMES);
    store.set(GAMES_KEY, gameLog);
  }

  function exportGames() {
    const data = { format: 'axiom-games', version: 1, exportedAt: new Date().toISOString(), ai: AXIOM, games: gameLog };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `axiom-games-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function renderAxiomInfo() {
    const m = AX.MODEL, t = m.training || {}, ev = m.evaluation;
    const rows = [
      ['버전', `${AXIOM}${m.parent ? ` (이전: ${m.parent})` : ''}`],
      ['학습일', m.createdAt ? new Date(m.createdAt).toLocaleDateString('ko-KR') : '—'],
      ['자체 대국 학습', t.selfPlayGames ? `${t.selfPlayGames.toLocaleString()}판 · 국면 ${t.positions.toLocaleString()}개 · ${t.generations}세대` : '학습 전 기준 모델'],
      ['평가 대국', ev ? `${ev.opponent} 상대 ${ev.wins}승 ${ev.losses}패 ${ev.draws}무 (승점 ${(ev.score * 100).toFixed(1)}%, Elo ${ev.elo >= 0 ? '+' : ''}${ev.elo} ±${ev.eloErr})` : '—'],
      ['오프닝 북', `${Object.keys(m.book || {}).length.toLocaleString()}개 국면`]
    ];
    el.axiomModelInfo.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const local = [
      ['기록된 대국', `${gameLog.length}판`],
      ['배운 국면', `${Object.keys(experience).length.toLocaleString()}개`]
    ];
    el.axiomLocalInfo.innerHTML = local.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  // ---------------------------------------------------------------------------
  // UI 보조
  // ---------------------------------------------------------------------------
  function setStatus(text, kind, shake) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' ' + kind : '');
    if (shake) { void el.status.offsetWidth; el.status.classList.add('shake'); }
  }
  function updatePanels() {
    el.pBlack.classList.toggle('active', !game.over && game.turn === 1);
    el.pWhite.classList.toggle('active', !game.over && game.turn === 2);
    el.moveCount.textContent = game.moves.length + '수';
  }
  function updateForbidden() {
    game.forbidden = (game.rules.renju && settings.showForbidden && !game.over) ? R.allForbidden(game.board) : [];
  }
  function rulesText(rules) {
    return rules.renju ? '렌주룰' : (rules.allowOverline ? '자유룰(장목 허용)' : '자유룰(정확히 5목)');
  }
  function showScreen(name) {
    el.main.classList.toggle('active', name === 'main');
    el.game.classList.toggle('active', name === 'game');
    if (name === 'game') requestAnimationFrame(resize);
    else updateMenuSummary();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------------------
  // 메인 화면
  // ---------------------------------------------------------------------------
  function renderLevels() {
    el.levels.innerHTML = '';
    for (let lv = 1; lv <= 5; lv++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'level';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(settings.level === lv));
      b.tabIndex = settings.level === lv ? 0 : -1;
      b.dataset.level = lv;
      b.innerHTML = `<span class="lv-num">${lv}</span>
        <span><b>${LEVEL_INFO[lv].name}</b><small>${LEVEL_INFO[lv].desc}</small></span>
        <span class="dots" aria-hidden="true">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= lv ? 'on' : ''}"></i>`).join('')}</span>`;
      b.addEventListener('click', () => selectLevel(lv));
      b.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); selectLevel(Math.min(5, lv + 1), true); }
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); selectLevel(Math.max(1, lv - 1), true); }
      });
      el.levels.appendChild(b);
    }
  }
  function selectLevel(lv, focus) {
    settings.level = lv;
    saveSettings();
    renderLevels();
    if (focus) el.levels.querySelector(`[data-level="${lv}"]`).focus();
  }
  function updateMenuSummary() {
    el.rulesSummary.textContent = rulesText({ renju: settings.renju, allowOverline: settings.allowOverline });
    const t = AX.MODEL.training;
    el.axiomVersion.textContent = AX.MODEL.version || 'v0';
    el.axiomSummary.textContent = (t && t.selfPlayGames ? `자체 대국 ${t.selfPlayGames.toLocaleString()}판 학습` : '전용 오목 AI') +
      ` · 내 대국에서 배운 국면 ${Object.keys(experience).length.toLocaleString()}개`;
    let w = 0, l = 0, d = 0;
    for (const k in stats.levels) { w += stats.levels[k].w; l += stats.levels[k].l; d += stats.levels[k].d; }
    el.statsSummary.textContent = `${w}승 ${l}패${d ? ' ' + d + '무' : ''}`;
  }

  function syncRuleInputs() {
    el.optRenju.checked = !!settings.renju;
    el.optOverline.checked = settings.renju ? false : !!settings.allowOverline;
    el.optOverline.disabled = !!settings.renju;
    el.optOverlineRow.classList.toggle('disabled', !!settings.renju);
    el.optShowForb.checked = !!settings.showForbidden;
    el.optNumbers.checked = !!settings.numbers;
  }
  function bindRuleInputs() {
    el.optRenju.addEventListener('change', () => { settings.renju = el.optRenju.checked; saveSettings(); syncRuleInputs(); updateMenuSummary(); });
    el.optOverline.addEventListener('change', () => { settings.allowOverline = el.optOverline.checked; saveSettings(); updateMenuSummary(); });
    el.optShowForb.addEventListener('change', () => { settings.showForbidden = el.optShowForb.checked; saveSettings(); });
    el.optNumbers.addEventListener('change', () => { settings.numbers = el.optNumbers.checked; saveSettings(); });
  }

  function renderStats() {
    el.statsBody.innerHTML = '';
    for (let lv = 1; lv <= 5; lv++) {
      const s = stats.levels[lv] || { w: 0, l: 0, d: 0 };
      const total = s.w + s.l + s.d;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${LEVEL_INFO[lv].name}</td><td>${s.w}</td><td>${s.l}</td><td>${s.d}</td><td>${total ? Math.round(s.w / total * 100) + '%' : '-'}</td>`;
      el.statsBody.appendChild(tr);
    }
    el.statsHistory.innerHTML = '';
    if (!stats.history.length) {
      el.statsHistory.innerHTML = '<li class="empty">아직 기록이 없습니다</li>';
      return;
    }
    for (const h of stats.history) {
      const li = document.createElement('li');
      const dt = new Date(h.t);
      const when = `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      const label = h.r === 'w' ? '승' : h.r === 'l' ? '패' : '무';
      li.innerHTML = `<span><span class="r-${h.r}">${label}</span> · ${LEVEL_INFO[h.lv] ? LEVEL_INFO[h.lv].name : ''} · ${h.n}수</span><span>${when}</span>`;
      li.title = h.reason || '';
      el.statsHistory.appendChild(li);
    }
  }

  // ---------------------------------------------------------------------------
  // 모달
  // ---------------------------------------------------------------------------
  let lastFocus = null;
  function openModal(id) {
    const m = $(id);
    lastFocus = document.activeElement;
    m.hidden = false;
    const f = m.querySelector('button.primary, button, select, input');
    if (f) f.focus();
  }
  function closeModal(id) {
    const m = $(id);
    if (m.hidden) return;
    m.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m && m.id !== 'modal-result') closeModal(m.id);
      if (e.target.closest('[data-close]')) closeModal(m.id);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('.modal')].find((m) => !m.hidden);
    if (open) closeModal(open.id);
  });
  let confirmAction = null;
  function confirmDialog(title, text, okLabel, action) {
    el.confirmTitle.textContent = title;
    el.confirmText.textContent = text;
    el.confirmOk.textContent = okLabel;
    confirmAction = action;
    openModal('modal-confirm');
  }
  el.confirmOk.addEventListener('click', () => {
    closeModal('modal-confirm');
    const a = confirmAction; confirmAction = null;
    if (a) a();
  });

  // ---------------------------------------------------------------------------
  // 렌더링
  // ---------------------------------------------------------------------------
  const geo = { size: 0, pad: 0, cell: 0, dpr: 1 };
  const STARS = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];
  const COLS = 'ABCDEFGHJKLMNOP';

  function resize() {
    if (!el.game.classList.contains('active')) return;
    const w = el.wrap.clientWidth;
    const top = el.wrap.getBoundingClientRect().top + window.scrollY;
    const avail = window.innerHeight - top - 64;
    const size = Math.floor(Math.max(280, Math.min(w, avail, 720)));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    geo.size = size; geo.dpr = dpr;
    geo.cell = size / (14 + 2 * 0.95);
    geo.pad = geo.cell * 0.95;
    el.canvas.style.width = size + 'px';
    el.canvas.style.height = size + 'px';
    el.canvas.width = Math.round(size * dpr);
    el.canvas.height = Math.round(size * dpr);
    render();
  }

  const px = (i) => geo.pad + i * geo.cell;

  function drawBoard() {
    const { size, cell } = geo;
    const g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, '#e9c68c');
    g.addColorStop(1, '#d6a564');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    // 나뭇결
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.strokeStyle = '#7a4a17';
    for (let k = 0; k < 26; k++) {
      const y = (k / 26) * size + Math.sin(k * 1.7) * 6;
      ctx.lineWidth = 1 + (k % 3);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(size * 0.3, y + Math.sin(k) * 10, size * 0.7, y - Math.cos(k) * 10, size, y + Math.sin(k * 0.6) * 6);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(55, 35, 12, .8)';
    ctx.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      const p = Math.round(px(i)) + 0.5;
      ctx.beginPath(); ctx.moveTo(Math.round(px(0)) + 0.5, p); ctx.lineTo(Math.round(px(14)) + 0.5, p); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p, Math.round(px(0)) + 0.5); ctx.lineTo(p, Math.round(px(14)) + 0.5); ctx.stroke();
    }
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(px(0)) + 0.5, Math.round(px(0)) + 0.5, Math.round(px(14)) - Math.round(px(0)), Math.round(px(14)) - Math.round(px(0)));
    ctx.fillStyle = 'rgba(55, 35, 12, .9)';
    for (const [x, y] of STARS) { ctx.beginPath(); ctx.arc(px(x), px(y), Math.max(2.5, cell * 0.1), 0, Math.PI * 2); ctx.fill(); }

    if (cell >= 22) {
      ctx.fillStyle = 'rgba(55, 35, 12, .65)';
      ctx.font = `600 ${Math.round(cell * 0.32)}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let i = 0; i < N; i++) {
        ctx.fillText(COLS[i], px(i), geo.pad * 0.42);
        ctx.fillText(String(N - i), geo.pad * 0.42, px(i));
      }
    }
  }

  function drawStone(x, y, color, alpha, scale) {
    const r = geo.cell * 0.46 * (scale || 1);
    const cx = px(x), cy = px(y);
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    if (alpha == null || alpha === 1) {
      ctx.shadowColor = 'rgba(0, 0, 0, .35)';
      ctx.shadowBlur = r * 0.25;
      ctx.shadowOffsetX = r * 0.08;
      ctx.shadowOffsetY = r * 0.12;
    }
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    if (color === 1) { g.addColorStop(0, '#6d6d6d'); g.addColorStop(0.55, '#1a1a1a'); g.addColorStop(1, '#050505'); }
    else { g.addColorStop(0, '#ffffff'); g.addColorStop(0.7, '#ece7dd'); g.addColorStop(1, '#c9c2b4'); }
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    if (color === 2) {
      ctx.save();
      ctx.globalAlpha = alpha == null ? 1 : alpha;
      ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  function drawCross(x, y, size, color, width) {
    const cx = px(x), cy = px(y), s = geo.cell * size;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s); ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s); ctx.stroke();
    ctx.restore();
  }

  function render() {
    if (!geo.size) return;
    ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
    drawBoard();

    // 금수 표시
    for (const f of game.forbidden) drawCross(f.idx % N, (f.idx / N) | 0, 0.17, 'rgba(200, 30, 20, .75)', 2);

    // 돌
    const now = performance.now();
    const last = game.moves.length ? game.moves[game.moves.length - 1] : -1;
    for (let k = 0; k < game.moves.length; k++) {
      const i = game.moves[k];
      let scale = 1;
      if (game.anim && game.anim.idx === i) {
        const t = Math.min(1, (now - game.anim.t0) / 160);
        scale = 0.6 + 0.4 * (1 - Math.pow(1 - t, 3));
      }
      drawStone(i % N, (i / N) | 0, game.board[i], 1, scale);
    }

    // 수순 번호 / 마지막 수 표시
    if (settings.numbers) {
      ctx.font = `600 ${Math.round(geo.cell * 0.36)}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      game.moves.forEach((i, k) => {
        ctx.fillStyle = i === last ? '#e0442b' : (game.board[i] === 1 ? '#f2f2f2' : '#222');
        ctx.fillText(String(k + 1), px(i % N), px((i / N) | 0) + 0.5);
      });
    } else if (last >= 0) {
      ctx.fillStyle = '#e0442b';
      ctx.beginPath(); ctx.arc(px(last % N), px((last / N) | 0), Math.max(3, geo.cell * 0.12), 0, Math.PI * 2); ctx.fill();
    }

    // 승리 라인
    if (game.winLine) {
      const a = game.winLine[0], b = game.winLine[game.winLine.length - 1];
      ctx.save();
      ctx.strokeStyle = 'rgba(224, 68, 43, .85)';
      ctx.lineWidth = Math.max(3, geo.cell * 0.14);
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(px(a % N), px((a / N) | 0)); ctx.lineTo(px(b % N), px((b / N) | 0)); ctx.stroke();
      ctx.restore();
    }

    // 미리보기 (마우스 호버 / 터치 1차 탭 / 키보드 커서)
    if (!game.over && game.turn === 1) {
      const preview = game.pending >= 0 ? game.pending : game.hover;
      if (preview >= 0 && !game.board[preview]) {
        const x = preview % N, y = (preview / N) | 0;
        const forb = game.forbidden.some((f) => f.idx === preview);
        if (forb) drawCross(x, y, 0.28, 'rgba(200, 30, 20, .95)', 3);
        else drawStone(x, y, 1, game.pending >= 0 ? 0.65 : 0.4);
        if (game.pending >= 0) {
          ctx.save();
          ctx.strokeStyle = '#e0442b'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.arc(px(x), px(y), geo.cell * 0.52, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }
      }
    }
  }

  function animate() {
    if (!game.anim) return;
    render();
    if (performance.now() - game.anim.t0 < 170) requestAnimationFrame(animate);
    else { game.anim = null; render(); }
  }

  // ---------------------------------------------------------------------------
  // 입력
  // ---------------------------------------------------------------------------
  function cellAt(e) {
    const rect = el.canvas.getBoundingClientRect();
    const fx = (e.clientX - rect.left - geo.pad) / geo.cell;
    const fy = (e.clientY - rect.top - geo.pad) / geo.cell;
    const x = Math.round(fx), y = Math.round(fy);
    if (x < 0 || y < 0 || x >= N || y >= N) return -1;
    if (Math.abs(fx - x) > 0.5 || Math.abs(fy - y) > 0.5) return -1;
    return y * N + x;
  }

  el.canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const c = cellAt(e);
    if (c !== game.hover) { game.hover = c; render(); }
  });
  el.canvas.addEventListener('pointerleave', () => { if (game.hover !== -1) { game.hover = -1; render(); } });
  el.canvas.addEventListener('pointerup', (e) => {
    if (game.over || game.turn !== 1) return;
    const c = cellAt(e);
    if (c < 0 || game.board[c]) return;
    if (e.pointerType === 'mouse' || e.pointerType === 'pen') { tryPlayerMove(c); return; }
    // 터치: 오착 방지를 위해 같은 자리 두 번 탭으로 착수
    if (game.pending === c) { tryPlayerMove(c); return; }
    if (game.rules.renju) {
      const f = R.forbiddenType(game.board, c);
      if (f) { setStatus(R.FORBIDDEN_LABEL[f], 'warn', true); game.pending = -1; render(); return; }
    }
    game.pending = c;
    setStatus('한 번 더 탭하면 착수합니다');
    render();
  });

  // 키보드: 방향키로 커서 이동, Enter/Space 로 착수
  el.canvas.tabIndex = 0;
  el.canvas.addEventListener('keydown', (e) => {
    if (game.over || game.turn !== 1) return;
    const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    let c = game.hover >= 0 ? game.hover : game.cursor;
    if (map[e.key]) {
      e.preventDefault();
      const x = Math.min(14, Math.max(0, c % N + map[e.key][0]));
      const y = Math.min(14, Math.max(0, ((c / N) | 0) + map[e.key][1]));
      game.cursor = game.hover = y * N + x;
      render();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (game.hover < 0) { game.hover = game.cursor; render(); return; }
      tryPlayerMove(game.hover);
    }
  });
  el.canvas.addEventListener('blur', () => { game.hover = -1; render(); });

  // ---------------------------------------------------------------------------
  // 버튼
  // ---------------------------------------------------------------------------
  el.start.addEventListener('click', newGame);
  el.rulesBtn.addEventListener('click', () => { syncRuleInputs(); openModal('modal-rules'); });
  el.statsBtn.addEventListener('click', () => { renderStats(); openModal('modal-stats'); });
  el.axiomBtn.addEventListener('click', () => { renderAxiomInfo(); openModal('modal-axiom'); });
  el.exportBtn.addEventListener('click', exportGames);
  el.resetExp.addEventListener('click', () => {
    closeModal('modal-axiom');
    confirmDialog('경험 초기화', `${AXIOM}이 이 브라우저의 대국에서 배운 국면과 대국 기록을 모두 지울까요? (모델 자체의 학습은 유지됩니다)`, '초기화', () => {
      experience = {}; gameLog = [];
      store.set(EXP_KEY, experience); store.set(GAMES_KEY, gameLog);
      updateMenuSummary();
    });
  });
  el.resetStats.addEventListener('click', () => {
    closeModal('modal-stats');
    confirmDialog('전적 초기화', '모든 전적과 최근 경기 기록을 삭제할까요?', '초기화', () => {
      stats = { levels: {}, history: [] };
      saveStats();
      updateMenuSummary();
    });
  });

  function goHome() {
    resetWorker();
    closeModal('modal-result');
    showScreen('main');
  }
  el.home.addEventListener('click', () => {
    if (!game.over && game.moves.length > 0) {
      confirmDialog('메인으로', '진행 중인 게임을 포기하고 나갈까요? 패배로 기록됩니다.', '나가기', () => {
        finish('lose', '게임을 포기했습니다.');
        goHome();
      });
    } else {
      game.over = true;
      goHome();
    }
  });
  el.resign.addEventListener('click', () => {
    if (game.over) return;
    confirmDialog('항복', '정말 항복하시겠습니까? 패배로 기록됩니다.', '항복', () => {
      if (!game.over) finish('lose', '항복했습니다.');
    });
  });
  el.again.addEventListener('click', newGame);
  el.resultAgain.addEventListener('click', newGame);
  el.resultReview.addEventListener('click', () => closeModal('modal-result'));
  el.resultHome.addEventListener('click', goHome);

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 150));

  // ---------------------------------------------------------------------------
  // 시작
  // ---------------------------------------------------------------------------
  createWorker();
  renderLevels();
  bindRuleInputs();
  syncRuleInputs();
  updateMenuSummary();
})();
