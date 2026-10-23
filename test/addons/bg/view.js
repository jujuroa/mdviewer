// The bg test add-on's tab: opening it starts the background frame
// (onTab:bg.view); while it is open the background is not idle.
if (window.mdviewerAddon) {
  window.shown = [];
  window.mdviewerAddon.commands.register('bg.show', (ctx) => {
    window.shown.push(ctx);
    return 'shown';
  });
  window.mdviewerAddon.ready();
}
window.viewReady = true;
