/**
 * JSON Viewer – content script (Safari Web Extension)
 *
 * Detects JSON documents (by Content-Type or by the shape of the body) and
 * replaces the page with a formatted, line-numbered, syntax-highlighted view
 * of the pretty-printed document:
 *
 *   • one display mode: pretty JSON, per-line syntax highlighting, line numbers
 *   • monospace font picker — the full list of system monospace fonts comes
 *     from the native app extension (via the background relay), with an
 *     in-page canvas probe as the fallback
 *   • light / dark / auto theme that follows the system in real time
 *   • copy & download of the formatted document, size/lines/keys/depth stats
 *
 * Safety rails: only takes over plain documents (single <pre> / bare text or a
 * JSON Content-Type), never real HTML pages, never files over MAX_BYTES.
 */
(function () {
  'use strict';

  if (window.__JSON_VIEWER_ACTIVE__) return;
  window.__JSON_VIEWER_ACTIVE__ = true;

  var api =
    typeof browser !== 'undefined' && browser && browser.runtime ? browser
      : typeof chrome !== 'undefined' && chrome && chrome.runtime ? chrome
      : null;

  var MAX_BYTES = 8 * 1024 * 1024;          // leave bigger documents untouched
  var HIGHLIGHT_LIMIT = 1.5 * 1024 * 1024;  // no highlighting above this size
  var MAX_TEXT_LINES = 20000;               // no line numbers above this count
  var TOP_THRESHOLD = 300;                 // show the back-to-top button past this

  // Monospace-only font picker: default stack + candidates probed on the page
  // (the authoritative list is enumerated natively by SafariWebExtensionHandler).
  var DEFAULT_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, ' +
    'Consolas, "Liberation Mono", "Courier New", monospace';
  var MONO_CANDIDATES = [
    'SF Mono', 'SFMono-Regular', 'Menlo', 'Monaco', 'Andale Mono',
    'Courier New', 'Courier10 Pitch', 'IBM Plex Mono', 'JetBrains Mono',
    'Fira Code', 'Fira Mono', 'Fira Code RC', 'Source Code Pro',
    'Roboto Mono', 'Inconsolata', 'Ubuntu Mono', 'Cascadia Code',
    'Cascadia Mono', 'Hack', 'Anonymous Pro', 'PT Mono', 'Noto Sans Mono',
    'Liberation Mono', 'DejaVu Sans Mono', 'Share Tech Mono', 'Space Mono',
    'DM Mono', 'Victor Mono', 'Maple Mono', 'Sarasa Mono SC',
    'Sarasa Mono TC', 'Sarasa Mono JF', 'WenQuanYi Zen Hei Mono',
    'Nimbus Mono PS', 'Lucida Console', 'Consolas'
  ];

  var S = {
    raw: '',            // original document text
    text: '',           // formatted text (original text when unparsable)
    value: null,        // parsed JSON value
    error: null,        // parse error message (JSON Content-Type pages only)
    theme: 'auto',      // 'auto' | 'dark' | 'light'
    stats: null,
    toast: null,
    topBtn: null,
    root: null,
    preEl: null,
    codeEl: null,
    errEl: null,
    fontSel: null,
    fontsReady: null,   // resolves once the font list has settled
    pendingFont: '',    // saved font waiting to be reflected in the picker
    themeBtn: null,
    mq: null,
    toastTimer: null
  };

  /* ------------------------------------------------------------- utilities */

  function debug(err) {
    try { console.debug('[JSON Viewer]', err); } catch (e) { /* ignore */ }
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function btn(act, label, title) {
    var b = el('button', 'jv-btn', label);
    b.type = 'button';
    b.setAttribute('data-act', act);
    if (title) b.title = title;
    return b;
  }

  function isJsonContentType() {
    try { return /json/i.test(document.contentType || ''); } catch (e) { return false; }
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function fmtNum(n) {
    try { return n.toLocaleString(); } catch (e) { return String(n); }
  }

  function fileName() {
    try {
      var p = decodeURIComponent(location.pathname.split('/').pop() || '');
      if (!p) p = 'data.json';
      if (!/\.json$/i.test(p)) p += '.json';
      return p;
    } catch (e) { return 'data.json'; }
  }

  // 2026-10-11 14:23:05 — local wall-clock time of the render.
  function formatTimestamp(d) {
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // Long request URLs keep BOTH ends — scheme/host/path start and the tail of
  // the query string — with a middle ellipsis. The full URL always stays in
  // the tooltip, and clicking the element copies it.
  function shortenUrl(href, max) {
    max = max || 72;
    if (!href || href.length <= max) return href || '';
    var headLen = Math.max(24, max - 30);
    return href.slice(0, headLen) + '\u2026' + href.slice(-24);
  }

  /* --------------------------------------------------------- page sniffing */

  var OK_TAGS = {
    PRE: 1, SCRIPT: 1, STYLE: 1, BR: 1, NOSCRIPT: 1, TEMPLATE: 1,
    META: 1, LINK: 1, TITLE: 1, HEAD: 1, HTML: 1, BODY: 1
  };

  function readPageText() {
    var body = document.body;
    if (!body) return null;

    var kids = body.children;
    for (var i = 0; i < kids.length; i++) {
      var tag = kids[i].tagName;
      if (!OK_TAGS[tag]) return null;
      if (tag === 'SCRIPT' && kids[i].getAttribute('src')) return null;
    }

    var ctJson = isJsonContentType();
    if (!ctJson) {
      // Not a JSON Content-Type: only take over documents that are nothing but
      // a single <pre> (or bare text) so real HTML pages are never hijacked.
      var plainPre = kids.length === 1 && kids[0].tagName === 'PRE' && kids[0].children.length === 0;
      var bareText = kids.length === 0;
      if (!plainPre && !bareText) return null;
    }

    var text = body.textContent || '';
    var t = text.replace(/^\uFEFF/, '').trim();
    if (t.length < 2 || t.length > MAX_BYTES) return null;
    var first = t.charAt(0);
    if (first !== '{' && first !== '[') return null;
    return t;
  }

  function parseJson(text) {
    try {
      var v = JSON.parse(text);
      if (v === null || typeof v !== 'object') return null; // scalars: not worth hijacking
      return { ok: true, value: v, error: null };
    } catch (e) {
      if (!isJsonContentType()) return null; // only error pages with a JSON type
      return { ok: false, value: null, error: String((e && e.message) || e) };
    }
  }

  function stringify(v) {
    try { return JSON.stringify(v, null, 2); } catch (e) { return S.raw; }
  }

  /* ------------------------------------------------------------------- boot */

  function boot() {
    try {
      var raw = readPageText();
      if (!raw) return;
      var info = parseJson(raw);
      if (!info) return;

      S.raw = raw;
      if (info.ok) {
        S.value = info.value;
        S.text = stringify(info.value);
      } else {
        S.error = info.error;
        S.text = raw;
      }
      render();
      applyTheme();
      hydrateTheme();
      hydrateFont();
      queueStats();
    } catch (err) { debug(err); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  /* -------------------------------------------------------------- rendering */

  function render() {
    var html = document.documentElement;
    html.classList.add('jv-html');

    // wipe the original document
    var body = document.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    body.className = '';
    body.removeAttribute('style');

    var root = el('div', 'jv-root');
    root.setAttribute('data-theme', 'light');
    S.root = root;

    /* --- top bar --- */
    var bar = el('header', 'jv-bar');

    // Two-line identity block: the request URL on top, the render timestamp
    // (and stats) below it; the whole block stays vertically centred.
    var left = el('div', 'jv-left');
    var stack = el('div', 'jv-stack');

    var url = el('span', 'jv-url', shortenUrl(location.href));
    url.title = location.href + '\n(Click to copy the full URL)';
    url.setAttribute('data-act', 'copy-url');
    url.setAttribute('role', 'button');
    stack.appendChild(url);

    var meta = el('div', 'jv-meta');
    var stamp = el('span', 'jv-time', formatTimestamp(new Date()));
    stamp.title = 'Rendered at (local time)';
    meta.appendChild(stamp);
    meta.appendChild(el('span', 'jv-sep', '\u00b7'));
    S.stats = el('span', 'jv-stats');
    meta.appendChild(S.stats);
    stack.appendChild(meta);

    left.appendChild(stack);
    bar.appendChild(left);

    var right = el('div', 'jv-right');
    right.appendChild(btn('copy', 'Copy', 'Copy the formatted JSON'));
    right.appendChild(btn('download', 'Download', 'Download as .json'));

    var fontSel = document.createElement('select');
    fontSel.className = 'jv-select';
    fontSel.setAttribute('aria-label', 'Monospace font');
    fontSel.title = 'Monospace font (\u5b57\u4f53)';
    S.fontSel = fontSel;
    right.appendChild(fontSel);
    S.fontsReady = populateFonts(fontSel);

    S.themeBtn = btn('theme', 'Auto', 'Theme: auto / dark / light');
    right.appendChild(S.themeBtn);

    bar.appendChild(right);
    root.appendChild(bar);

    /* --- main area --- */
    var main = el('main', 'jv-main');

    S.errEl = el('div', 'jv-error');
    S.errEl.hidden = !S.error;
    if (S.error) {
      S.errEl.appendChild(el('strong', 'jv-error-title', 'Invalid JSON'));
      S.errEl.appendChild(el('span', null, ' \u2014 ' + S.error));
    }
    main.appendChild(S.errEl);

    S.preEl = el('pre', 'jv-pre');
    S.codeEl = el('code');
    S.preEl.appendChild(S.codeEl);
    main.appendChild(S.preEl);

    root.appendChild(main);

    S.toast = el('div', 'jv-toast');
    root.appendChild(S.toast);

    // Back-to-top: appears only after scrolling (the scrollbar is hidden, so
    // this doubles as a scroll-position indicator).
    S.topBtn = el('button', 'jv-top', '\u2191');
    S.topBtn.type = 'button';
    S.topBtn.setAttribute('data-act', 'top');
    S.topBtn.setAttribute('aria-label', 'Back to top');
    S.topBtn.title = 'Back to top';
    root.appendChild(S.topBtn);

    body.appendChild(root);

    renderText();
    wire(root);
  }

  /* --------------------------------------------------------------- text UI */

  function countLines(s) {
    var n = 1, i = -1;
    while ((i = s.indexOf('\n', i + 1)) !== -1) n++;
    return n;
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Turns URL substrings inside a JSON string value into clickable <a> links.
  // Returns null when the value carries no link (fast path for plain strings).
  // The value is decoded first so hrefs never contain JSON escapes (\/ etc.).
  function linkifyString(rawInner) {
    if (!/https?:|ftps?:|mailto:/i.test(rawInner)) return null;

    var text;
    try { text = JSON.parse('"' + rawInner + '"'); } catch (e) { return null; }
    if (typeof text !== 'string' || !/https?:|ftps?:|mailto:/i.test(text)) return null;

    var re = /https?:\/\/[^\s<>"']+|ftps?:\/\/[^\s<>"']+|mailto:[^\s<>"']+/gi;
    var out = '', last = 0, m;
    while ((m = re.exec(text))) {
      // Trailing sentence punctuation rarely belongs to the URL itself.
      var url = m[0].replace(/[.,;:!]+$/, '');
      if (!url) continue;
      // No title attribute: a tooltip would reveal the link at rest, and the
      // visible text already IS the URL.
      out += esc(text.slice(last, m.index)) +
        '<a class="jv-link" href="' + esc(url) + '"' +
        ' target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>' +
        esc(m[0].slice(url.length));
      last = m.index + m[0].length;
    }
    if (!out) return null;
    out += esc(text.slice(last));
    return out;
  }

  function highlightJson(src) {
    var out = '', i = 0, n = src.length;
    while (i < n) {
      var c = src.charAt(i);
      if (c === '"') {
        var j = i + 1;
        while (j < n) {
          var ch = src.charAt(j);
          if (ch === '\\') { j += 2; continue; }
          if (ch === '"') { j++; break; }
          j++;
        }
        var k = j, isKey = false;
        while (k < n && (src.charAt(k) === ' ' || src.charAt(k) === '\n' ||
          src.charAt(k) === '\t' || src.charAt(k) === '\r')) k++;
        if (src.charAt(k) === ':') isKey = true;
        var cls = isKey ? 't-key' : 't-str';
        var body = esc(src.slice(i, j));
        if (!isKey) {
          // Only *values* become links; keys stay plain.
          var linkified = linkifyString(src.slice(i + 1, j - 1));
          if (linkified) body = '"' + linkified + '"';
        }
        out += '<span class="' + cls + '">' + body + '</span>';
        i = j;
        continue;
      }
      if (c === '-' || (c >= '0' && c <= '9')) {
        var m = i + 1;
        while (m < n && '0123456789+-.eE'.indexOf(src.charAt(m)) !== -1) m++;
        out += '<span class="t-num">' + esc(src.slice(i, m)) + '</span>';
        i = m;
        continue;
      }
      if (src.substr(i, 4) === 'true' || src.substr(i, 5) === 'false') {
        var len = src.charAt(i) === 't' ? 4 : 5;
        out += '<span class="t-bool">' + src.substr(i, len) + '</span>';
        i += len;
        continue;
      }
      if (src.substr(i, 4) === 'null') {
        out += '<span class="t-null">null</span>';
        i += 4;
        continue;
      }
      if ('{}[],:'.indexOf(c) !== -1) {
        out += '<span class="t-punc">' + c + '</span>';
        i++;
        continue;
      }
      out += esc(c);
      i++;
    }
    return out;
  }

  // One block per line so the CSS counter can print line numbers; very large
  // documents fall back to an unnumbered plain block.
  function renderText() {
    try {
      if (S.text.length > HIGHLIGHT_LIMIT || countLines(S.text) > MAX_TEXT_LINES) {
        S.preEl.classList.add('jv-plain');
        S.codeEl.textContent = S.text;
        return;
      }
      S.preEl.classList.remove('jv-plain');
      var lines = highlightJson(S.text).split('\n');
      var out = '';
      for (var i = 0; i < lines.length; i++) {
        out += '<span class="jv-ln">' + (lines[i] === '' ? '&nbsp;' : lines[i]) + '</span>';
      }
      S.codeEl.innerHTML = out;
    } catch (e) {
      S.preEl.classList.add('jv-plain');
      S.codeEl.textContent = S.text;
      debug(e);
    }
  }

  /* ---------------------------------------------------------------- actions */

  function doAction(act) {
    switch (act) {
      case 'copy': copyText(); break;
      case 'copy-url': copyUrl(); break;
      case 'download': download(); break;
      case 'theme': cycleTheme(); break;
      case 'top': scrollToTop(); break;
      default: break;
    }
  }

  function copyToClipboard(txt, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = txt;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? okMsg : 'Copy failed');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast(okMsg); }, fallback);
    } else {
      fallback();
    }
  }

  function copyText() { copyToClipboard(S.text, 'Copied to clipboard'); }
  function copyUrl() { copyToClipboard(location.href, 'URL copied'); }

  function download() {
    try {
      var name = fileName();
      var blob = new Blob([S.text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('Saved ' + name);
    } catch (e) {
      debug(e);
      toast('Download failed');
    }
  }

  function scrollToTop() {
    if (S.topBtn) S.topBtn.classList.remove('is-visible'); // optimistic: it is going up
    try {
      window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
    } catch (e) {
      try { window.scrollTo(0, 0); } catch (e2) { /* ignore */ }
    }
  }

  /* ----------------------------------------------------------------- theme */

  function ensureMQ() {
    if (S.mq || !window.matchMedia) return S.mq;
    try {
      S.mq = window.matchMedia('(prefers-color-scheme: dark)');
      var handler = function () { if (S.theme === 'auto') applyTheme(); };
      if (S.mq.addEventListener) S.mq.addEventListener('change', handler);
      else if (S.mq.addListener) S.mq.addListener(handler);
    } catch (e) { S.mq = null; }
    return S.mq;
  }

  function applyTheme() {
    if (!S.root) return;
    var mq = ensureMQ();
    var resolved = S.theme === 'auto' ? ((mq && mq.matches) ? 'dark' : 'light') : S.theme;
    // styles.css keys the dark palette on html.jv-html[data-theme] — keep the
    // document element (and the root) in sync, otherwise auto/dark never apply.
    document.documentElement.setAttribute('data-theme', resolved);
    S.root.setAttribute('data-theme', resolved);
    if (S.themeBtn) {
      S.themeBtn.textContent = S.theme === 'auto' ? 'Auto' : (S.theme === 'dark' ? 'Dark' : 'Light');
      S.themeBtn.title = 'Theme: ' + S.theme + ' (click to cycle)';
    }
    try { document.documentElement.style.colorScheme = resolved; } catch (e) { /* ignore */ }
  }

  function cycleTheme() {
    S.theme = S.theme === 'auto' ? 'dark' : S.theme === 'dark' ? 'light' : 'auto';
    applyTheme();
    storageSet({ jvTheme: S.theme });
  }

  function storageGet(key, def) {
    return new Promise(function (resolve) {
      if (!api || !api.storage || !api.storage.local) return resolve(def);
      var done = false;
      var finish = function (items) {
        if (done) return;
        done = true;
        resolve(items && items[key] !== undefined ? items[key] : def);
      };
      try {
        var ret = api.storage.local.get(key, finish);
        if (ret && typeof ret.then === 'function') ret.then(finish, function () { finish(null); });
        else setTimeout(function () { finish(null); }, 300);
      } catch (e) { finish(null); }
    });
  }

  function storageSet(obj) {
    try {
      if (api && api.storage && api.storage.local) api.storage.local.set(obj);
    } catch (e) { /* ignore */ }
  }

  function hydrateTheme() {
    storageGet('jvTheme', 'auto').then(function (t) {
      if (t === 'dark' || t === 'light' || t === 'auto') {
        S.theme = t;
        applyTheme();
      }
    });
  }

  /* ------------------------------------------------------------- font pick */

  // Authoritative source: the native app extension enumerates every installed
  // monospace family (CoreText). Content scripts cannot call sendNativeMessage
  // directly, so the request is relayed by background.js.
  function requestSystemFonts() {
    return new Promise(function (resolve) {
      if (!api || !api.runtime || typeof api.runtime.sendMessage !== 'function') {
        resolve(null);
        return;
      }
      var done = false;
      function fin(v) { if (!done) { done = true; resolve(v); } }
      function fontsOf(resp) {
        return resp && Object.prototype.toString.call(resp.fonts) === '[object Array]'
          ? resp.fonts : null;
      }
      try {
        var r = api.runtime.sendMessage({ type: 'jv-system-fonts' }, function (resp) {
          fin(fontsOf(resp));
        });
        if (r && typeof r.then === 'function') {
          r.then(function (resp) { fin(fontsOf(resp)); }, function () { fin(null); });
        }
      } catch (e) {
        try {
          var r2 = api.runtime.sendMessage({ type: 'jv-system-fonts' });
          if (r2 && typeof r2.then === 'function') {
            r2.then(function (resp) { fin(fontsOf(resp)); }, function () { fin(null); });
          }
        } catch (e2) { fin(null); }
      }
      setTimeout(function () { fin(null); }, 5000);
    });
  }

  // In-page fallback (used in the standalone preview and while the native
  // answer is pending): probe candidate names against a deliberately missing
  // family, then verify the font really is monospaced ('i' == 'W').
  function detectMonospaceFonts() {
    var canvas = document.createElement('canvas');
    var ctx = null;
    try { ctx = canvas.getContext && canvas.getContext('2d'); } catch (e) { ctx = null; }
    if (!ctx || typeof ctx.measureText !== 'function') return [];

    function width(spec, sample) {
      try { ctx.font = spec; return ctx.measureText(sample).width; } catch (e) { return -1; }
    }

    var baseline = width('72px "__jv_no_such_font__"', 'mmmmmmmmmmlli0123456789');
    if (baseline <= 0) return [];

    var found = [];
    for (var i = 0; i < MONO_CANDIDATES.length; i++) {
      var name = MONO_CANDIDATES[i];
      if (found.indexOf(name) !== -1) continue;
      var spec = '72px "' + name + '"';
      if (width(spec, 'mmmmmmmmmmlli0123456789') === baseline) continue; // not installed
      if (width(spec, 'i') !== width(spec, 'W')) continue;               // not monospaced
      found.push(name);
    }
    return found;
  }

  function fontOptionExists(sel, name) {
    var opts = sel.options || [];
    for (var i = 0; i < opts.length; i++) if (opts[i].value === name) return true;
    return false;
  }

  function addFontOption(sel, name) {
    if (!name || fontOptionExists(sel, name)) return false;
    var o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    sel.appendChild(o);
    return true;
  }

  function addFontOptions(sel, names) {
    var added = false;
    for (var i = 0; i < names.length; i++) if (addFontOption(sel, names[i])) added = true;
    if (added) sortFontOptions(sel);
    return added;
  }

  // Keeps "Default font" first and sorts the rest alphabetically.
  function sortFontOptions(sel) {
    var current = sel.value;
    var opts = [];
    for (var i = 1; i < (sel.options ? sel.options.length : 0); i++) opts.push(sel.options[i]);
    opts.sort(function (a, b) { return String(a.value).localeCompare(String(b.value)); });
    for (var j = 0; j < opts.length; j++) sel.appendChild(opts[j]);
    sel.value = current;
  }

  function applyFont(name) {
    if (!S.root) return;
    var safe = name ? String(name).replace(/["'\\]/g, '') : '';
    if (safe) S.root.style.setProperty('--jv-mono', '"' + safe + '", ' + DEFAULT_MONO);
    else S.root.style.removeProperty('--jv-mono');
  }

  function syncPendingFont() {
    var name = S.pendingFont;
    if (!name || !S.fontSel) return;
    addFontOption(S.fontSel, name);
    S.fontSel.value = name;
  }

  function populateFonts(sel) {
    var opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = 'Default font';
    sel.appendChild(opt0);

    addFontOptions(sel, detectMonospaceFonts());

    return requestSystemFonts().then(function (fonts) {
      if (fonts && fonts.length) addFontOptions(sel, fonts);
      sortFontOptions(sel);
      syncPendingFont();
    });
  }

  function hydrateFont() {
    storageGet('jvFont', '').then(function (name) {
      if (!name) return;
      S.pendingFont = name;
      applyFont(name);      // style it immediately; the picker catches up later
      syncPendingFont();
    });
  }

  /* ----------------------------------------------------------------- stats */

  function utf8Size(s) {
    try { return new Blob([s]).size; } catch (e) { return s.length; }
  }

  function analyze(root) {
    if (root === null || typeof root !== 'object') return null;
    var keys = 0, nodes = 0, depth = 0;
    var stack = [{ v: root, d: 1 }];
    while (stack.length) {
      var it = stack.pop();
      if (it.d > depth) depth = it.d;
      var v = it.v;
      nodes += 1;
      if (v === null || typeof v !== 'object') continue;
      if (Array.isArray(v)) {
        for (var i = 0; i < v.length; i++) stack.push({ v: v[i], d: it.d + 1 });
      } else {
        var ks = Object.keys(v);
        keys += ks.length;
        for (var j = 0; j < ks.length; j++) stack.push({ v: v[ks[j]], d: it.d + 1 });
      }
      if (nodes > 2000000) break;
    }
    return { keys: keys, nodes: nodes, depth: depth };
  }

  function queueStats() {
    setTimeout(function () {
      if (!S.stats) return;
      try {
        var parts = [fmtBytes(utf8Size(S.text))];
        if (S.error) {
          parts.push('invalid JSON');
        } else {
          parts.push(fmtNum(countLines(S.text)) + ' lines');
          var a = analyze(S.value);
          if (a) parts.push(fmtNum(a.keys) + ' keys \u00b7 depth ' + a.depth);
        }
        S.stats.textContent = parts.join('  \u00b7  ');
        S.stats.title = fmtNum(utf8Size(S.text)) + ' bytes';
      } catch (e) { debug(e); }
    }, 0);
  }

  /* ----------------------------------------------------------------- toast */

  function toast(msg) {
    if (!S.toast) return;
    S.toast.textContent = msg;
    S.toast.classList.add('is-show');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () {
      S.toast.classList.remove('is-show');
    }, 2400);
  }

  /* ---------------------------------------------------------------- events */

  function wire(root) {
    root.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;

      // Links open only on an explicit modified click (Cmd/Ctrl/Shift/Alt);
      // a plain click never navigates away from the formatted document.
      if (t.closest('a.jv-link')) {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }

      var actEl = t.closest('[data-act]');
      if (actEl && root.contains(actEl)) {
        ev.preventDefault();
        doAction(actEl.getAttribute('data-act'));
      }
    });

    // While Cmd/Ctrl is held every link lights up: that is the gesture that
    // opens it, so make the affordance visible before the click.
    function setArmed(on) { root.classList.toggle('is-cmd', on); }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') setArmed(true);
    }, true);
    document.addEventListener('keyup', function (e) {
      if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt') setArmed(false);
    }, true);
    window.addEventListener('blur', function () { setArmed(false); });

    function onScroll() {
      if (!S.topBtn) return;
      var y = window.scrollY || window.pageYOffset ||
        (document.documentElement && document.documentElement.scrollTop) || 0;
      S.topBtn.classList.toggle('is-visible', y > TOP_THRESHOLD);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    if (S.fontSel) {
      S.fontSel.addEventListener('change', function () {
        S.pendingFont = S.fontSel.value;
        applyFont(S.fontSel.value);
        storageSet({ jvFont: S.fontSel.value });
      });
    }

  }
})();
