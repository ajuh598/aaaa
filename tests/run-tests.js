/* 규칙 엔진 & AI 테스트:  node tests/run-tests.js */
'use strict';
const R = require('../js/rules.js');
const AI = require('../js/ai.js');

const N = 15;
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ ' + msg); }
}
const at = (x, y) => y * N + x;
function boardFrom(rows) {
  // rows: 문자열 배열, 'X' 흑, 'O' 백, '.' 빈칸 (좌상단 기준, 짧으면 나머지는 빈칸)
  const b = new Int8Array(225);
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === 'X') b[at(x, y)] = 1; else if (ch === 'O') b[at(x, y)] = 2; }));
  return b;
}
function place(list) {
  const b = new Int8Array(225);
  for (const [x, y, c] of list) b[at(x, y)] = c;
  return b;
}

console.log('[규칙] 승리 판정');
{
  const b = place([[3, 7, 1], [4, 7, 1], [5, 7, 1], [6, 7, 1], [7, 7, 1]]);
  ok(R.winningLine(b, at(7, 7), 1, { renju: true }), '가로 5목 승리');
  const d = place([[2, 2, 2], [3, 3, 2], [4, 4, 2], [5, 5, 2], [6, 6, 2]]);
  ok(R.winningLine(d, at(4, 4), 2, { renju: true }), '대각선 5목 승리');
  const a = place([[10, 2, 1], [9, 3, 1], [8, 4, 1], [7, 5, 1], [6, 6, 1]]);
  ok(R.winningLine(a, at(6, 6), 1, { renju: false }), '역대각선 5목 승리');
  const six = place([[1, 7, 1], [2, 7, 1], [3, 7, 1], [4, 7, 1], [5, 7, 1], [6, 7, 1]]);
  ok(!R.winningLine(six, at(6, 7), 1, { renju: true }), '렌주: 흑 장목은 승리 아님');
  ok(!R.winningLine(six, at(6, 7), 1, { renju: false, allowOverline: false }), '장목 불허: 6목 승리 아님');
  ok(R.winningLine(six, at(6, 7), 1, { renju: false, allowOverline: true }), '장목 허용: 6목 승리');
  const w6 = place([[1, 7, 2], [2, 7, 2], [3, 7, 2], [4, 7, 2], [5, 7, 2], [6, 7, 2]]);
  ok(R.winningLine(w6, at(6, 7), 2, { renju: true }), '렌주: 백 장목은 승리');
  const four = place([[3, 7, 1], [4, 7, 1], [5, 7, 1], [6, 7, 1]]);
  ok(!R.winningLine(four, at(6, 7), 1, { renju: true }), '4목은 승리 아님');
}

console.log('[규칙] 금수 판정');
{
  // 삼삼: 가로 .XX? 와 세로
  let b = place([[5, 7, 1], [6, 7, 1], [7, 5, 1], [7, 6, 1]]);
  ok(R.forbiddenType(b, at(7, 7)) === R.FORBIDDEN.DOUBLE_THREE, '기본 삼삼 금수');
  // 띈 삼삼
  b = place([[4, 7, 1], [6, 7, 1], [7, 4, 1], [7, 6, 1]]);
  ok(R.forbiddenType(b, at(7, 7)) === R.FORBIDDEN.DOUBLE_THREE, '띈 3(X.XX) 두 개 삼삼 금수');
  b = place([[5, 7, 1], [6, 7, 1], [7, 4, 1], [7, 5, 1]]);
  ok(R.forbiddenType(b, at(7, 7)) === R.FORBIDDEN.DOUBLE_THREE, '띈 3 + 3 삼삼 금수 (세로 XX.?)');
  // 한쪽이 막힌 3 은 열린 3이 아님 → 삼삼 아님
  b = place([[5, 7, 1], [6, 7, 1], [4, 7, 2], [7, 5, 1], [7, 6, 1]]);
  ok(R.forbiddenType(b, at(7, 7)) === R.FORBIDDEN.NONE, '막힌 3 포함 시 삼삼 아님');
  // 사사
  b = place([[4, 7, 1], [5, 7, 1], [6, 7, 1], [7, 4, 1], [7, 5, 1], [7, 6, 1], [3, 7, 2], [7, 3, 2]]);
  ok(R.forbiddenType(b, at(7, 7)) === R.FORBIDDEN.DOUBLE_FOUR, '사사 금수');
  // 한 줄 사사: X.XXX.X → 가운데
  b = place([[3, 7, 1], [5, 7, 1], [6, 7, 1], [9, 7, 1]]);
  // X . X X [7] . X  → 7에 두면 X.XXX.X
  ok(R.forbiddenType(b, at(7, 7)) === R.FORBIDDEN.DOUBLE_FOUR, '한 줄 사사(X.XXX.X) 금수');
  // 장목
  b = place([[2, 7, 1], [3, 7, 1], [4, 7, 1], [6, 7, 1], [7, 7, 1]]);
  ok(R.forbiddenType(b, at(5, 7)) === R.FORBIDDEN.OVERLINE, '장목 금수');
  // 5목 완성은 다른 금수보다 우선
  b = place([[3, 7, 1], [4, 7, 1], [5, 7, 1], [6, 7, 1], [7, 4, 1], [7, 5, 1], [7, 6, 1], [7, 3, 2]]);
  ok(R.forbiddenType(b, at(7, 7)) === R.FORBIDDEN.NONE, '5목 완성은 금수 아님');
  // 사삼은 허용
  b = place([[4, 7, 1], [5, 7, 1], [6, 7, 1], [3, 7, 2], [7, 5, 1], [7, 6, 1]]);
  ok(R.forbiddenType(b, at(7, 7)) === R.FORBIDDEN.NONE, '사삼(4-3)은 허용');
  // 열린 4로 발전하는 자리가 장목이 되는 3은 열린 3이 아님 → 삼삼 아님
  b = place([[5, 7, 1], [6, 7, 1], [7, 5, 1], [7, 6, 1], [9, 7, 1], [10, 7, 1], [11, 7, 1], [4, 7, 2]]);
  // 가로: O X X [7] . X X X  → 7에 두면 OXXX.XXX : 8에 두면 장목 → 열린 3 아님
  ok(R.forbiddenType(b, at(7, 7)) === R.FORBIDDEN.NONE, '장목으로만 이어지는 3은 열린 3 아님');
}

