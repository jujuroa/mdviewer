// The ai-edit add-on's background frame: the selection (or the whole
// document) in, a proposed change out through edit/apply, which shows it
// on the comparison screen. Nothing changes unless the user applies it.
const api = window.mdviewerAddon;
const ko = api.app.locale === 'ko';
const say = (k, e) => (ko ? k : e);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The end of a text as a position (protocol 8.2: lines end at "\n").
function endOf(text) {
  const lines = text.split('\n');
  const last = lines[lines.length - 1];
  return { line: lines.length - 1, character: last.length };
}

// What to tidy: the selection if there is one, else the document on screen.
async function target() {
  const selection = await api.editor.selection();
  if (selection && selection.text) return { path: selection.path, version: selection.version, range: selection.range, text: selection.text };
  const active = await api.documents.active();
  if (!active) return null;
  const doc = await api.documents.read({ path: active.path });
  return { path: doc.path, version: doc.version, range: { start: { line: 0, character: 0 }, end: endOf(doc.text) }, text: doc.text };
}

async function chooseRules() {
  const all = window.tidyRules.map((r) => r.id);
  if (!(await api.settings.get({ key: 'askRules' }))) return all;
  return api.ui.quickPick({
    title: say('규칙 고르기', 'Choose rules'),
    items: window.tidyRules.map((r) => ({ id: r.id, label: ko ? r.ko : r.en })),
    multi: true,
  });
}

api.commands.register('ai-edit.tidy', async () => {
  const what = await target();
  if (!what) {
    await api.ui.notify({ level: 'warning', message: say('열린 문서가 없습니다.', 'No document is open.') });
    return null;
  }
  let rules;
  try {
    rules = await chooseRules();
  } catch (err) {
    if (err.name === 'UserCanceled') return null;
    throw err;
  }
  // An AI engine takes a while: show it, and let the user stop it.
  const { token } = await api.ui.progress.start({ title: say('다듬는 중', 'Tidying'), cancellable: true });
  let newText;
  try {
    for (let step = 1; step <= 3; step++) {
      await wait(150);
      const { cancelled } = await api.ui.progress.report({ token, percent: step * 33 });
      if (cancelled) return null;
    }
    newText = window.tidy(what.text, rules);
  } finally {
    await api.ui.progress.end({ token });
  }
  if (newText === what.text) {
    await api.ui.notify({ message: say('바꿀 것이 없습니다.', 'Nothing to change.') });
    return { applied: false };
  }
  try {
    return await api.edit.apply({
      label: say('마크다운 다듬기', 'Tidy Markdown'),
      operations: [{ kind: 'change', path: what.path, baseVersion: what.version, changes: [{ range: what.range, newText }] }],
    });
  } catch (err) {
    // The document changed while it was being tidied.
    if (err.name !== 'Conflict') throw err;
    await api.ui.notify({ level: 'warning', message: say('문서가 그사이 바뀌었습니다. 다시 실행하세요.', 'The document changed meanwhile. Run it again.') });
    return null;
  }
});

api.ready();
