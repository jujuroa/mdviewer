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
  // messaging: what came in, and answers to requests.
  window.received = [];
  window.mdviewerAddon.messaging.onMessage(async (message, from) => {
    window.received.push({ message, from });
    if (!message || !message.op) return undefined;
    if (message.op === 'add') return message.a + message.b;
    if (message.op === 'fail') throw new Error('asked to fail');
    if (message.op === 'echo-to-tabs') {
      await window.mdviewerAddon.messaging.post({ to: 'tabs', message: { echo: message.text } });
      return 'posted';
    }
    return undefined;
  });
  if (localStorage.getItem('skipReady') !== '1') window.mdviewerAddon.ready();
}
