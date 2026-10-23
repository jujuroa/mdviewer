// Consent (protocol 10.3): before an add-on first runs, the user sees what
// it may do — permissions, hosts it connects to, programs it runs — and
// agrees. The record is kept (addons/store.js); an update that adds to any
// of the three asks again. Pure.

// What an add-on asks for, as the consent record compares it.
function consentScope(manifest) {
  const network = manifest.network && Array.isArray(manifest.network.hosts) ? manifest.network.hosts : [];
  return {
    version: manifest.version,
    permissions: [...new Set(manifest.permissions || [])].sort(),
    hosts: [...new Set(network)].sort(),
    executables: [...new Set((manifest.executables || []).map((x) => `${x.id}=${x.path}`))].sort(),
  };
}

// Whether the user must be asked: never agreed, or the add-on now asks for
// something the record does not hold. (A new version that asks for no
// more needs no new consent.)
function needsConsent(manifest, record) {
  if (!record) return true;
  const now = consentScope(manifest);
  const more = (key) => now[key].some((v) => !(record[key] || []).includes(v));
  return more('permissions') || more('hosts') || more('executables');
}

module.exports = { consentScope, needsConsent };
