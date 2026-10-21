// Add-on policy (protocol 10.4): what the user's settings and, for a
// managed install, policy.json in the install folder allow. Pure.
const { hostSource } = require('./pages.js');

const DEFAULT_POLICY = {
  enabled: true,
  blockNetwork: false,
  blockExecutables: false,
  allowedHosts: null,
  allowExperimentalApi: [],
};

const KEYS = {
  enabled: 'addons.enabled',
  blockNetwork: 'addons.blockNetwork',
  blockExecutables: 'addons.blockExecutables',
  allowedHosts: 'addons.allowedHosts',
  allowExperimentalApi: 'addons.allowExperimentalApi',
};

const stringList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null);

// The policy in effect: the user's settings, overruled by policy.json (an
// administrator's) wherever it says something.
function mergePolicy(settings = {}, policyFile = {}) {
  const policy = { ...DEFAULT_POLICY };
  for (const source of [settings || {}, policyFile || {}]) {
    for (const [name, key] of Object.entries(KEYS)) {
      const value = source[key];
      if (value === undefined) continue;
      if (name === 'allowedHosts' || name === 'allowExperimentalApi') {
        const list = stringList(value);
        if (list) policy[name] = list;
      } else if (typeof value === 'boolean') {
        policy[name] = value;
      }
    }
  }
  return policy;
}

// "http://127.0.0.1:8080" -> "127.0.0.1"
function hostName(host) {
  const source = hostSource(host);
  return source ? source.replace(/^[a-z]+:\/\//, '').replace(/:\d+$/, '').toLowerCase() : null;
}

function isLoopback(host) {
  const name = hostName(host);
  return name === 'localhost' || name === '[::1]' || /^127(\.\d{1,3}){3}$/.test(name || '');
}

// A declared host is allowed when it is one of allowedHosts (as names, so
// "api.example.com" covers its https and wss forms; "*.example.com" covers
// its subdomains). Loopback is always allowed.
function hostAllowed(host, allowedHosts) {
  if (isLoopback(host)) return true;
  const name = hostName(host);
  return allowedHosts.some((pattern) => {
    const p = hostName(pattern);
    if (!p) return false;
    return p.startsWith('*.') ? name.endsWith(p.slice(1)) : name === p;
  });
}

// Why policy keeps a (valid, compatible) manifest from loading: problems in
// the shape manifest.js uses.
function policyProblems(manifest, policy) {
  if (!policy.enabled) return [{ path: '', code: 'policyAddonsOff' }];
  const problems = [];
  const hosts = (manifest.network && manifest.network.hosts) || [];
  if (policy.blockNetwork) {
    const outside = hosts.filter((h) => !isLoopback(h));
    if (outside.length) problems.push({ path: 'network.hosts', code: 'policyNetwork', detail: outside.join(', ') });
  }
  if (policy.blockExecutables && (manifest.executables || []).length) {
    problems.push({ path: 'executables', code: 'policyExecutables' });
  }
  if (policy.allowedHosts) {
    const outside = hosts.filter((h) => !hostAllowed(h, policy.allowedHosts));
    if (outside.length) problems.push({ path: 'network.hosts', code: 'policyHosts', detail: outside.join(', ') });
  }
  return problems;
}

module.exports = { DEFAULT_POLICY, mergePolicy, policyProblems, isLoopback };
