// The background frame of the bg test add-on. It says ready unless the
// view tab has asked it not to (localStorage is shared with the add-on's
// tabs: same origin), to try the ready() timeout.
window.startedAt = Date.now();
window.info = null;
if (window.mdviewerAddon) {
  window.mdviewerAddon.call('app/info').then((info) => (window.info = info));
  // bg.count: how many times it ran, and what it was given.
  window.counted = 0;
  window.mdviewerAddon.commands.register('bg.count', (ctx) => {
    window.counted++;
    return { counted: window.counted, ctx };
  });
  if (localStorage.getItem('skipReady') !== '1') window.mdviewerAddon.ready();
}
