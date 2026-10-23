// The extensions log (protocol 16; 17.7: one file per add-on,
// <dir>\<id>.log, turned over at 1 MiB into .1 and .2). Each add-on also
// keeps its latest entries in memory for the log screen. No Electron.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;
const KEEP_FILES = 3;
const MEMORY = 500;

class AddonLog {
  constructor(dir, { maxBytes = MAX_BYTES, keepFiles = KEEP_FILES, memory = MEMORY } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.keepFiles = keepFiles;
    this.memory = memory;
    this.recent = new Map(); // add-on id -> entries, oldest first
    this.listeners = new Set();
  }

  // level: 'info' | 'warn' | 'error' | 'log' (a frame's console).
  add(id, level, message) {
    const entry = { time: new Date().toISOString(), id, level, message: String(message) };
    const list = this.recent.get(id) || [];
    list.push(entry);
    if (list.length > this.memory) list.splice(0, list.length - this.memory);
    this.recent.set(id, list);
    this.write(entry);
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  write(entry) {
    if (!this.dir || !/^[a-z0-9-]+$/.test(entry.id)) return;
    const line = `${entry.time} ${entry.level.toUpperCase()} ${entry.message.replace(/\r?\n/g, '\n  ')}\n`;
    const file = path.join(this.dir, `${entry.id}.log`);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch (err) {
        /* new file */
      }
      if (size && size + Buffer.byteLength(line) > this.maxBytes) this.turnOver(file);
      fs.appendFileSync(file, line);
    } catch (err) {
      /* the log must never break what it logs */
    }
  }

  // <id>.log -> .1 -> .2 ..., the oldest dropped.
  turnOver(file) {
    for (let i = this.keepFiles - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      const to = `${file}.${i}`;
      try {
        if (fs.existsSync(to)) fs.rmSync(to);
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch (err) {
        /* keep going */
      }
    }
  }

  // The latest entries of one add-on, or of all of them in time order.
  entries(id = null) {
    if (id) return [...(this.recent.get(id) || [])];
    return [...this.recent.values()].flat().sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0)).slice(-this.memory);
  }

  onAdd(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

module.exports = { AddonLog };
