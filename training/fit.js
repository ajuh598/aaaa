/*
 * 평가 함수 가중치 학습 (Texel 방식)
 *   대국 결과 y(둘 차례 기준 승=1, 무=0.5, 패=0)를 sigmoid(k · w·f) 로 예측하도록
 *   평균제곱오차 + L2 정규화(이전 가중치 기준)를 Adam 으로 최소화한다.
 */
'use strict';

const sig = (x) => 1 / (1 + Math.exp(-x));

function dot(w, f) { let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * f[i]; return s; }

function mse(data, w, k) {
  let e = 0;
  for (const d of data) { const p = sig(k * dot(w, d.f)); e += (p - d.y) ** 2; }
  return e / data.length;
}

/** 현재 가중치에서 가장 잘 맞는 스케일 k (로그 공간 황금분할 탐색) */
function fitScale(data, w) {
  let lo = Math.log(1e-6), hi = Math.log(1e-2);
  const g = (Math.sqrt(5) - 1) / 2;
  let a = hi - g * (hi - lo), b = lo + g * (hi - lo);
  let fa = mse(data, w, Math.exp(a)), fb = mse(data, w, Math.exp(b));
  for (let it = 0; it < 60; it++) {
    if (fa < fb) { hi = b; b = a; fb = fa; a = hi - g * (hi - lo); fa = mse(data, w, Math.exp(a)); }
    else { lo = a; a = b; fa = fb; b = lo + g * (hi - lo); fb = mse(data, w, Math.exp(b)); }
  }
  return Math.exp((lo + hi) / 2);
}

function fitWeights(train, val, w0, k, opt) {
  opt = Object.assign({ epochs: 600, lambda: 0.002, lr: 0.01, minScale: 30 }, opt || {});
  const n = w0.length;
  const w = w0.slice(), scale = w0.map((v) => Math.max(Math.abs(v), opt.minScale));
  const m = new Array(n).fill(0), v = new Array(n).fill(0);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  let best = { loss: mse(val, w, k), w: w.slice(), epoch: 0 };
  for (let ep = 1; ep <= opt.epochs; ep++) {
    const g = new Array(n).fill(0);
    for (const d of train) {
      const p = sig(k * dot(w, d.f));
      const c = 2 * (p - d.y) * p * (1 - p) * k;
      for (let i = 0; i < n; i++) g[i] += c * d.f[i];
    }
    for (let i = 0; i < n; i++) {
      // 스케일 정규화된 공간에서의 기울기
      let gi = (g[i] / train.length) * scale[i] + 2 * opt.lambda * (w[i] - w0[i]) / scale[i];
      m[i] = b1 * m[i] + (1 - b1) * gi;
      v[i] = b2 * v[i] + (1 - b2) * gi * gi;
      const mh = m[i] / (1 - b1 ** ep), vh = v[i] / (1 - b2 ** ep);
      w[i] -= opt.lr * scale[i] * mh / (Math.sqrt(vh) + eps);
    }
    if (ep % 10 === 0) {
      const l = mse(val, w, k);
      if (l < best.loss) best = { loss: l, w: w.slice(), epoch: ep };
    }
  }
  return best;
}

module.exports = { fitScale, fitWeights, mse, dot };
