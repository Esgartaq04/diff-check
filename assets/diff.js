/*
 * diff.js - line diff engine for Diff Check.
 *
 * Pure functions only: nothing in here touches the DOM, so the engine can be
 * exercised on its own (see the smoke tests in the README).
 *
 * Exposed as a global because the page loads plain <script> tags - that keeps
 * index.html working when it is opened straight off disk, not just over http.
 */
var DiffEngine = (function () {
  'use strict';

  /* How much work Myers is allowed to do before we give up and fall back to a
   * coarse "replace the whole block" diff. Bounded so a pathological pair of
   * large, totally unrelated texts can never hang the page. */
  var WORK_BUDGET = 15000000;
  var MAX_EDIT_DISTANCE = 1500;

  /* The text used for MATCHING. The original line is what gets rendered, so
   * these options never alter what the user sees - only what counts as equal. */
  function normalizeLine(line, opts) {
    var s = line;
    if (opts && opts.ignoreWhitespace) s = s.replace(/^\s+|\s+$/g, '');
    if (opts && opts.ignoreCase) s = s.toLowerCase();
    return s;
  }

  function isBlank(line) {
    return /^\s*$/.test(line);
  }

  /* Split into lines, tolerating CRLF and CR endings, and dropping the single
   * trailing empty line that a final newline otherwise produces. */
  function splitLines(text) {
    if (text === '') return [];
    var lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /*
   * Myers greedy O((N+M)*D) diff.
   *
   * Returns ops in order, or null if the edit distance blew past `maxD` - the
   * caller then substitutes a coarse block replacement.
   *
   * trace[d] is the frontier as it stood after d-1 rounds, sliced down to the
   * diagonals that round actually touched (-(d-1)..d-1, stored at index
   * k + (d - 1)). Storing the slice rather than the whole band keeps the trace
   * at O(D^2) instead of O(D*(N+M)).
   */
  function myers(a, b, maxD) {
    var n = a.length;
    var m = b.length;
    var max = n + m;
    if (max === 0) return [];

    var offset = max;
    var v = new Int32Array(2 * max + 1);
    var trace = [];
    var limit = Math.min(max, maxD);

    for (var d = 0; d <= limit; d++) {
      trace.push(d === 0 ? new Int32Array(0) : v.slice(offset - d + 1, offset + d));

      for (var k = -d; k <= d; k += 2) {
        var x;
        if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
          x = v[offset + k + 1]; // moved down: an insertion
        } else {
          x = v[offset + k - 1] + 1; // moved right: a deletion
        }
        var y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[offset + k] = x;
        if (x >= n && y >= m) return backtrack(trace, n, m);
      }
    }
    return null; // over budget
  }

  function backtrack(trace, n, m) {
    var ops = [];
    var x = n;
    var y = m;

    for (var d = trace.length - 1; d >= 0; d--) {
      if (d === 0) {
        while (x > 0 && y > 0) { x--; y--; ops.push({ type: 'equal', aIndex: x, bIndex: y }); }
        break;
      }

      var v = trace[d];
      var base = d - 1; // trace[d] holds diagonals -(d-1)..(d-1)
      var k = x - y;
      var prevK;
      if (k === -d || (k !== d && v[base + k - 1] < v[base + k + 1])) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      var prevX = v[base + prevK];
      var prevY = prevX - prevK;

      while (x > prevX && y > prevY) { x--; y--; ops.push({ type: 'equal', aIndex: x, bIndex: y }); }
      if (x === prevX) {
        ops.push({ type: 'insert', aIndex: -1, bIndex: prevY });
      } else {
        ops.push({ type: 'delete', aIndex: prevX, bIndex: -1 });
      }
      x = prevX;
      y = prevY;
    }

    ops.reverse();
    return ops;
  }

  /*
   * Diff two arrays of lines. Returns { ops, approximate }.
   *
   * Identical head and tail are peeled off before Myers runs: a one-line edit
   * in the middle of a big file then costs almost nothing.
   */
  function diffLines(aLines, bLines, opts) {
    var i, j;
    var aKeys = new Array(aLines.length);
    var bKeys = new Array(bLines.length);
    for (i = 0; i < aLines.length; i++) aKeys[i] = normalizeLine(aLines[i], opts);
    for (j = 0; j < bLines.length; j++) bKeys[j] = normalizeLine(bLines[j], opts);

    var start = 0;
    while (start < aKeys.length && start < bKeys.length && aKeys[start] === bKeys[start]) start++;

    var aEnd = aKeys.length;
    var bEnd = bKeys.length;
    while (aEnd > start && bEnd > start && aKeys[aEnd - 1] === bKeys[bEnd - 1]) { aEnd--; bEnd--; }

    var ops = [];
    for (i = 0; i < start; i++) ops.push({ type: 'equal', aIndex: i, bIndex: i });

    var midA = aKeys.slice(start, aEnd);
    var midB = bKeys.slice(start, bEnd);
    var approximate = false;

    if (midA.length && midB.length) {
      var total = midA.length + midB.length;
      var maxD = Math.min(total, MAX_EDIT_DISTANCE, Math.max(64, Math.floor(WORK_BUDGET / total)));
      var midOps = myers(midA, midB, maxD);
      if (midOps) {
        for (i = 0; i < midOps.length; i++) {
          var op = midOps[i];
          ops.push({
            type: op.type,
            aIndex: op.aIndex >= 0 ? op.aIndex + start : -1,
            bIndex: op.bIndex >= 0 ? op.bIndex + start : -1
          });
        }
      } else {
        approximate = true;
        for (i = start; i < aEnd; i++) ops.push({ type: 'delete', aIndex: i, bIndex: -1 });
        for (j = start; j < bEnd; j++) ops.push({ type: 'insert', aIndex: -1, bIndex: j });
      }
    } else {
      for (i = start; i < aEnd; i++) ops.push({ type: 'delete', aIndex: i, bIndex: -1 });
      for (j = start; j < bEnd; j++) ops.push({ type: 'insert', aIndex: -1, bIndex: j });
    }

    for (i = aEnd, j = bEnd; i < aKeys.length; i++, j++) ops.push({ type: 'equal', aIndex: i, bIndex: j });

    return { ops: ops, approximate: approximate };
  }

  /*
   * Turn the op stream into rows the renderers can walk straight down.
   *
   * A run of deletions sitting next to a run of insertions is zipped into
   * paired `change` rows, which is what keeps the two columns lined up;
   * whatever is left over becomes a one-sided row with a blank facing cell.
   */
  function buildRows(ops, aLines, bLines) {
    var rows = [];
    var i = 0;

    while (i < ops.length) {
      if (ops[i].type === 'equal') {
        rows.push({
          kind: 'equal',
          left: { num: ops[i].aIndex + 1, text: aLines[ops[i].aIndex] },
          right: { num: ops[i].bIndex + 1, text: bLines[ops[i].bIndex] }
        });
        i++;
        continue;
      }

      var run = [];
      while (i < ops.length && ops[i].type !== 'equal') { run.push(ops[i]); i++; }

      var dels = [];
      var adds = [];
      for (var r = 0; r < run.length; r++) {
        if (run[r].type === 'delete') dels.push(run[r]); else adds.push(run[r]);
      }

      var n = Math.max(dels.length, adds.length);
      for (var k = 0; k < n; k++) {
        var d = dels[k];
        var s = adds[k];
        var left = d ? { num: d.aIndex + 1, text: aLines[d.aIndex] } : null;
        var right = s ? { num: s.bIndex + 1, text: bLines[s.bIndex] } : null;
        if (d && s) rows.push({ kind: 'change', left: left, right: right });
        else if (d) rows.push({ kind: 'del', left: left, right: null });
        else rows.push({ kind: 'add', left: null, right: right });
      }
    }

    return rows;
  }

  /* Replace long stretches of identical lines with a `skip` band that the UI
   * can expand in place, keeping `context` rows of breathing room either side. */
  function collapseUnchanged(rows, context) {
    if (context === undefined) context = 3;
    var out = [];
    var i = 0;

    while (i < rows.length) {
      if (rows[i].kind !== 'equal') { out.push(rows[i]); i++; continue; }

      var j = i;
      while (j < rows.length && rows[j].kind === 'equal') j++;

      var lead = i === 0 ? 0 : context;
      var trail = j === rows.length ? 0 : context;
      var k;

      if (j - i > lead + trail + 1) {
        for (k = i; k < i + lead; k++) out.push(rows[k]);
        var hidden = rows.slice(i + lead, j - trail);
        out.push({ kind: 'skip', count: hidden.length, hidden: hidden });
        for (k = j - trail; k < j; k++) out.push(rows[k]);
      } else {
        for (k = i; k < j; k++) out.push(rows[k]);
      }
      i = j;
    }

    return out;
  }

  function countStats(rows) {
    var stats = { added: 0, removed: 0, changed: 0, unchanged: 0 };
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].kind === 'add') stats.added++;
      else if (rows[i].kind === 'del') stats.removed++;
      else if (rows[i].kind === 'change') stats.changed++;
      else if (rows[i].kind === 'equal') stats.unchanged++;
    }
    return stats;
  }

  /*
   * One call does the whole job: raw text in, rows + stats out.
   *
   * `ignoreBlankLines` drops blank lines before the diff runs, so they are
   * absent from the result entirely. Line numbers still come from the original
   * text, which is why the numbering shows gaps when the option is on.
   */
  function compare(textA, textB, opts) {
    opts = opts || {};

    var rawA = splitLines(textA);
    var rawB = splitLines(textB);
    var aLines = [];
    var bLines = [];
    var aNums = [];
    var bNums = [];
    var i;

    for (i = 0; i < rawA.length; i++) {
      if (opts.ignoreBlankLines && isBlank(rawA[i])) continue;
      aLines.push(rawA[i]);
      aNums.push(i + 1);
    }
    for (i = 0; i < rawB.length; i++) {
      if (opts.ignoreBlankLines && isBlank(rawB[i])) continue;
      bLines.push(rawB[i]);
      bNums.push(i + 1);
    }

    var result = diffLines(aLines, bLines, opts);
    var rows = buildRows(result.ops, aLines, bLines);

    // Map the compacted indices back onto real line numbers in the source text.
    for (i = 0; i < rows.length; i++) {
      if (rows[i].left) rows[i].left.num = aNums[rows[i].left.num - 1];
      if (rows[i].right) rows[i].right.num = bNums[rows[i].right.num - 1];
    }

    return {
      rows: rows,
      stats: countStats(rows),
      approximate: result.approximate,
      identical: rows.every(function (row) { return row.kind === 'equal'; })
    };
  }

  return {
    compare: compare,
    splitLines: splitLines,
    normalizeLine: normalizeLine,
    diffLines: diffLines,
    buildRows: buildRows,
    collapseUnchanged: collapseUnchanged,
    countStats: countStats
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DiffEngine;
