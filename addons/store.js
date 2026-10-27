// What the user chose for each add-on, kept in userData/addons-state.json:
// the ones turned off (an add-on found is on unless turned off), the
// consents given (protocol 10.3, addons/consent.js) and the add-on folders
// the user registered by picking their manifest.json. No Electron: main.js
// gives the file.
const fs = require('fs');
const path = require('path');

function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

class AddonStore {
  constructor(file) {
    this.file = file;
    this.state = { disabled: [], consents: {}, registered: [] };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (saved && Array.isArray(saved.disabled)) this.state.disabled = saved.disabled.filter((id) => typeof id === 'string');
      if (saved && saved.consents && typeof saved.consents === 'object') this.state.consents = saved.consents;
      if (saved && Array.isArray(saved.registered)) this.state.registered = saved.registered.filter((d) => typeof d === 'string');
    } catch (err) {
      /* none yet, or unreadable: everything on */
    }
  }

  isEnabled(id) {
    return !this.state.disabled.includes(id);
  }

  setEnabled(id, enabled) {
    const disabled = new Set(this.state.disabled);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.state.disabled = [...disabled].sort();
    this.save();
  }

  // Registered add-on folders, in the order they were added.
  registered() {
    return [...this.state.registered];
  }

  // false when the folder is there already (by path, ignoring case on
  // Windows).
  addRegistered(dir) {
    const full = path.resolve(dir);
    if (this.state.registered.some((d) => samePath(d, full))) return false;
    this.state.registered.push(full);
    this.save();
    return true;
  }

  removeRegistered(dir) {
    const before = this.state.registered.length;
    this.state.registered = this.state.registered.filter((d) => !samePath(d, dir));
    if (this.state.registered.length !== before) this.save();
    return this.state.registered.length !== before;
  }

  consentOf(id) {
    return this.state.consents[id] || null;
  }

  // record: consentScope(manifest) — { version, permissions, hosts,
  // executables }.
  recordConsent(id, record) {
    this.state.consents[id] = { ...record, consentedAt: new Date().toISOString() };
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}

module.exports = { AddonStore };
