// What the user chose for each add-on, kept in userData/addons-state.json:
// the ones turned off (an add-on found is on unless turned off) and the
// consents given (protocol 10.3, addons/consent.js). No Electron: main.js
// gives the file.
const fs = require('fs');
const path = require('path');

class AddonStore {
  constructor(file) {
    this.file = file;
    this.state = { disabled: [], consents: {} };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (saved && Array.isArray(saved.disabled)) this.state.disabled = saved.disabled.filter((id) => typeof id === 'string');
      if (saved && saved.consents && typeof saved.consents === 'object') this.state.consents = saved.consents;
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
