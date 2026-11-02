/*
 * 오목 규칙 엔진 (승패 판정 + 렌주룰 금수 판정)
 * 브라우저(메인 스레드 / Web Worker)와 Node(테스트) 양쪽에서 동작한다.
 *
 * 보드 표현: 길이 225(15×15)의 1차원 배열, idx = y * 15 + x
 *   0 = 빈칸, 1 = 흑, 2 = 백
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OmokRules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const N = 15;
  const SIZE = N * N;
  const EMPTY = 0, BLACK = 1, WHITE = 2;
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  const FORBIDDEN = { NONE: 0, DOUBLE_THREE: 1, DOUBLE_FOUR: 2, OVERLINE: 3 };
  const FORBIDDEN_LABEL = {
    1: '삼삼(3-3) 금수입니다!',
    2: '사사(4-4) 금수입니다!',
    3: '장목(6목 이상) 금수입니다!'
  };

  function inside(x, y) {
    return x >= 0 && y >= 0 && x < N && y < N;
  }

  /** idx 의 돌을 포함해 (dx,dy) 방향으로 연속된 같은 색 돌의 개수 */
  function runLength(b, idx, color, dx, dy) {
    const x0 = idx % N, y0 = (idx / N) | 0;
    let n = 1;
    let x = x0 + dx, y = y0 + dy;
    while (inside(x, y) && b[y * N + x] === color) { n++; x += dx; y += dy; }
    x = x0 - dx; y = y0 - dy;
    while (inside(x, y) && b[y * N + x] === color) { n++; x -= dx; y -= dy; }
    return n;
  }

  /** 6목 이상이 승리로 인정되는지 */
  function overlineWins(color, rules) {
    if (rules.renju) return color === WHITE; // 렌주: 흑 장목은 금수, 백 장목은 승리
    return !!rules.allowOverline;
  }

  /**
   * idx 에 color 돌이 이미 놓여 있을 때, 그 수로 승리했는지 확인한다.
   * 승리했다면 승리 라인(칸 인덱스 배열)을, 아니면 null 을 돌려준다.
   */
  function winningLine(b, idx, color, rules) {
    const x0 = idx % N, y0 = (idx / N) | 0;
    for (const [dx, dy] of DIRS) {
      const n = runLength(b, idx, color, dx, dy);
      if (n === 5 || (n > 5 && overlineWins(color, rules))) {
        let x = x0, y = y0;
        while (inside(x - dx, y - dy) && b[(y - dy) * N + (x - dx)] === color) { x -= dx; y -= dy; }
        const line = [];
        for (let k = 0; k < n; k++) line.push((y + k * dy) * N + (x + k * dx));
        return line;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 렌주룰 금수 판정 (흑 전용)
  // ---------------------------------------------------------------------------

  /** 흑돌이 idx 에 놓인 상태에서, 한 수를 더 두면 정확히 5목이 되는 지점(방향 오프셋) 목록 */
  function fivePointsDir(b, idx, dx, dy) {
    const x0 = idx % N, y0 = (idx / N) | 0;
    const pts = [];
    for (let k = -4; k <= 4; k++) {
      if (k === 0) continue;
      const x = x0 + k * dx, y = y0 + k * dy;
      if (!inside(x, y)) continue;
      const j = y * N + x;
      if (b[j] !== EMPTY) continue;
      b[j] = BLACK;
      if (runLength(b, idx, BLACK, dx, dy) === 5) pts.push(k);
      b[j] = EMPTY;
    }
    return pts;
  }

  /** 해당 방향에서 idx 를 포함하는 4의 개수 (열린 4 = 1, 한 줄 4-4 = 2) */
  function foursInDir(b, idx, dx, dy) {
    const p = fivePointsDir(b, idx, dx, dy);
    if (p.length === 0) return 0;
    if (p.length === 2 && p[1] - p[0] === 5) return 1; // 열린 4 (.XXXX.)
    return Math.min(p.length, 2);
  }

  /** 해당 방향이 '열린 4(양쪽으로 5를 만들 수 있는 4)'인지 */
  function isStraightFour(b, idx, dx, dy) {
    const p = fivePointsDir(b, idx, dx, dy);
    for (let i = 0; i < p.length; i++)
      for (let j = i + 1; j < p.length; j++)
        if (p[j] - p[i] === 5) return true;
    return false;
  }

  /** 해당 방향이 진짜 '열린 3' 인지 (열린 4를 만드는 수가 금수가 아닐 것) */
  function isOpenThreeDir(b, idx, dx, dy, depth, maxDepth) {
    const x0 = idx % N, y0 = (idx / N) | 0;
    for (let k = -4; k <= 4; k++) {
      if (k === 0) continue;
      const x = x0 + k * dx, y = y0 + k * dy;
      if (!inside(x, y)) continue;
      const j = y * N + x;
      if (b[j] !== EMPTY) continue;
      b[j] = BLACK;
      let ok = false;
      if (runLength(b, idx, BLACK, dx, dy) <= 4 && isStraightFour(b, idx, dx, dy)) {
        ok = depth >= maxDepth ? true : forbiddenPlaced(b, j, depth + 1, maxDepth) === FORBIDDEN.NONE;
      }
      b[j] = EMPTY;
      if (ok) return true;
    }
    return false;
  }

  /** 흑돌이 이미 idx 에 놓여 있다고 보고 금수 종류를 판정 */
  function forbiddenPlaced(b, idx, depth, maxDepth) {
    let five = false, over = false;
    for (const [dx, dy] of DIRS) {
      const n = runLength(b, idx, BLACK, dx, dy);
      if (n === 5) five = true;
      else if (n > 5) over = true;
    }
    if (five) return FORBIDDEN.NONE; // 정확한 5목은 금수보다 우선(승리)
    if (over) return FORBIDDEN.OVERLINE;

    let fours = 0, threes = 0;
    for (const [dx, dy] of DIRS) {
      const f = foursInDir(b, idx, dx, dy);
      if (f > 0) fours += f;
      else if (isOpenThreeDir(b, idx, dx, dy, depth, maxDepth)) threes++;
    }
    if (fours >= 2) return FORBIDDEN.DOUBLE_FOUR;
    if (threes >= 2) return FORBIDDEN.DOUBLE_THREE;
    return FORBIDDEN.NONE;
  }

  /**
   * 빈칸 idx 에 흑이 둘 때의 금수 종류 (0 = 금수 아님).
   * maxDepth: 열린 3 판정 시 재귀 금수 검사의 최대 깊이.
   */
  function forbiddenType(b, idx, maxDepth) {
    if (b[idx] !== EMPTY) return FORBIDDEN.NONE;
    b[idx] = BLACK;
    const r = forbiddenPlaced(b, idx, 0, maxDepth == null ? 3 : maxDepth);
    b[idx] = EMPTY;
    return r;
  }

  /** 렌주룰 사용 시 현재 판에서 흑의 모든 금수 지점 */
  function allForbidden(b) {
    const out = [];
    for (let i = 0; i < SIZE; i++) {
      if (b[i] !== EMPTY) continue;
      // 빠른 사전 필터: 주변(같은 줄 ±4)에 흑돌이 충분히 있어야 금수가 될 수 있음
      if (!maybeForbidden(b, i)) continue;
      const t = forbiddenType(b, i);
      if (t) out.push({ idx: i, type: t });
    }
    return out;
  }

  function maybeForbidden(b, idx) {
    const x0 = idx % N, y0 = (idx / N) | 0;
    let busy = 0;
    for (const [dx, dy] of DIRS) {
      let c = 0;
      for (let k = -4; k <= 4; k++) {
        if (k === 0) continue;
        const x = x0 + k * dx, y = y0 + k * dy;
        if (inside(x, y) && b[y * N + x] === BLACK) c++;
      }
      if (c >= 4) return true;
      if (c >= 2) busy++;
    }
    return busy >= 2;
  }

  /** color 가 한 수에 5목을 완성할 수 있는 빈칸들 */
  function fiveThreats(b, color, rules) {
    const out = [];
    for (let i = 0; i < SIZE; i++) {
      if (b[i] !== EMPTY) continue;
      b[i] = color;
      if (winningLine(b, i, color, rules)) out.push(i);
      b[i] = EMPTY;
    }
    return out;
  }

  return {
    N, SIZE, EMPTY, BLACK, WHITE, DIRS, FORBIDDEN, FORBIDDEN_LABEL,
    runLength, winningLine, forbiddenType, allForbidden, maybeForbidden, fiveThreats
  };
});
