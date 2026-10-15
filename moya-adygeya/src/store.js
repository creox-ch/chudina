'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EMPTY = {
  partners: [],
  guests: [],
  transactions: [],
  settlements: [],
  campaigns: [],
  items: [],
  orders: [],
  news: [],
  places: [],
  audio: [],
  feedback: [],
  admins: [],
  outbox: [],
  meta: {},
};

// Простое файловое хранилище: весь набор в памяти, запись через временный файл и rename.
// Node однопоточен, а обработчики синхронные, поэтому каждый запрос атомарен.
class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = fs.existsSync(file) ? { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : structuredClone(EMPTY);
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get isEmpty() {
    return this.data.partners.length === 0 && this.data.guests.length === 0 && this.data.news.length === 0;
  }
}

module.exports = { Store };
