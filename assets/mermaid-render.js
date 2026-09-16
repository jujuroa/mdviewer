// Renders mermaid diagrams on behalf of the main process (see
// renderMermaidSvg in main.js), inside a hidden BrowserWindow.
//
// mermaid is a browser library that lays diagrams out by measuring real
// rendered text, so it needs a DOM: the main process has none, and the
// preview iframe it ultimately draws into is sandboxed without scripts.
// A hidden window is the one place in the app that can run it — and going
// through the main process means the same rendered SVG serves the preview
// and the PDF export.
//
// The mermaid bundle itself is injected by the main process with
// webContents.executeJavaScript rather than pulled in by a <script> tag
// here: it lives outside the asar in thirdparty/ (see
// scripts/prepare-mermaid.js), where this page's own relative paths cannot
// reach it.

(() => {
  const host = document.getElementById('mermaid-host');
  let initialized = false;
  let counter = 0;

  function initOnce() {
    if (initialized) return;
    window.mermaid.initialize({
      startOnLoad: false,
      // Diagrams sit on the preview's white diagram card in both app themes
      // (exactly as PlantUML's do), so they are always rendered light —
      // which also keeps the PDF export, always printed light, correct.
      theme: 'default',
      securityLevel: 'strict',
      fontFamily:
        '"Nanum Gothic", "NanumGothic", -apple-system, "Segoe UI", "Malgun Gothic", Roboto, sans-serif',
    });
    initialized = true;
  }

  // Two things have to be fixed up before the diagram can be handed to the
  // preview as <img src="data:image/svg+xml;...">:
  //
  //  * Well-formedness. mermaid draws its labels as HTML inside
  //    <foreignObject>, so a label written with <br/> comes back as an
  //    unclosed <br> — valid HTML, invalid XML. An SVG data URI is parsed
  //    by the *XML* parser, where a single unclosed tag fails the whole
  //    document and the image silently doesn't load. Parsing the string as
  //    HTML (which accepts it) and serializing it back as XML (which always
  //    closes tags) makes the markup safe to embed, labels intact.
  //
  //  * Intrinsic size. mermaid sizes the <svg> with width:100% and a
  //    max-width style, which an <img> has nothing to resolve against — it
  //    would draw the default 300x150 box. Pinning width/height from the
  //    viewBox keeps the size mermaid laid the diagram out at.
  function normalizeSvg(svgText) {
    const parsed = new DOMParser().parseFromString(svgText, 'text/html');
    const svg = parsed.body.querySelector('svg');
    if (!svg) return svgText;
    const viewBox = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
      svg.setAttribute('width', String(Math.ceil(viewBox[2])));
      svg.setAttribute('height', String(Math.ceil(viewBox[3])));
    }
    svg.style.removeProperty('max-width');
    return new XMLSerializer().serializeToString(svg);
  }

  // One diagram at a time: every render shares this page's single host
  // element, so overlapping calls would tear down each other's temporary
  // nodes. main.js renders a document's diagrams in sequence for the same
  // reason; this keeps that true however it is called.
  let queue = Promise.resolve();

  window.__renderMermaid = (source) => {
    const run = async () => {
      initOnce();
      const id = `mdviewer-mermaid-${counter++}`;
      try {
        const { svg } = await window.mermaid.render(id, source, host);
        return normalizeSvg(svg);
      } finally {
        host.innerHTML = '';
      }
    };
    // Keep the chain alive even when a render rejects, so one bad diagram
    // doesn't wedge every diagram after it.
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  };
})();
