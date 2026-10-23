// API call tracing for add-on developers (protocol 16, setting
// addons.trace): 'calls' logs each call's method, time and outcome;
// 'verbose' adds its parameters and result. Secret values and document
// text never go into the log: they show as their length.

const LEVELS = ['off', 'calls', 'verbose'];
const MAX_SHOWN = 1000;
// Fields that carry a document's text (documents/read, editor/selection,
// edit/apply).
const TEXT_KEYS = new Set(['text', 'newText']);

function traceLevel(value) {
  return LEVELS.includes(value) ? value : 'off';
}

function masked(value, depth = 0) {
  if (depth > 20) return '…';
  if (Array.isArray(value)) return value.map((v) => masked(v, depth + 1));
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = TEXT_KEYS.has(k) && typeof v === 'string' ? `<${v.length} chars>` : masked(v, depth + 1);
    }
    return out;
  }
  return value;
}

function shown(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    return '<not JSON>';
  }
  if (json === undefined) return 'undefined';
  return json.length > MAX_SHOWN ? `${json.slice(0, MAX_SHOWN)}… (${json.length} chars)` : json;
}

// One log line for a call. answer: the router's { ok, result | error }.
function formatTrace(level, method, params, answer, ms) {
  const outcome = answer.ok ? 'ok' : `error ${answer.error.name}`;
  let line = `call ${method} ${Math.round(ms)} ms ${outcome}`;
  if (level !== 'verbose') return line;
  // secrets/*: neither what is stored nor what comes back.
  const secret = /^secrets\//.test(method);
  const args = secret && params && typeof params === 'object' ? { ...params, ...('value' in params ? { value: '<hidden>' } : {}) } : params;
  line += ` params=${shown(masked(args === undefined ? {} : args))}`;
  if (answer.ok) line += ` result=${secret ? '<hidden>' : shown(masked(answer.result))}`;
  else line += ` message=${shown(answer.error.message)}`;
  return line;
}

module.exports = { LEVELS, traceLevel, formatTrace };
