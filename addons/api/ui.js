// The ui area (protocol 13.5): notifications, a pick list, a text input, a
// yes/no question and progress, all drawn by the window page in the
// caller's window. deps:
//   ask(caller, request) -> the page's answer ({ value } or { cancelled })
//   progress(caller, message) — start/report/end on the page
const { ApiError } = require('../api-router.js');

const LEVELS = ['info', 'warning', 'error'];
const MAX_ITEMS = 5000;
const MAX_TEXT = 4000;

function text(value, name, { optional = false, max = MAX_TEXT } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') throw new ApiError('InvalidParams', `${name} must be a string`);
  return value.length > max ? value.slice(0, max) : value;
}

function registerUiApi(router, deps) {
  const progress = new Map(); // token -> { addonId, cancelled, caller }
  let nextToken = 1;

  router.register('ui/notify', {
    handler: async (caller, { level = 'info', message, actions }) => {
      if (!LEVELS.includes(level)) throw new ApiError('InvalidParams', 'level must be info, warning or error');
      if (actions !== undefined && (!Array.isArray(actions) || actions.length > 5 || actions.some((a) => typeof a !== 'string'))) {
        throw new ApiError('InvalidParams', 'actions must be up to 5 strings');
      }
      const answer = await deps.ask(caller, { kind: 'notify', level, message: text(message, 'message'), actions: actions || [] });
      return answer && typeof answer.value === 'string' && (actions || []).includes(answer.value) ? answer.value : null;
    },
  });

  router.register('ui/quickPick', {
    handler: async (caller, { title, items, multi = false, placeholder }) => {
      if (!Array.isArray(items) || items.length > MAX_ITEMS) throw new ApiError('InvalidParams', `items must be a list of at most ${MAX_ITEMS}`);
      const clean = items.map((item, i) => {
        if (!item || typeof item.id !== 'string' || typeof item.label !== 'string') throw new ApiError('InvalidParams', `items[${i}] needs an id and a label`);
        return { id: item.id, label: text(item.label, 'label'), detail: text(item.detail, 'detail', { optional: true }) };
      });
      const answer = await deps.ask(caller, { kind: 'quickPick', title: text(title, 'title', { optional: true }), placeholder: text(placeholder, 'placeholder', { optional: true }), items: clean, multi: !!multi });
      if (!answer || answer.cancelled) throw new ApiError('UserCanceled', 'Nothing was picked');
      const ids = new Set(clean.map((i) => i.id));
      if (multi) return (Array.isArray(answer.value) ? answer.value : []).filter((id) => ids.has(id));
      if (!ids.has(answer.value)) throw new ApiError('UserCanceled', 'Nothing was picked');
      return answer.value;
    },
  });

  router.register('ui/input', {
    handler: async (caller, { title, prompt, value, password = false }) => {
      const answer = await deps.ask(caller, {
        kind: 'input',
        title: text(title, 'title', { optional: true }),
        prompt: text(prompt, 'prompt', { optional: true }),
        value: text(value, 'value', { optional: true }),
        password: !!password,
      });
      if (!answer || answer.cancelled || typeof answer.value !== 'string') throw new ApiError('UserCanceled', 'Nothing was entered');
      return answer.value;
    },
  });

  router.register('ui/confirm', {
    handler: async (caller, { message, detail, okLabel }) => {
      const answer = await deps.ask(caller, {
        kind: 'confirm',
        message: text(message, 'message'),
        detail: text(detail, 'detail', { optional: true }),
        okLabel: text(okLabel, 'okLabel', { optional: true, max: 60 }),
      });
      return !!(answer && answer.value === true);
    },
  });

  // A token is the calling add-on's own: another one cannot report on it
  // or end it. report answers { cancelled } so the add-on can stop when the
  // user cancelled (protocol 13.5 says null; this adds to it).
  function own(caller, token) {
    const p = typeof token === 'string' ? progress.get(token) : null;
    if (!p || p.addonId !== caller.addonId) throw new ApiError('NotFound', 'No such progress');
    return p;
  }

  router.register('ui/progress/start', {
    handler: (caller, { title, cancellable = false, location = 'status' }) => {
      if (location !== 'status' && location !== 'dialog') throw new ApiError('InvalidParams', 'location must be "status" or "dialog"');
      const token = `p${nextToken++}`;
      progress.set(token, { addonId: caller.addonId, cancelled: false, caller });
      deps.progress(caller, { op: 'start', token, title: text(title, 'title'), cancellable: !!cancellable, location });
      return { token };
    },
  });
  router.register('ui/progress/report', {
    handler: (caller, { token, message, percent }) => {
      const p = own(caller, token);
      if (percent !== undefined && (typeof percent !== 'number' || percent < 0 || percent > 100)) throw new ApiError('InvalidParams', 'percent must be 0 to 100');
      deps.progress(p.caller, { op: 'report', token, message: text(message, 'message', { optional: true }), percent });
      return { cancelled: p.cancelled };
    },
  });
  router.register('ui/progress/end', {
    handler: (caller, { token }) => {
      const p = own(caller, token);
      progress.delete(token);
      deps.progress(p.caller, { op: 'end', token });
      return null;
    },
  });

  return {
    // The user pressed Cancel on it.
    cancelProgress(token) {
      const p = progress.get(token);
      if (p) p.cancelled = true;
    },
    // Its page went away without ending it.
    endProgress(token) {
      const p = progress.get(token);
      if (!p) return;
      progress.delete(token);
      deps.progress(p.caller, { op: 'end', token });
    },
  };
}

module.exports = { registerUiApi };
