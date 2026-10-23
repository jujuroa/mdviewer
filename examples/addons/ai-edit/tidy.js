// The "model" of this example: plain rules. A real AI add-on would send
// the text to its engine here and get the new text back.
window.tidyRules = [
  { id: 'trailing', ko: '줄 끝 공백 지우기', en: 'Remove trailing spaces', apply: (t) => t.replace(/[ \t]+$/gm, '') },
  { id: 'blank', ko: '빈 줄 여러 개를 하나로', en: 'Collapse blank lines', apply: (t) => t.replace(/(\r?\n){3,}/g, (m) => (m.includes('\r') ? '\r\n\r\n' : '\n\n')) },
  { id: 'bullets', ko: '목록 기호를 -로', en: 'Use - for list items', apply: (t) => t.replace(/^(\s*)[*+] /gm, '$1- ') },
  { id: 'headings', ko: '제목 # 뒤에 공백', en: 'Space after heading #', apply: (t) => t.replace(/^(#{1,6})([^#\s])/gm, '$1 $2') },
];

window.tidy = (text, ruleIds) => window.tidyRules.filter((r) => ruleIds.includes(r.id)).reduce((t, r) => r.apply(t), text);
