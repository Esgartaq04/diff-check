# diff-check

A small diff checker you can host on GitHub Pages. Paste or drop two texts and
the differences are highlighted **in place, on the same page** — no new tab, no
upload, no round trip to a server.

## Features

- **Side-by-side and inline views**, switchable without recomputing the diff.
- **Line-level highlighting** — removals in red with a `−` marker, additions in
  green with a `+`, so the diff still reads without colour.
- **Hide unchanged lines**, collapsing long identical stretches into a band you
  can click to expand.
- **Comparison options**: ignore case, ignore leading/trailing whitespace,
  ignore blank lines. These change what counts as a match; the text shown is
  always your original.
- **Drag & drop a file** onto either box, or use *Load file*. Files are read in
  your browser with `FileReader` and never leave the machine.
- Live comparing as you type, plus a Compare button and <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd>.
- Light and dark, following your system setting. Your text and options are
  remembered locally between visits.

No dependencies, no build step, no CDN. Three hand-written files.

## Running it locally

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

`index.html` also works if you just double-click it — the scripts are plain
`<script>` tags rather than modules, so `file://` is fine too.

## Publishing to GitHub Pages

`.github/workflows/pages.yml` deploys the site on every push to `main`.

1. In the repository, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Push to `main`. The workflow publishes to `https://<user>.github.io/diff-check/`.

The workflow only fires on `main`, so work on a feature branch goes live once
it is merged. `workflow_dispatch` is enabled if you want to trigger a deploy by
hand from the Actions tab.

## How it works

| File | Role |
| --- | --- |
| `index.html` | Page structure |
| `assets/styles.css` | Layout and colours, light + dark |
| `assets/diff.js` | The diff engine — pure functions, no DOM |
| `assets/app.js` | Rendering, options, files, drag & drop |

`assets/diff.js` peels off the common prefix and suffix of the two texts and
runs a **Myers greedy O((N+M)·D) diff** over what is left, which is what keeps a
one-line edit in a large file effectively free. If two texts are both large and
almost entirely unrelated, the edit distance is capped and the middle is shown
as one removal block followed by one addition block rather than letting the page
hang; the results panel says so when that happens.

The engine has no DOM dependency, so it can be driven straight from Node:

```sh
node -e "
  const D = require('./assets/diff.js');
  const r = D.compare('one\ntwo\nthree', 'one\nTWO\nthree');
  console.log(r.stats, r.rows.map(x => x.kind));
"
```

Rendering builds every node with `createElement` + `textContent`; no user text
ever reaches `innerHTML`.
