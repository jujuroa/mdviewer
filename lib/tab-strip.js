// Where tabs go in a tab strip. Pure index arithmetic, kept out of main.js
// so it can be tested without Electron.

// The tab to show once the one at `index` has left a strip that now has
// `length` tabs: the one that took its place, else the one before it.
// -1 when the strip is empty.
function neighbourIndex(length, index) {
  return length > 0 ? Math.max(0, Math.min(index, length - 1)) : -1;
}

// Where a tab taken out of its strip at `from` goes back in when dropped
// before the tab at `to` (indices of the strip before it was taken out).
function reorderIndex(length, from, to) {
  return Math.max(0, Math.min(from < to ? to - 1 : to, length - 1));
}

// Where a tab from another strip goes in one that has `length` tabs:
// before the tab at `index`, or at the end without one.
function insertIndex(length, index) {
  return Number.isInteger(index) ? Math.max(0, Math.min(index, length)) : length;
}

module.exports = { neighbourIndex, reorderIndex, insertIndex };
