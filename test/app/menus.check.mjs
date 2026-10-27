// Add-on menus, when and keybindings (F3, protocol 12.2–12.4). Context
// menus are native: the main process records what pops up (and can click
// an item of it).
import path from 'node:path';
import { launch, checker, connect, sleep, openWindowWith, openAddonTab, targets, waitFor, inActiveDoc, enterEditMode } from './harness.mjs';

const { check, done } = checker();
const app = await launch({ files: { 'proj/a.md': '# A\n\nsome text\n', 'proj/b.txt': 'b' }, addonDev: ['test/addons/bg'] });
const counted = async () => {
  const t = (await targets(app.port)).find((x) => x.url.startsWith('mdviewer-addon://bg/background.html'));
  if (!t) return 0;
  const bg = await connect(app.port, (x) => x.id === t.id, { quiet: true });
  return (await bg.evaluate(`return window.counted || 0`).catch(() => 0)) || 0;
};
try {
  const w = await openWindowWith(app, 'a.md');
  await app.main(`
    const { Menu } = electron;
    global.__popups = [];
    Menu.prototype.popup = function () { global.__popups.push(this); };
    return 1;`);
  const lastPopup = () => app.main(`const m = global.__popups[global.__popups.length - 1]; return m ? m.items.map((i) => i.type === 'separator' ? '-' : i.label) : null`);
  const clickInPopup = (label) => app.main(`const m = global.__popups[global.__popups.length - 1]; const i = m.items.find((x) => x.label === ${JSON.stringify(label)}); i.click(); return true`);

  // menubar/addons: in the Extensions menu, with the add-on's name.
  const ext = await app.extensionLabels();
  check('menubar/addons: the item is in Extensions', ext.includes('Background: Count'), ext.join('|'));
  await app.clickMenu('확장', 'Background', 'Count');
  const sub = await app.main(`const i = electron.Menu.getApplicationMenu().items.find((m) => m.label === '확장').submenu.items.find((m) => m.label === 'Background'); return { items: i.submenu.items.filter((x) => x.visible).map((x) => x.type === 'separator' ? '-' : x.label), icon: !!i.icon && !i.icon.isEmpty(), size: i.icon ? i.icon.getSize() : null }`);
  check('Extensions: one submenu per add-on, "창 열기" (main view) first, then its commands', sub.items[0] === '창 열기' && sub.items[1] === '-' && sub.items.includes('Count'), JSON.stringify(sub.items));
  check('  with the manifest icon, 16 px', sub.icon && sub.size && sub.size.width === 16, JSON.stringify(sub));
  const listed = (await w.evaluate(`return await window.mdviewer.listAddons()`)).find((x) => x.id === 'bg');
  check('Extensions screen gets the icon as a data URL', typeof listed.icon === 'string' && listed.icon.startsWith('data:image/png'), String(listed.icon).slice(0, 30));
  check('  and runs the command', (await waitFor(async () => ((await counted()) === 1 ? 1 : null), { timeout: 10000 }).catch(() => 0)) === 1);

  // explorer/item with when resourceExt == 'md'
  const root = path.join(app.tmp, 'proj');
  await w.evaluate(`await window.mdviewer.showTreeContextMenu(${JSON.stringify(path.join(root, 'a.md'))}, ${JSON.stringify(root)}, {}); return 1`);
  let items = await lastPopup();
  check('explorer/item: shown for a .md file (when holds), after the app\'s items', items && items[items.length - 1] === 'Count' && items[items.length - 2] === '-', JSON.stringify(items));
  await clickInPopup('Count');
  check('  clicking it runs the command', (await waitFor(async () => ((await counted()) === 2 ? 2 : null), { timeout: 5000 }).catch(() => 0)) === 2);
  await w.evaluate(`await window.mdviewer.showTreeContextMenu(${JSON.stringify(path.join(root, 'b.txt'))}, ${JSON.stringify(root)}, {}); return 1`);
  items = await lastPopup();
  check('  not for a .txt file (when fails)', items && !items.includes('Count'), JSON.stringify(items));

  // tab/context with when activeTabKind == 'document'
  const docTab = await w.evaluate(`return +document.querySelector('.doc-tab').dataset.tabId`);
  await w.evaluate(`await window.mdviewer.showTabContextMenu(${docTab}); return 1`);
  check('tab/context: on a document tab', (await lastPopup()).includes('Count'));
  const view = await openAddonTab(app, w, 'Background: View');
  check('its tab without an icon of its own shows the add-on icon', (await w.evaluate(`const img = document.querySelector('.doc-tab[data-tab-id="${view.id}"] .doc-tab-icon img'); return img ? img.getAttribute('src') : null`)) === 'mdviewer-addon://bg/icon.png');
  await w.evaluate(`await window.mdviewer.showTabContextMenu(${view.id}); return 1`);
  check('  not while an add-on tab is active', !(await lastPopup()).includes('Count'), JSON.stringify(await lastPopup()));

  // editor/context with when hasSelection
  await w.evaluate(`await window.mdviewer.activateTab(${docTab}); return 1`);
  await sleep(500);
  const d = inActiveDoc(w);
  await enterEditMode(d);
  await d(`ta.focus(); ta.setSelectionRange(0, 0); ta.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return 1`);
  await sleep(500);
  check('editor/context: not without a selection', !(await lastPopup()).includes('Count'), JSON.stringify(await lastPopup()));
  await d(`ta.focus(); ta.setSelectionRange(4, 8); ta.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return 1`);
  await sleep(500);
  check('  with one', (await lastPopup()).includes('Count'), JSON.stringify(await lastPopup()));

  // keybindings: Ctrl+Alt+K runs bg.count; Ctrl+Shift+P stays the app's.
  const before = await counted();
  for (const type of ['rawKeyDown', 'keyUp']) await w.send('Input.dispatchKeyEvent', { type, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers: 3 });
  check('a keybinding runs its command (from the window)', (await waitFor(async () => ((await counted()) === before + 1 ? 1 : null), { timeout: 5000 }).catch(() => 0)) === 1);
  const list = await w.evaluate(`return (await window.mdviewer.listAddons()).find((a) => a.id === 'bg').keyConflicts`);
  check('a key the app uses stays the app\'s, and is reported', JSON.stringify(list) === '["Ctrl+Shift+P"]', JSON.stringify(list));
  for (const type of ['rawKeyDown', 'keyUp']) await w.send('Input.dispatchKeyEvent', { type, key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80, modifiers: 2 | 8 });
  check('  (Ctrl+Shift+P still opens the palette)', !!(await waitFor(() => w.evaluate(`return !document.getElementById('command-palette').classList.contains('hidden')`), { timeout: 3000 }).catch(() => false)));
} finally {
  await app.stop();
  done();
}
