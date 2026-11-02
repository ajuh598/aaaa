/* AXIOM 모델 파일 읽기/쓰기 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RUNTIME_MODEL = path.join(ROOT, 'js', 'axiom-model.js');
const MODELS_DIR = path.join(__dirname, 'models');

function baselineModel() {
  const AI = require('../js/ai.js');
  return { name: 'AXIOM', version: 'v0', weights: AI.BASELINE_WEIGHTS.slice(), book: {}, note: '손으로 설계한 초기 평가 함수(학습 전 기준선)' };
}

/** 'baseline' | 'current' | 파일 경로(.json / .js) */
function loadModel(spec) {
  if (!spec || spec === 'current') spec = RUNTIME_MODEL;
  if (spec === 'baseline' || spec === 'v0') return baselineModel();
  const p = path.resolve(spec);
  if (p.endsWith('.json')) return JSON.parse(fs.readFileSync(p, 'utf8'));
  delete require.cache[require.resolve(p)];
  return JSON.parse(JSON.stringify(require(p)));
}

function nextVersion(v) {
  const m = /^v(\d+)$/.exec(v || 'v0');
  return 'v' + ((m ? +m[1] : 0) + 1);
}

function saveModelJson(model) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const file = path.join(MODELS_DIR, `axiom-${model.version}.json`);
  fs.writeFileSync(file, JSON.stringify(model, null, 2) + '\n');
  return file;
}

function writeRuntimeModel(model) {
  const body = JSON.stringify(model, null, 2);
  const src = `/*
 * AXIOM 런타임 모델 — 자동 생성 파일입니다. 직접 수정하지 마세요.
 * 생성: node training/train.js --promote  (원본: training/models/axiom-${model.version}.json)
 */
(function (root, model) {
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  else root.AXIOM_MODEL = model;
})(typeof self !== 'undefined' ? self : this, ${body});
`;
  fs.writeFileSync(RUNTIME_MODEL, src);
  return RUNTIME_MODEL;
}

module.exports = { loadModel, baselineModel, nextVersion, saveModelJson, writeRuntimeModel, RUNTIME_MODEL, MODELS_DIR };
