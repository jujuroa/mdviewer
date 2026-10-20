// Source files the app opens in the text viewer/editor and shows highlighted
// like a fenced code block of their language. Shared by the main process
// (require) and the pages (a plain <script>, as window.MdvCodeLanguages), so
// the viewer and the editor agree on what each file is highlighted as.
(function (root) {
  // Extension -> highlight.js language.
  const CODE_LANGUAGE_BY_EXT = {
    c: 'c', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'arduino',
    cs: 'csharp', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy', gradle: 'gradle',
    go: 'go', rs: 'rust', swift: 'swift', m: 'objectivec', mm: 'objectivec', dart: 'dart',
    py: 'python', pyw: 'python', rb: 'ruby', php: 'php', pl: 'perl', pm: 'perl', lua: 'lua', r: 'r',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
    html: 'xml', htm: 'xml', xhtml: 'xml', xml: 'xml', xaml: 'xml', xsd: 'xml', xsl: 'xml', vue: 'xml',
    css: 'css', scss: 'scss', less: 'less',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    bat: 'dos', cmd: 'dos', nsi: 'nsis', nsh: 'nsis',
    sql: 'sql', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', properties: 'properties',
    cmake: 'cmake', mk: 'makefile', dockerfile: 'dockerfile', proto: 'protobuf',
    vb: 'vbnet', fs: 'fsharp', diff: 'diff', patch: 'diff', graphql: 'graphql', gql: 'graphql', tex: 'latex',
  };

  // Above this size a source file is shown unhighlighted: highlight.js would
  // stall the render (and every keystroke in the editor) for seconds.
  const CODE_HIGHLIGHT_MAX_LENGTH = 512 * 1024;

  // The highlight.js language for a file: the table above first, then
  // whatever highlight.js itself knows the extension as (so a custom
  // extension like .svg is highlighted too). Null for plain text, and when
  // `hljs` doesn't have the language.
  function codeLanguageOf(filePath, hljs) {
    const m = /\.([a-z0-9]+)$/i.exec(filePath || '');
    if (!m || !hljs) return null;
    const ext = m[1].toLowerCase();
    if (ext === 'txt' || ext === 'log') return null;
    const lang = CODE_LANGUAGE_BY_EXT[ext] || ext;
    const def = hljs.getLanguage(lang);
    return def && def.name !== 'Plain text' ? lang : null;
  }

  const api = { CODE_LANGUAGE_BY_EXT, CODE_HIGHLIGHT_MAX_LENGTH, codeLanguageOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MdvCodeLanguages = api;
})(this);