console.log('[AI] 패턴 테이블');
{
  const T = AI._getTable(false), S = AI.S;
  const enc = (s) => { // 9글자, 가운데(4)는 자기 돌로 가정
    let id = 0, mul = 1;
    for (let i = 0; i < 9; i++) { if (i === 4) continue; const c = s[i]; id += (c === '.' ? 0 : c === 'X' ? 1 : 2) * mul; mul *= 3; }
    return id;
  };
  ok(T[enc('..XX?X...'.replace('?', 'X'))] === S.S_L4, '..XXXX... 열린 4');
  ok(T[enc('XXXX?....')] === S.S_FIVE, '5목');
  ok(T[enc('.OXXXX...')] === S.S_B4, '막힌 4');
  ok(T[enc('...X?X...')] === S.S_L3, '열린 3');
  ok(T[enc('..OX?X...')] === S.S_B3, '닫힌 3');
  ok(T[enc('....?X...')] === S.S_L2, '열린 2');
}

console.log('[AI] 기본 전술');
function eng(stones, rules) {
  const e = new AI.Engine(rules || { renju: true });
  for (const [x, y, c] of stones) e.make(at(x, y), c);
  return e;
}
for (const lv of [2, 3, 4, 5]) {
  const cfg = Object.assign({}, AI.LEVELS[lv], { time: 1500 });
  // 백이 둘 차례: 백 4목 완성 기회
  let e = eng([[3, 3, 1], [7, 7, 2], [4, 3, 1], [7, 8, 2], [5, 5, 1], [7, 9, 2], [6, 6, 1], [7, 10, 2], [0, 0, 1]]);
  let r = e.think(2, cfg);
  ok(r.move === at(7, 6) || r.move === at(7, 11), `Lv${lv}: 5목 완성 (${r.move})`);
  // 흑의 4를 막아야 함
  e = eng([[3, 7, 1], [10, 10, 2], [4, 7, 1], [11, 2, 2], [5, 7, 1], [12, 12, 2], [6, 7, 1]]);
  r = e.think(2, cfg);
  ok(r.move === at(7, 7) || r.move === at(2, 7), `Lv${lv}: 4목 방어 (${r.move})`);
  // 흑 열린 3을 막아야 함
  e = eng([[5, 7, 1], [10, 2, 2], [6, 7, 1], [2, 11, 2], [7, 7, 1]]);
  r = e.think(2, cfg);
  ok([at(4, 7), at(8, 7), at(3, 7), at(9, 7)].includes(r.move), `Lv${lv}: 열린 3 방어 (${r.move})`);
}

console.log('[AI] 엔진 증분 일관성');
{
  const e = new AI.Engine({ renju: true });
  const fresh = (mv) => { const f = new AI.Engine({ renju: true }); mv.forEach((m, k) => f.make(m, k % 2 ? 2 : 1)); return f; };
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const mv = [];
  for (let k = 0; k < 40; k++) {
    let m; do { m = Math.floor(rnd() * 225); } while (e.board[m]);
    e.make(m, k % 2 ? 2 : 1); mv.push(m);
  }
  for (let k = 0; k < 15; k++) { e.unmake(); mv.pop(); }
  const f = fresh(mv);
  ok(e.total[1] === f.total[1] && e.total[2] === f.total[2], '증분 평가 합계 일치');
  ok(e.cnt[1].join() === f.cnt[1].join() && e.cnt[2].join() === f.cnt[2].join(), '증분 레벨 카운트 일치');
}

console.log('[AI] VCF');
{
  // 백: 연속 4로 이기는 형태
  const e = eng([[7, 7, 2], [8, 7, 2], [9, 7, 2], [6, 7, 1], [10, 8, 2], [10, 9, 2], [10, 10, 2], [10, 11, 1], [0, 0, 1], [0, 14, 1], [14, 0, 1]]);
  const v = e.vcf(2, 12, 20000);
  ok(v >= 0, 'VCF 발견 (' + v + ')');
}

console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
