// Add-on API calls (protocol 8): every `mdviewerAddon.<area>.<action>(params)`
// arrives here as `<area>/<action>` with the caller main has already told
// apart (addon:call). The router knows each method's permission and
// whether it is experimental, checks them against the caller's add-on, and
// answers with a result or a protocol error (8.5). No Electron here; the
// methods are registered by main.js (addons/api/*.js).

const ERRORS = {
  InvalidParams: -32602,
  InternalError: -32603,
  RequestCancelled: -32800,
  PermissionDenied: -32001,
  NotFound: -32002,
  Conflict: -32003,
  UserCanceled: -32004,
  OutsideProject: -32005,
  NotSupported: -32006,
  TooLarge: -32007,
};

// What a method throws to fail with a protocol error.
class ApiError extends Error {
  constructor(name, message, data) {
    super(message || name);
    this.name = name;
    this.code = ERRORS[name] || ERRORS.InternalError;
    if (data !== undefined) this.data = data;
  }
}

function toWire(err) {
  if (err instanceof ApiError) {
    const out = { code: err.code, name: err.name, message: err.message };
    if (err.data !== undefined) out.data = err.data;
    return out;
  }
  return { code: ERRORS.InternalError, name: 'InternalError', message: 'The host failed to handle the call' };
}

class ApiRouter {
  constructor() {
    this.methods = new Map();
  }

  // spec: { handler(caller, params), permission?: 'documents.read' | ...,
  // experimental?: '<name>' }. caller: { addonId, entry, kind, ... }.
  register(name, spec) {
    this.methods.set(name, spec);
  }

  // The methods this add-on's frames get in their bridge: everything but
  // experimental ones it may not use.
  methodsFor(caller) {
    return [...this.methods.entries()].filter(([, spec]) => this.experimentalOpen(spec, caller)).map(([name]) => name);
  }

  experimentalOpen(spec, caller) {
    if (!spec.experimental) return true;
    return (caller.experimentalApi || []).includes(spec.experimental);
  }

  // Resolves to { ok: true, result } or { ok: false, error } (never
  // rejects), so the error's code and data cross IPC intact.
  async call(caller, method, params) {
    const spec = typeof method === 'string' ? this.methods.get(method) : null;
    try {
      if (!spec || !this.experimentalOpen(spec, caller)) throw new ApiError('NotSupported', `No such method: ${method}`);
      if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
        throw new ApiError('InvalidParams', 'Parameters must be one object');
      }
      const permissions = (caller.entry && caller.entry.manifest && caller.entry.manifest.permissions) || [];
      if (spec.permission && !permissions.includes(spec.permission)) {
        throw new ApiError('PermissionDenied', `${method} needs the "${spec.permission}" permission`);
      }
      const result = await spec.handler(caller, params || {});
      return { ok: true, result: result === undefined ? null : result };
    } catch (err) {
      return { ok: false, error: toWire(err) };
    }
  }
}

module.exports = { ApiRouter, ApiError, ERRORS };
