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

  // mermaid sizes its <svg> with width:100% plus a max-width style, which
  // has no intrinsic size to fall back on once the SVG is shown as an <img>
  // (browsers then draw it at the default 300x150). Pin width/height from
  // the viewBox so the diagram keeps the size mermaid laid it out at.
  function pinSvgSize(svgText) {
    const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = parsed.documentElement;
    if (!svg || svg.nodeName !== 'svg') return svgText;
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
        return pinSvgSize(svg);
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
