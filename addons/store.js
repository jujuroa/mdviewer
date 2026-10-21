// What the user chose for each add-on, kept in userData/addons-state.json:
// for now just the ones turned off (an add-on found is on unless turned
// off). No Electron: main.js gives the file.
const fs = require('fs');
const path = require('path');

class AddonStore {
  constructor(file) {
    this.file = file;
    this.state = { disabled: [] };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (saved && Array.isArray(saved.disabled)) this.state.disabled = saved.disabled.filter((id) => typeof id === 'string');
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
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
}

module.exports = { AddonStore };
