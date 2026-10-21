// The test document pane (F0-c): shows what it is bound to. probe.js gives
// it the same helpers as the probe tab.
(async () => {
  const info = document.getElementById('info');
  if (!window.mdviewerAddon) {
    info.textContent = 'no bridge';
    return;
  }
  const me = await window.mdviewerAddon.call('app/info');
  info.textContent = `kind ${me.kind} · tab ${me.tab} · window ${me.window} · ${location.origin}`;
  window.paneInfo = me;
})();
