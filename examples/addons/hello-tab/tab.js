// The hello-tab add-on's tab. A tab page loads again whenever it moves to
// another window or the window reloads, so the count is handed over in a
// snapshot, and kept with tabs.setState for after a relaunch.
const api = window.mdviewerAddon;
const countEl = document.getElementById('count');
let count = 0;

function show() {
  countEl.textContent = String(count);
  // The tab strip shows the count; a count not yet zero again is "unsaved".
  api.tabs.update({ title: `Counter ${count}`, dirty: count > 0 });
  api.tabs.setState({ state: { count } });
}

document.getElementById('add').addEventListener('click', () => {
  count += 1;
  show();
});
document.getElementById('reset').addEventListener('click', () => {
  count = 0;
  show();
});

// Before moving or reloading: what the next page gets back.
api.lifecycle.onSnapshot(() => ({ count }));

const { reason, state } = api.tabs.getRestoreState();
if (state && typeof state.count === 'number') count = state.count;
document.getElementById('why').textContent = reason;
show();
api.ready();
