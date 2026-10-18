'use strict';
/** Tiny JSON/JSONL file store under the state dir. No database, no dependencies. */
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }
  file(name) { return path.join(this.dir, name); }
  readJson(name, fallback) {
    const p = this.file(name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  writeJson(name, data) {
    const p = this.file(name);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, p);
  }
  append(name, obj) { fs.appendFileSync(this.file(name), JSON.stringify(obj) + '\n'); }
  readLines(name) {
    const p = this.file(name);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  }
}

let counter = 0;
function newId(prefix) {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

module.exports = { Store, newId };
