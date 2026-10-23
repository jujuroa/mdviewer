// Add-on settings (protocol 12.5, 13.8) and secrets (12.6, 13.7), kept in
// userData: addon-settings.json ("<id>.<key>": value) and
// addon-secrets.json ({ id: { key: encrypted, base64 } }). No Electron:
// main.js gives the files and the encryption (safeStorage).
const fs = require('fs');
const path = require('path');

const SECRET_MAX_CHARS = 64 * 1024;

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (err) {
    return {};
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function declaredSettings(manifest) {
  return (manifest.contributes && manifest.contributes.settings) || [];
}

// Whether `value` fits a declared setting: null when it does, else why not.
function settingProblem(setting, value) {
  switch (setting.type) {
    case 'string':
      return typeof value === 'string' ? null : 'must be a string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'enum':
      return (setting.enum || []).includes(value) ? null : `must be one of ${(setting.enum || []).join(', ')}`;
    default:
      return 'unknown type';
  }
}

class AddonSettings {
  constructor(file) {
    this.file = file;
    this.values = readJson(file);
  }

  // One setting's value (its default until set), or all of the add-on's.
  get(entry, key) {
    const out = {};
    for (const s of declaredSettings(entry.manifest)) {
      const stored = this.values[`${entry.id}.${s.key}`];
      out[s.key] = stored !== undefined && !settingProblem(s, stored) ? stored : s.default === undefined ? null : s.default;
    }
    return key === undefined ? out : Object.prototype.hasOwnProperty.call(out, key) ? out[key] : undefined;
  }

  // Throws { reason: 'unknownKey' | 'badValue', message } for what does not fit.
  update(entry, key, value) {
    const setting = declaredSettings(entry.manifest).find((s) => s.key === key);
    if (!setting) throw { reason: 'unknownKey', message: `No setting "${key}" in the manifest` };
    const problem = settingProblem(setting, value);
    if (problem) throw { reason: 'badValue', message: `${key} ${problem}` };
    this.values[`${entry.id}.${key}`] = value;
    writeJson(this.file, this.values);
  }
}

// crypto: { available() -> bool, encrypt(text) -> Buffer, decrypt(Buffer) -> text }
class AddonSecrets {
  constructor(file, crypto) {
    this.file = file;
    this.crypto = crypto;
    this.data = readJson(file);
  }

  available() {
    try {
      return !!this.crypto.available();
    } catch (err) {
      return false;
    }
  }

  get(id, key) {
    const stored = this.data[id] && this.data[id][key];
    if (typeof stored !== 'string' || !this.available()) return null;
    try {
      return this.crypto.decrypt(Buffer.from(stored, 'base64'));
    } catch (err) {
      return null;
    }
  }

  has(id, key) {
    return !!(this.data[id] && typeof this.data[id][key] === 'string');
  }

  // Throws { reason: 'notAvailable' | 'tooLarge' | 'badValue' }.
  set(id, key, value) {
    if (typeof value !== 'string') throw { reason: 'badValue', message: 'value must be a string' };
    if (value.length > SECRET_MAX_CHARS) throw { reason: 'tooLarge', message: 'value is over 64 KiB' };
    if (!this.available()) throw { reason: 'notAvailable', message: 'Encryption is not available' };
    this.data[id] = { ...(this.data[id] || {}), [key]: this.crypto.encrypt(value).toString('base64') };
    writeJson(this.file, this.data);
  }

  delete(id, key) {
    if (!this.data[id] || !(key in this.data[id])) return;
    delete this.data[id][key];
    if (!Object.keys(this.data[id]).length) delete this.data[id];
    writeJson(this.file, this.data);
  }
}

module.exports = { AddonSettings, AddonSecrets, settingProblem };
