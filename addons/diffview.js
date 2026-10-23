// What the edit confirmation screen shows of a text change: hunks of
// lines (3 lines of context), changed words marked in a removed line and
// the added line that replaces it. Pure.
const Diff = require('diff');

const CONTEXT = 3;
const MAX_LINES = 3000;

function words(before, after) {
  const parts = Diff.diffWordsWithSpace(before, after);
  return {
    del: parts.filter((p) => !p.added).map((p) => ({ text: p.value, changed: !!p.removed })),
    add: parts.filter((p) => !p.removed).map((p) => ({ text: p.value, changed: !!p.added })),
  };
}

// [{ oldStart, newStart, lines: [{ type: 'ctx'|'del'|'add', text, parts? }] }],
// and truncated: whether lines were left out past MAX_LINES.
function diffForView(before, after) {
  const patch = Diff.structuredPatch('', '', before, after, '', '', { context: CONTEXT });
  let shown = 0;
  let truncated = false;
  const hunks = [];
  for (const h of patch.hunks) {
    if (shown >= MAX_LINES) {
      truncated = true;
      break;
    }
    const lines = [];
    const raw = h.lines.filter((l) => !l.startsWith('\\'));
    for (let i = 0; i < raw.length; i++) {
      const sign = raw[i][0];
      const text = raw[i].slice(1);
      if (sign === '-') {
        // A run of removed lines followed by as many added ones: pair them
        // up for word marks.
        let j = i;
        while (j < raw.length && raw[j][0] === '-') j++;
        let k = j;
        while (k < raw.length && raw[k][0] === '+') k++;
        const dels = raw.slice(i, j).map((l) => l.slice(1));
        const adds = raw.slice(j, k).map((l) => l.slice(1));
        const paired = dels.length === adds.length;
        dels.forEach((d, n) => lines.push(paired ? { type: 'del', text: d, parts: words(d, adds[n]).del } : { type: 'del', text: d }));
        adds.forEach((a, n) => lines.push(paired ? { type: 'add', text: a, parts: words(dels[n], a).add } : { type: 'add', text: a }));
        i = k - 1;
      } else {
        lines.push({ type: sign === '+' ? 'add' : 'ctx', text });
      }
    }
    shown += lines.length;
    hunks.push({ oldStart: h.oldStart, newStart: h.newStart, lines });
  }
  return { hunks, truncated };
}

module.exports = { diffForView };
