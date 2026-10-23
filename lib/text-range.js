// Positions in a document as the add-on API gives them (protocol 8.2):
// { line, character }, both from 0, character in UTF-16 code units; lines
// end at "\n", and a "\r\n" is one line break (the "\r" is not part of the
// line). A range's end is not included.

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

// The length of line `line` without its line break.
function lineLength(text, starts, line) {
  const start = starts[line];
  let end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
  if (end > start && text[end - 1] === '\r') end--;
  return end - start;
}

function positionAt(text, offset, starts = lineStarts(text)) {
  const o = Math.max(0, Math.min(offset, text.length));
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= o) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: Math.min(o - starts[lo], lineLength(text, starts, lo)) };
}

// The offset of a position, or -1 when it is not in the text (a line past
// the end, a character past its line).
function offsetAt(text, position, starts = lineStarts(text)) {
  if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)) return -1;
  if (position.line < 0 || position.line >= starts.length || position.character < 0) return -1;
  if (position.character > lineLength(text, starts, position.line)) return -1;
  return starts[position.line] + position.character;
}

function rangeOf(text, start, end) {
  const starts = lineStarts(text);
  return { start: positionAt(text, start, starts), end: positionAt(text, end, starts) };
}

// [start, end] offsets of a range, or null when it is not in the text or
// ends before it starts.
function offsetsOf(text, range) {
  if (!range) return null;
  const starts = lineStarts(text);
  const a = offsetAt(text, range.start, starts);
  const b = offsetAt(text, range.end, starts);
  return a < 0 || b < 0 || b < a ? null : [a, b];
}

module.exports = { positionAt, offsetAt, rangeOf, offsetsOf };
