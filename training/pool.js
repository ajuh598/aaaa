/* worker_threads 풀 — 자체 대국을 CPU 코어 수만큼 병렬 실행 */
'use strict';
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

class Pool {
  constructor(size) {
    this.size = size || Math.max(1, os.cpus().length);
    this.workers = [];
    this.queue = [];
    this.jobs = new Map();
    this.nextId = 1;
    for (let i = 0; i < this.size; i++) this.spawn();
  }
  spawn() {
    const w = new Worker(path.join(__dirname, 'worker.js'));
    w.busy = false;
    w.on('message', (msg) => {
      const job = this.jobs.get(msg.id);
      this.jobs.delete(msg.id);
      w.busy = false;
      if (msg.error) job.reject(new Error(msg.error)); else job.resolve(msg.result);
      this.pump();
    });
    w.on('error', (err) => { console.error(err); });
    this.workers.push(w);
  }
  pump() {
    for (const w of this.workers) {
      if (w.busy || !this.queue.length) continue;
      const job = this.queue.shift();
      w.busy = true;
      this.jobs.set(job.id, job);
      w.postMessage({ id: job.id, args: job.args });
    }
  }
  run(args) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, args, resolve, reject });
      this.pump();
    });
  }
  /** 작업 목록 실행. onProgress(완료수, 전체) */
  async all(list, onProgress) {
    let done = 0;
    return Promise.all(list.map((a) => this.run(a).then((r) => { done++; if (onProgress) onProgress(done, list.length); return r; })));
  }
  close() { for (const w of this.workers) w.terminate(); }
}

module.exports = { Pool };
