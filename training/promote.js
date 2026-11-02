#!/usr/bin/env node
/* 학습된 모델 파일을 게임에 적용:  node training/promote.js training/models/axiom-v2.json */
'use strict';
const io = require('./model-io.js');
const file = process.argv[2];
if (!file) { console.error('사용법: node training/promote.js <모델.json>'); process.exit(1); }
const model = io.loadModel(file);
io.writeRuntimeModel(model);
console.log(`게임에 ${model.name}-${model.version} 적용 완료 → js/axiom-model.js`);
