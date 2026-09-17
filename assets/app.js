/*
 * app.js - everything that touches the page.
 *
 * All diff output is built with createElement + textContent. Nothing user
 * supplied ever goes near innerHTML, which removes both HTML-escaping bugs
 * and any injection path in one go.
 */
(function () {
  'use strict';

  var STORE_KEY = 'diffcheck.v1';
  var STORE_TEXT_LIMIT = 100 * 1024;  // don't stuff huge pastes into localStorage
  var FILE_LIMIT = 5 * 1024 * 1024;   // refuse files bigger than this
  var LIVE_LINE_LIMIT = 20000;        // above this, wait for the Compare button
  var RENDER_ROW_LIMIT = 5000;        // above this, truncate the rendered diff
  var CONTEXT = 3;
  var DEBOUNCE_MS = 250;

  function $(id) { return document.getElementById(id); }

  var els = {
    a: $('input-a'), b: $('input-b'),
    paneA: $('pane-a'), paneB: $('pane-b'),
    metaA: $('meta-a'), metaB: $('meta-b'),
    fileA: $('file-a'), fileB: $('file-b'),
    loadA: $('load-a'), loadB: $('load-b'),
    compare: $('compare'), swap: $('swap'), clear: $('clear'),
    optCase: $('opt-case'), optWs: $('opt-ws'),
    optBlank: $('opt-blank'), optCollapse: $('opt-collapse'),
    viewSplit: $('view-split'), viewUnified: $('view-unified'),
    stats: $('stats'), notice: $('notice'), output: $('output')
  };

  var state = { view: 'split', result: null, fileError: '' };
  var debounceTimer = null;

  /* ---------------------------------------------------------------- state */

  function options() {
    return {
      ignoreCase: els.optCase.checked,
      ignoreWhitespace: els.optWs.checked,
      ignoreBlankLines: els.optBlank.checked
    };
  }

  function restore() {
    var saved;
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    } catch (e) {
      saved = {};
    }
    if (typeof saved.a === 'string') els.a.value = saved.a;
    if (typeof saved.b === 'string') els.b.value = saved.b;
    els.optCase.checked = !!saved.ignoreCase;
    els.optWs.checked = !!saved.ignoreWhitespace;
    els.optBlank.checked = !!saved.ignoreBlankLines;
    els.optCollapse.checked = saved.collapse !== false;
    if (saved.view === 'unified') state.view = 'unified';
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        a: els.a.value.length <= STORE_TEXT_LIMIT ? els.a.value : '',
        b: els.b.value.length <= STORE_TEXT_LIMIT ? els.b.value : '',
        ignoreCase: els.optCase.checked,
        ignoreWhitespace: els.optWs.checked,
        ignoreBlankLines: els.optBlank.checked,
        collapse: els.optCollapse.checked,
        view: state.view
      }));
    } catch (e) {
      /* private mode, quota, blocked storage - the page works regardless */
    }
  }

  /* --------------------------------------------------------------- render */

  function cell(classes, text) {
    var node = document.createElement('div');
    node.className = 'cell ' + classes;
    node.textContent = text === undefined ? '' : text;
    return node;
  }

  function num(side, value, tone) {
    return cell('cell-num ' + (side === 'b' ? 'col-b ' : '') + tone, value === null ? '' : String(value));
  }

  function skipBand(band) {
    var wrap = document.createElement('div');
    wrap.className = 'cell skip';
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = '⋯ show ' + band.count + ' unchanged line' + (band.count === 1 ? '' : 's');
    button.setAttribute('aria-expanded', 'false');
    wrap.appendChild(button);
    wrap._band = band;
    return wrap;
  }

  function splitRowCells(row, frag) {
    if (row.kind === 'skip') { frag.appendChild(skipBand(row)); return; }

    var leftTone = row.kind === 'equal' ? 's-eq' : (row.left ? 's-del' : 's-empty');
    var rightTone = row.kind === 'equal' ? 's-eq' : (row.right ? 's-add' : 's-empty');

    frag.appendChild(num('a', row.left ? row.left.num : null, leftTone));
    frag.appendChild(cell('cell-sign ' + leftTone, row.left && row.kind !== 'equal' ? '−' : ''));
    frag.appendChild(cell('cell-text ' + leftTone, row.left ? row.left.text : ''));

    frag.appendChild(num('b', row.right ? row.right.num : null, rightTone));
    frag.appendChild(cell('cell-sign ' + rightTone, row.right && row.kind !== 'equal' ? '+' : ''));
    frag.appendChild(cell('cell-text ' + rightTone, row.right ? row.right.text : ''));
  }

  function unifiedRowCells(row, frag) {
    if (row.kind === 'skip') { frag.appendChild(skipBand(row)); return; }

    if (row.kind === 'equal') {
      frag.appendChild(num('a', row.left.num, 's-eq'));
      frag.appendChild(num('b', row.right.num, 's-eq'));
      frag.appendChild(cell('cell-sign s-eq', ''));
      frag.appendChild(cell('cell-text s-eq', row.left.text));
      return;
    }
    // a changed line becomes a removed row followed by an added row
    if (row.left) {
      frag.appendChild(num('a', row.left.num, 's-del'));
      frag.appendChild(num('b', null, 's-del'));
      frag.appendChild(cell('cell-sign s-del', '−'));
      frag.appendChild(cell('cell-text s-del', row.left.text));
    }
    if (row.right) {
      frag.appendChild(num('a', null, 's-add'));
      frag.appendChild(num('b', row.right.num, 's-add'));
      frag.appendChild(cell('cell-sign s-add', '+'));
      frag.appendChild(cell('cell-text s-add', row.right.text));
    }
  }

  function rowsToFragment(rows, view) {
    var frag = document.createDocumentFragment();
    var emit = view === 'unified' ? unifiedRowCells : splitRowCells;
    for (var i = 0; i < rows.length; i++) emit(rows[i], frag);
    return frag;
  }

  function emptyState(message) {
    var p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = message;
    return p;
  }

  function render() {
    var out = els.output;
    out.textContent = '';

    var result = state.result;
    if (!result) {
      out.appendChild(emptyState('Enter text on both sides to see the differences.'));
      return;
    }
    if (result.rows.length === 0) {
      out.appendChild(emptyState('Both sides are empty.'));
      return;
    }

    var rows = els.optCollapse.checked
      ? DiffEngine.collapseUnchanged(result.rows, CONTEXT)
      : result.rows;

    var truncated = false;
    if (rows.length > RENDER_ROW_LIMIT) {
      rows = rows.slice(0, RENDER_ROW_LIMIT);
      truncated = true;
    }

    var grid = document.createElement('div');
    grid.className = 'diff diff-' + state.view;
    grid.appendChild(rowsToFragment(rows, state.view));
    out.appendChild(grid);

    if (truncated) {
      out.appendChild(emptyState('Showing the first ' + RENDER_ROW_LIMIT +
        ' rows. Turn on "Hide unchanged lines" or compare smaller texts to see the rest.'));
    }
  }

  function renderStats() {
    var node = els.stats;
    node.textContent = '';
    node.className = 'stats';

    var result = state.result;
    if (!result) {
      node.textContent = 'Enter text on both sides to see the differences.';
      return;
    }
    if (result.rows.length === 0) {
      node.textContent = 'Both sides are empty.';
      return;
    }
    if (result.identical) {
      node.className = 'stats identical';
      node.textContent = 'No differences — the two texts are identical.';
      return;
    }

    var s = result.stats;
    var parts = [
      ['n-add', s.added, 'added'],
      ['n-del', s.removed, 'removed'],
      ['n-chg', s.changed, 'changed']
    ];
    for (var i = 0; i < parts.length; i++) {
      if (i > 0) node.appendChild(document.createTextNode(' · '));
      var span = document.createElement('span');
      span.className = parts[i][0];
      span.textContent = String(parts[i][1]);
      node.appendChild(span);
      node.appendChild(document.createTextNode(' ' + parts[i][2]));
    }
    node.appendChild(document.createTextNode(' · ' + s.unchanged + ' unchanged'));
  }

  function setNotice(messages) {
    var text = messages.filter(Boolean).join(' ');
    els.notice.textContent = text;
    els.notice.hidden = text === '';
  }

  function updateMeta(textarea, node) {
    var value = textarea.value;
    if (value === '') { node.textContent = 'empty'; return; }
    var lines = DiffEngine.splitLines(value).length;
    node.textContent = lines.toLocaleString() + (lines === 1 ? ' line' : ' lines') +
      ' · ' + value.length.toLocaleString() + ' characters';
  }

  /* -------------------------------------------------------------- compare */

  function lineCount(value) {
    if (value === '') return 0;
    var n = 1;
    for (var i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) n++;
    return n;
  }

  function tooBigForLive() {
    return lineCount(els.a.value) > LIVE_LINE_LIMIT || lineCount(els.b.value) > LIVE_LINE_LIMIT;
  }

  function runCompare() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }

    if (els.a.value === '' && els.b.value === '') {
      state.result = null;
    } else {
      state.result = DiffEngine.compare(els.a.value, els.b.value, options());
    }

    renderStats();
    render();
    setNotice([
      state.fileError,
      state.result && state.result.approximate
        ? 'These texts differ too much for a line-by-line match, so the changed block is shown as one removal followed by one addition.'
        : '',
      tooBigForLive() ? 'Live comparing is off for texts this large — press Compare when you are ready.' : ''
    ]);
    persist();
  }

  function scheduleCompare() {
    updateMeta(els.a, els.metaA);
    updateMeta(els.b, els.metaB);
    state.fileError = '';

    if (debounceTimer) clearTimeout(debounceTimer);
    if (tooBigForLive()) {
      setNotice(['Live comparing is off for texts this large — press Compare when you are ready.']);
      persist();
      return;
    }
    debounceTimer = setTimeout(runCompare, DEBOUNCE_MS);
  }

  function setView(view) {
    state.view = view;
    els.viewSplit.setAttribute('aria-pressed', String(view === 'split'));
    els.viewUnified.setAttribute('aria-pressed', String(view === 'unified'));
    render();   // the diff is already computed; only the layout changes
    persist();
  }

  /* ----------------------------------------------------------------- files */

  function loadFile(file, textarea) {
    if (!file) return;
    if (file.size > FILE_LIMIT) {
      state.fileError = '"' + file.name + '" is larger than 5 MB, so it was not loaded.';
      setNotice([state.fileError]);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      textarea.value = String(reader.result);
      state.fileError = '';
      updateMeta(els.a, els.metaA);
      updateMeta(els.b, els.metaB);
      runCompare();
    };
    reader.onerror = function () {
      state.fileError = '"' + file.name + '" could not be read.';
      setNotice([state.fileError]);
    };
    reader.readAsText(file);
  }

  function wireDropZone(pane, textarea) {
    var depth = 0; // dragleave also fires moving between children, so count

    pane.addEventListener('dragenter', function (event) {
      if (!event.dataTransfer) return;
      event.preventDefault();
      depth++;
      pane.classList.add('dragging');
    });
    pane.addEventListener('dragover', function (event) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    pane.addEventListener('dragleave', function () {
      depth = Math.max(0, depth - 1);
      if (depth === 0) pane.classList.remove('dragging');
    });
    pane.addEventListener('drop', function (event) {
      event.preventDefault();
      depth = 0;
      pane.classList.remove('dragging');
      var files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length) loadFile(files[0], textarea);
    });
  }

  /* ------------------------------------------------------------------ wire */

  restore();

  els.a.addEventListener('input', scheduleCompare);
  els.b.addEventListener('input', scheduleCompare);

  els.compare.addEventListener('click', runCompare);

  els.swap.addEventListener('click', function () {
    var tmp = els.a.value;
    els.a.value = els.b.value;
    els.b.value = tmp;
    updateMeta(els.a, els.metaA);
    updateMeta(els.b, els.metaB);
    runCompare();
  });

  els.clear.addEventListener('click', function () {
    els.a.value = '';
    els.b.value = '';
    state.fileError = '';
    updateMeta(els.a, els.metaA);
    updateMeta(els.b, els.metaB);
    runCompare();
    els.a.focus();
  });

  [els.optCase, els.optWs, els.optBlank].forEach(function (box) {
    box.addEventListener('change', runCompare);
  });
  els.optCollapse.addEventListener('change', function () { render(); persist(); });

  els.viewSplit.addEventListener('click', function () { setView('split'); });
  els.viewUnified.addEventListener('click', function () { setView('unified'); });

  els.loadA.addEventListener('click', function () { els.fileA.click(); });
  els.loadB.addEventListener('click', function () { els.fileB.click(); });
  els.fileA.addEventListener('change', function () { loadFile(els.fileA.files[0], els.a); els.fileA.value = ''; });
  els.fileB.addEventListener('change', function () { loadFile(els.fileB.files[0], els.b); els.fileB.value = ''; });

  wireDropZone(els.paneA, els.a);
  wireDropZone(els.paneB, els.b);

  // a file dropped anywhere else would otherwise navigate away and lose the page
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      runCompare();
    }
  });

  // expand a collapsed band in place, without recomputing the diff
  els.output.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('.skip button') : null;
    if (!button) return;
    var wrap = button.parentNode;
    var band = wrap._band;
    if (!band) return;
    wrap.parentNode.replaceChild(rowsToFragment(band.hidden, state.view), wrap);
  });

  setView(state.view);
  updateMeta(els.a, els.metaA);
  updateMeta(els.b, els.metaB);
  runCompare();
})();
