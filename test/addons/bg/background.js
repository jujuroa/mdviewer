// The background frame of the bg test add-on. It says ready unless the
// view tab has asked it not to (localStorage is shared with the add-on's
// tabs: same origin), to try the ready() timeout.
window.startedAt = Date.now();
window.info = null;
if (window.mdviewerAddon) {
  window.mdviewerAddon.call('app/info').then((info) => (window.info = info));
  if (localStorage.getItem('skipReady') !== '1') window.mdviewerAddon.ready();
}
