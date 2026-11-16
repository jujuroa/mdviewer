// What Enter does in the markdown source editor besides breaking the line:
// continue a list / task list / blockquote, end one from an empty item, and
// lay out a table (the separator and a first row under a header, another
// row under a body row), and close a code fence it opens. Tab on a list item
// nests it one level, and Alt+arrows walk the cells of a table. Pure text in, one edit out, so it can be tested
// without the editor (a plain <script> in the page, require() in node).
(function (root) {
  const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
  const QUOTE_RE = /^(?:\s{0,3}> ?)+/;
  // indent, bullet | number + delimiter, spaces, task checkbox
  const LIST_RE = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))( +|$)(\[[ xX]\](?: +|$))?/;
  const RULE_RE = /^\s*([-*_])(?: *\1){2,}\s*$/;
  const TABLE_ROW_RE = /^(\s*)\|.*\|\s*$/;
  const TABLE_SEPARATOR_RE = /^\s*\|\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|\s*$/;

  // Whether `text` (whole lines) ends inside a fenced code block, where "- "
  // and "|" are code rather than markdown.
  function endsInsideFence(text) {
    let open = null;
    for (const line of text.split('\n')) {
      const m = FENCE_RE.exec(line);
      if (!m) continue;
      if (!open) open = m[1];
      else if (m[1][0] === open[0] && m[1].length >= open.length && !line.trim().slice(m[1].length)) open = null;
    }
    return !!open;
  }

  function lineAt(value, pos) {
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    let lineEnd = value.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = value.length;
    return { lineStart, lineEnd, line: value.slice(lineStart, lineEnd), col: pos - lineStart };
  }

  // The cells of a table row, without the outer pipes. A "\|" is text.
  function tableCells(line) {
    const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return inner.split(/(?<!\\)\|/).map((cell) => cell.trim());
  }

  function emptyTableRow(columns) {
    return '|' + '  |'.repeat(columns);
  }

  // The edit Enter makes with the caret at `pos`, or null to leave Enter to
  // the textarea. { from, to, text, caret }: replace [from, to) with `text`
  // and put the caret at `caret` (an offset into the text after the edit).
  function enterCompletion(value, pos) {
    const { lineStart, lineEnd, line, col } = lineAt(value, pos);
    if (!line.trim() || RULE_RE.test(line)) return null;
    const fenced = endsInsideFence(value.slice(0, lineStart));

    // An opening fence gets its closing one, with the caret on an empty
    // line between them. Only while the document's fences don't pair up:
    // one whose closing fence is already there is left alone.
    const fence = FENCE_RE.exec(line);
    if (fence && !fenced && col === line.length && !line.slice(fence[0].length).includes(fence[1][0])) {
      if (!endsInsideFence(value)) return null;
      const indent = line.slice(0, fence[0].length - fence[1].length);
      return { from: pos, to: pos, text: '\n' + indent + '\n' + indent + fence[1], caret: pos + 1 + indent.length };
    }
    if (fenced || fence) return null;

    const clearFrom = (from) => ({ from, to: lineEnd, text: '', caret: from });
    const breakWith = (prefix) => ({ from: pos, to: pos, text: '\n' + prefix, caret: pos + 1 + prefix.length });

    const table = TABLE_ROW_RE.exec(line);
    if (table) {
      const indent = table[1];
      // Before the first pipe, Enter pushes the row down as usual.
      if (col <= indent.length) return null;
      const lines = value.split('\n');
      const index = value.slice(0, lineStart).split('\n').length - 1;
      const prev = index > 0 ? lines[index - 1] : '';
      const next = index + 1 < lines.length ? lines[index + 1] : '';
      const cells = tableCells(line);
      const isSeparator = TABLE_SEPARATOR_RE.test(line);
      const inTable = TABLE_ROW_RE.test(prev);
      // Rows go under the whole line, wherever in it the caret is; the last
      // one is the empty row, and the caret lands in its first cell.
      const rowsBelow = (rows) => {
        const text = '\n' + rows.map((row) => indent + row).join('\n');
        // "| " + caret + " |"
        const caret = lineEnd + text.length - rows[rows.length - 1].length + 2;
        return { from: lineEnd, to: lineEnd, text, caret };
      };
      const emptyRow = emptyTableRow(cells.length);
      if (!inTable) {
        // A header: one with its separator already below is left alone.
        if (isSeparator || cells.length < 2 || TABLE_SEPARATOR_RE.test(next)) return null;
        return rowsBelow(['|' + ' --- |'.repeat(cells.length), emptyRow]);
      }
      // Enter on a row left empty ends the table.
      if (!isSeparator && cells.every((cell) => !cell)) return clearFrom(lineStart);
      return rowsBelow([emptyRow]);
    }

    const quote = (QUOTE_RE.exec(line) || [''])[0];
    const rest = line.slice(quote.length);
    const list = LIST_RE.exec(rest);
    if (list) {
      const markerEnd = quote.length + list[0].length;
      if (col < markerEnd) return null;
      if (!rest.slice(list[0].length).trim()) {
        // Enter on an item left empty steps out of the list: a nested one
        // back to the list it is in, and from there (or in a quote, which
        // stays) the marker goes.
        const out = !quote && tabCompletion(value, pos, true);
        return out || clearFrom(lineStart + quote.length);
      }
      const marker = list[2] || String(Number(list[3]) + 1) + list[4];
      return breakWith(quote + list[1] + marker + (list[5] || ' ') + (list[6] ? '[ ] ' : ''));
    }
    if (quote) {
      if (col < quote.length) return null;
      if (!rest.trim()) return clearFrom(lineStart);
      return breakWith(quote);
    }
    return null;
  }

  // How far a line's leading whitespace reaches, a tab going to the next
  // multiple of four: list levels are compared by this, not by the
  // characters, since a document may indent with tabs, spaces or both.
  function indentWidth(indent) {
    let width = 0;
    for (const ch of indent) width = ch === '\t' ? width + 4 - (width % 4) : width + 1;
    return width;
  }

  // The edit Tab (Shift+Tab with `outdent`) makes with the caret at `pos`,
  // or null to leave the key to the editor: on a list item, move the whole
  // item one level in or out. Out is to the level of the item it is nested
  // in, however that one is indented. A numbered item follows the numbered
  // item already at its new level, or restarts at 1.
  function tabCompletion(value, pos, outdent) {
    const { lineStart, lineEnd, line, col } = lineAt(value, pos);
    const list = LIST_RE.exec(line);
    if (!list || RULE_RE.test(line) || endsInsideFence(value.slice(0, lineStart))) return null;
    // The lines above, nearest first; blank ones say nothing about levels.
    const above = value.slice(0, lineStart).split('\n').slice(0, -1).reverse().filter((text) => text.trim());
    const widthOf = (text) => indentWidth(/^\s*/.exec(text)[0]);

    let indent = '\t' + list[1];
    if (outdent) {
      const width = indentWidth(list[1]);
      if (!width) return null;
      const parent = above.find((text) => widthOf(text) < width);
      const parentItem = parent !== undefined && LIST_RE.exec(parent);
      // With no item above to go by, one tab or up to two spaces, as
      // Shift+Tab takes off any other line.
      indent = parentItem ? parentItem[1] : list[1].replace(/^(\t| {1,2})/, '');
    }

    let marker = list[2];
    if (!marker) {
      const width = indentWidth(indent);
      // Deeper lines belong to the items in between.
      const sibling = above.find((text) => widthOf(text) <= width);
      const item = sibling !== undefined && widthOf(sibling) === width && LIST_RE.exec(sibling);
      marker = (item && item[3] ? Number(item[3]) + 1 : 1) + list[4];
    }
    const head = indent + marker;
    const oldHead = list[1].length + (list[2] || list[3] + list[4]).length;
    // The caret keeps its place in the item's text; from inside the marker
    // it goes to where the text starts.
    const caret = lineStart + head.length + (col >= oldHead ? col - oldHead : list[5].length);
    return { from: lineStart, to: lineEnd, text: head + line.slice(oldHead), caret };
  }

  // Unescaped pipes of a table row, as offsets into the line.
  function pipeOffsets(line) {
    const offsets = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') i++;
      else if (line[i] === '|') offsets.push(i);
    }
    return offsets;
  }

  // Where the caret goes from `pos` to the next table cell in `direction`
  // ('left', 'right', 'up', 'down'), or null when `pos` isn't in a table.
  // Left and right carry on into the row above or below at the row's ends;
  // the separator row is stepped over. With no cell that way, `pos` itself.
  function tableCellMove(value, pos, direction) {
    const { lineStart, line, col } = lineAt(value, pos);
    if (!TABLE_ROW_RE.test(line) || endsInsideFence(value.slice(0, lineStart))) return null;
    const lines = value.split('\n');
    const row = value.slice(0, lineStart).split('\n').length - 1;
    const pipes = pipeOffsets(line);
    const cell = Math.max(0, Math.min(pipes.filter((at) => at < col).length - 1, pipes.length - 2));

    // The nearest row that way with cells to type in, if the table goes on.
    const rowToward = (step) => {
      for (let i = row + step; i >= 0 && i < lines.length && TABLE_ROW_RE.test(lines[i]); i += step) {
        if (!TABLE_SEPARATOR_RE.test(lines[i])) return i;
      }
      return -1;
    };
    // The end of the cell's text, or just inside an empty cell.
    const caretIn = (targetRow, targetCell) => {
      const text = lines[targetRow];
      const at = pipeOffsets(text);
      const index = targetCell < 0 ? at.length - 2 : Math.min(targetCell, at.length - 2);
      const content = text.slice(at[index] + 1, at[index + 1]);
      const inCell = content.trim() ? content.trimEnd().length : Math.min(1, content.length);
      let offset = 0;
      for (let i = 0; i < targetRow; i++) offset += lines[i].length + 1;
      return offset + at[index] + 1 + inCell;
    };

    let targetRow = row;
    let targetCell = cell;
    if (direction === 'left' || direction === 'right') {
      const step = direction === 'left' ? -1 : 1;
      targetCell = cell + step;
      if (targetCell < 0 || targetCell > pipes.length - 2) {
        targetRow = rowToward(step);
        // -1: the last cell of the row above.
        targetCell = step < 0 ? -1 : 0;
      }
    } else {
      targetRow = rowToward(direction === 'up' ? -1 : 1);
    }
    return targetRow < 0 ? pos : caretIn(targetRow, targetCell);
  }

  const api = { enterCompletion, tabCompletion, tableCellMove };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MdvEditorAutocomplete = api;
})(this);
