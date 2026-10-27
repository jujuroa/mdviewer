// The ai-edit add-on's main view: what it does and with which rules. The
// tidying itself runs on the document tab (its editor menu or "Extensions >
// Markdown Helper > Tidy Markdown"), since with this view in front there is
// no document to tidy.
const api = window.mdviewerAddon;
const ko = api.app.locale === 'ko';
document.getElementById('how').textContent = ko
  ? '문서 탭에서 편집창 우클릭 "마크다운 다듬기" 또는 "확장 > 마크다운 도우미 > 마크다운 다듬기"로 실행합니다. 선택이 있으면 선택만, 없으면 문서 전체를 다듬고, 비교 화면에서 확인한 뒤 적용됩니다.'
  : 'Run it on a document tab: "Tidy Markdown" in the editor's context menu or "Extensions > Markdown Helper > Tidy Markdown". It tidies the selection (or the whole document) and applies after you confirm on the comparison screen.';
const list = document.getElementById('rules');
for (const rule of window.tidyRules) {
  const li = document.createElement('li');
  li.textContent = ko ? rule.ko : rule.en;
  list.appendChild(li);
}
async function showAsk() {
  const ask = await api.settings.get({ key: 'askRules' });
  document.getElementById('ask').textContent = ask
    ? (ko ? '실행할 때마다 규칙을 고릅니다 (설정에서 바꿈).' : 'You choose the rules each time (change it in Settings).')
    : (ko ? '규칙을 모두 씁니다 (설정에서 바꿈).' : 'All rules are used (change it in Settings).');
}
showAsk();
api.ready();
