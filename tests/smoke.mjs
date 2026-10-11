/**
 * jsdom smoke test for the JSON Viewer content script.
 *
 * Run with: npm test
 *
 * Covers: takeover detection (positive + negative), the single formatted view
 * with line numbers, font discovery via both channels (native relay + canvas
 * probe), system dark-mode following, copy fallback, stats, error pages, and
 * the stylesheet/manifest contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.join(here, '..', 'extension');
const SRC = fs.readFileSync(path.join(extDir, 'content.js'), 'utf8');
const CSS = fs.readFileSync(path.join(extDir, 'styles.css'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
function eq(got, want, label) {
  ok(got === want, label + ' (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')');
}
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function makeDom(html, opts = {}) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (err) => {
    const msg = String(err && err.message);
    if (!/getContext|navigation/.test(msg)) console.error('jsdomError:', err);
  });
  const dom = new JSDOM(html, {
    url: opts.url || 'https://example.com/api/data.json',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const w = dom.window;
  if (opts.contentType) {
    Object.defineProperty(w.document, 'contentType', { value: opts.contentType, configurable: true });
  }
  if (opts.beforeEval) opts.beforeEval(w);
  if (w.document.readyState !== 'complete') {
    await new Promise((res) => w.addEventListener('load', res, { once: true }));
  }
  w.eval(SRC);
  return dom;
}

/** Replaces window.matchMedia so the test controls prefers-color-scheme. */
function stubSystemTheme(w, dark) {
  const listeners = [];
  const mq = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener(_type, fn) { listeners.push(fn); },
    removeEventListener() {},
    addListener(fn) { listeners.push(fn); },
    removeListener() {}
  };
  w.matchMedia = () => mq;
  return {
    set(d) {
      mq.matches = d;
      listeners.forEach((fn) => fn.call(mq, { matches: d, media: mq.media }));
    }
  };
}

/** Fake canvas font probing: installed fonts measure differently from the
 *  baseline; monospaced fonts give 'i' and 'W' the same advance. */
function stubCanvas(w, { mono = [], proportional = [] } = {}) {
  w.HTMLCanvasElement.prototype.getContext = function () {
    let font = '';
    return {
      set font(v) { font = String(v); },
      get font() { return font; },
      measureText(str) {
        const name = (font.match(/"([^"]+)"/) || [])[1] || '';
        const installed = mono.includes(name) || proportional.includes(name);
        const isMono = mono.includes(name);
        if (str === 'i') return { width: 10 };
        if (str === 'W') return { width: isMono ? 10 : 30 };
        return { width: installed ? 500 : 400 }; // probe string
      }
    };
  };
}

const click = (dom, node) =>
  node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
const change = (dom, node) =>
  node.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

const SAMPLE = {
  name: 'demo',
  count: 3,
  ok: true,
  missing: null,
  tags: ['alpha', 'beta'],
  nested: { x: 1, deep: { y: 'z' } },
  url: 'https://api.example.com/v1/items?page=2&limit=10',
  note: 'see https://foo.bar/docs now',
  long: 'x'.repeat(200)
};
const PRETTY = JSON.stringify(SAMPLE, null, 2);
const PRETTY_LINES = PRETTY.split('\n').length;

/* ------------------------------------------------------------------ test 1 */
async function testSingleView() {
  console.log('\n[1] takeover: single formatted view with line numbers');
  const dom = await makeDom(
    '<!doctype html><html><head><title>data</title></head><body><pre>' +
    esc(PRETTY) + '</pre></body></html>'
  );
  const doc = dom.window.document;

  ok(doc.documentElement.classList.contains('jv-html'), 'html carries jv-html class');
  ok(!!doc.querySelector('.jv-root'), 'viewer root rendered');

  /* single mode: no view/tree controls at all */
  eq(!!doc.querySelector('.jv-tree'), false, 'no tree container');
  eq(!!doc.querySelector('[data-act="view"]'), false, 'view toggle removed');
  eq(!!doc.querySelector('[data-act="collapse"]'), false, 'collapse button removed');
  eq(!!doc.querySelector('.jv-search'), false, 'search box removed');
  eq(!!doc.querySelector('.jv-input'), false, 'search input removed');

  /* toolbar that remains */
  ok(!!doc.querySelector('[data-act="copy"]'), 'copy button present');
  ok(!!doc.querySelector('[data-act="download"]'), 'download button present');
  ok(!!doc.querySelector('[data-act="theme"]'), 'theme button present');
  const sel = doc.querySelector('.jv-select');
  ok(!!sel, 'font picker present');
  eq(sel.options[0].textContent, 'Default font', 'font picker starts with the default entry');
  eq(doc.querySelector('.jv-error').hidden, true, 'no error banner on valid JSON');

  /* top bar: timestamp + request URL (file-name placeholder removed) */
  eq(!!doc.querySelector('.jv-title'), false, 'file-name title removed');
  const urlEl = doc.querySelector('.jv-url');
  ok(!!urlEl, 'request URL element present');
  eq(urlEl && urlEl.textContent, dom.window.location.href, 'full request URL shown');
  const timeEl = doc.querySelector('.jv-time');
  ok(!!timeEl, 'timestamp element present');
  ok(timeEl && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeEl.textContent),
    'timestamp reads YYYY-MM-DD HH:mm:ss: ' + (timeEl && timeEl.textContent));

  /* layout: URL on top, timestamp (+stats) below, no { } placeholder */
  eq(!!doc.querySelector('.jv-logo'), false, 'placeholder { } logo removed');
  const stack = doc.querySelector('.jv-stack');
  ok(!!stack, 'two-line identity stack present');
  eq(stack && stack.firstElementChild, urlEl, 'URL is the top line');
  ok(!!stack && stack.contains(timeEl), 'timestamp sits below the URL');
  eq(!!doc.querySelector('.jv-meta .jv-time'), true, 'timestamp lives in the meta row');
  eq(!!doc.querySelector('.jv-meta .jv-stats'), true, 'stats share the timestamp line');
  eq(!!doc.querySelector('.jv-sep'), true, 'separator dot between time and stats');

  /* line height is fixed at 1.8 — no picker anymore */
  eq(!!doc.querySelector('.jv-select[aria-label="Line height"]'), false,
    'line-height picker removed');
  eq(doc.querySelector('.jv-root').style.getPropertyValue('--jv-lh'), '',
    'no inline line-height override');

  /* rendered content */
  eq(doc.querySelector('.jv-pre').hidden, false, 'formatted view visible');
  eq(doc.querySelectorAll('.jv-ln').length, PRETTY_LINES,
    'one numbered block per line (' + PRETTY_LINES + ')');
  ok(doc.querySelector('.jv-ln').textContent.includes('{'), 'first line is the opening brace');
  ok(!!doc.querySelector('.jv-pre .t-key'), 'keys highlighted');
  ok(!!doc.querySelector('.jv-pre .t-str'), 'strings highlighted');
  ok(!!doc.querySelector('.jv-pre .t-num'), 'numbers highlighted');
  ok(doc.querySelector('.jv-pre').textContent.includes('"name": "demo"'),
    'full document text present');

  /* links inside string values */
  const links = [...doc.querySelectorAll('a.jv-link')];
  eq(links.length, 2, 'URL values rendered as links');
  eq(links[0].getAttribute('href'), 'https://api.example.com/v1/items?page=2&limit=10',
    'href keeps the full URL incl. query string');
  eq(links[0].getAttribute('target'), '_blank', 'opens in a new tab');
  ok(/noopener/.test(links[0].getAttribute('rel') || ''), 'rel carries noopener');
  eq(links[0].getAttribute('title'), null, 'no tooltip at rest (plain-string look)');
  eq(links[0].className, 'jv-link', 'no state class on the link at rest');
  eq(links[1].getAttribute('href'), 'https://foo.bar/docs', 'URL inside prose is linkified');
  const noteLine = [...doc.querySelectorAll('.jv-ln')].find((l) => l.textContent.includes('see '));
  ok(!!noteLine && noteLine.textContent.includes('see https://foo.bar/docs now'),
    'surrounding prose text kept intact');
  eq(doc.querySelector('.jv-key') && links[0].closest('.jv-key'), null,
    'keys never become links');

  /* click policy: plain click stays put, modified click opens */
  const plainClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  links[0].dispatchEvent(plainClick);
  eq(plainClick.defaultPrevented, true, 'plain click is blocked (document stays)');
  const cmdClick = new dom.window.MouseEvent('click',
    { bubbles: true, cancelable: true, metaKey: true });
  links[1].dispatchEvent(cmdClick);
  eq(cmdClick.defaultPrevented, false, 'Cmd+Click is handed to the browser');

  /* back-to-top button */
  const topBtn = doc.querySelector('.jv-top');
  ok(!!topBtn, 'back-to-top button present');
  eq(topBtn.getAttribute('data-act'), 'top', 'wired through data-act');
  eq(topBtn.textContent, '\u2191', 'renders the up arrow');
  ok(!topBtn.classList.contains('is-visible'), 'hidden at the top of the page');
  Object.defineProperty(dom.window, 'scrollY', { value: 1200, configurable: true });
  dom.window.scrollTo = () => { /* jsdom stub */ };
  dom.window.dispatchEvent(new dom.window.Event('scroll'));
  ok(topBtn.classList.contains('is-visible'), 'appears after scrolling down');
  let scrollArg = null;
  dom.window.scrollTo = (arg) => { scrollArg = arg; };
  click(dom, topBtn);
  ok(!!scrollArg && scrollArg.top === 0 && scrollArg.behavior === 'smooth',
    'click smooth-scrolls to the top');
  ok(!topBtn.classList.contains('is-visible'), 'hides again right away');
  Object.defineProperty(dom.window, 'scrollY', { value: 0, configurable: true });

  /* Cmd-held affordance */
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Meta', bubbles: true }));
  ok(doc.querySelector('.jv-root').classList.contains('is-cmd'),
    'links arm while Cmd is held');
  doc.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Meta', bubbles: true }));
  ok(!doc.querySelector('.jv-root').classList.contains('is-cmd'), 'disarmed on keyup');

  /* theme button cycles */
  eq(doc.querySelector('.jv-root').getAttribute('data-theme'), 'light',
    'auto theme resolves to light without system dark');
  click(dom, doc.querySelector('[data-act="theme"]'));
  eq(doc.querySelector('.jv-root').getAttribute('data-theme'), 'dark', 'cycles to dark');
  eq(doc.querySelector('[data-act="theme"]').textContent, 'Dark', 'button label follows state');
  click(dom, doc.querySelector('[data-act="theme"]'));
  eq(doc.querySelector('.jv-root').getAttribute('data-theme'), 'light', 'cycles to light');

  /* font picker applies through --jv-mono */
  const opt = doc.createElement('option');
  opt.value = 'Menlo';
  opt.textContent = 'Menlo';
  sel.appendChild(opt);
  sel.value = 'Menlo';
  change(dom, sel);
  ok(doc.querySelector('.jv-root').style.getPropertyValue('--jv-mono').includes('Menlo'),
    'choosing a font sets --jv-mono');
  sel.value = '';
  change(dom, sel);
  eq(doc.querySelector('.jv-root').style.getPropertyValue('--jv-mono'), '',
    'default font clears the override');

  /* copy fallback (no clipboard in jsdom) */
  click(dom, doc.querySelector('[data-act="copy"]'));
  await sleep(50);
  ok(!!doc.querySelector('.jv-toast.is-show'), 'copy shows a toast');

  /* stats */
  await sleep(150);
  const stats = doc.querySelector('.jv-stats').textContent;
  ok(/lines/.test(stats), 'stats line rendered: ' + stats);
  ok(/keys/.test(stats), 'stats include key count');

  dom.window.close();
}

/* ------------------------------------------------------------------ test 2 */
async function testNoTakeover() {
  console.log('\n[2] real HTML pages are left alone');
  const dom = await makeDom(
    '<!doctype html><html><head><title>page</title></head>' +
    '<body><div class="app">hi</div><pre>{"a":1}</pre></body></html>',
    { url: 'https://example.com/index.html' }
  );
  const doc = dom.window.document;
  eq(!!doc.querySelector('.jv-root'), false, 'page with real DOM is not hijacked');
  eq(doc.documentElement.classList.contains('jv-html'), false, 'no jv-html class added');
  eq(doc.querySelector('.app').textContent, 'hi', 'original DOM untouched');

  const dom2 = await makeDom(
    '<!doctype html><html><head></head><body><pre>just some text</pre></body></html>',
    { url: 'https://example.com/readme.txt' }
  );
  eq(!!dom2.window.document.querySelector('.jv-root'), false,
    'plain text (non JSON) document untouched');
  dom.window.close();
  dom2.window.close();
}

/* ------------------------------------------------------------------ test 3 */
async function testJsonErrorPage() {
  console.log('\n[3] invalid JSON with application/json content type');
  const dom = await makeDom(
    '<!doctype html><html><head></head><body><pre>{"broken": </pre></body></html>',
    { contentType: 'application/json' }
  );
  const doc = dom.window.document;
  ok(!!doc.querySelector('.jv-root'), 'error page still takes over');
  eq(doc.querySelector('.jv-error').hidden, false, 'error banner visible');
  ok(/Invalid JSON/.test(doc.querySelector('.jv-error').textContent),
    'error banner labelled: ' + doc.querySelector('.jv-error').textContent.trim());
  eq(doc.querySelector('.jv-pre').hidden, false, 'raw text available below the error');
  ok(doc.querySelector('.jv-pre').textContent.includes('{"broken"'),
    'raw text actually rendered (not an empty pane)');
  dom.window.close();
}

/* ------------------------------------------------------------------ test 4 */
async function testArrayRoot() {
  console.log('\n[4] array root document');
  const arr = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, 'plain'];
  const pretty = JSON.stringify(arr, null, 2);
  const dom = await makeDom(
    '<!doctype html><html><head></head><body><pre>' + esc(pretty) + '</pre></body></html>'
  );
  const doc = dom.window.document;
  ok(!!doc.querySelector('.jv-root'), 'array document taken over');
  eq(doc.querySelectorAll('.jv-ln').length, pretty.split('\n').length,
    'array renders one numbered block per line');
  ok(doc.querySelector('.jv-pre').textContent.includes('"plain"'),
    'primitive array element rendered');
  dom.window.close();
}

/* ------------------------------------------------------------------ test 5 */
async function testSystemDarkMode() {
  console.log('\n[5] auto theme follows the system dark-mode switch');
  let theme;
  const dom = await makeDom(
    '<!doctype html><html><head></head><body><pre>{"a": 1}</pre></body></html>',
    { beforeEval: (w) => { theme = stubSystemTheme(w, true); } }
  );
  const doc = dom.window.document;
  eq(doc.documentElement.getAttribute('data-theme'), 'dark',
    'html[data-theme] is dark when the system is dark');
  eq(doc.querySelector('.jv-root').getAttribute('data-theme'), 'dark',
    'root data-theme is dark as well');

  click(dom, doc.querySelector('[data-act="theme"]'));
  eq(doc.querySelector('[data-act="theme"]').textContent, 'Dark',
    'theme button cycles to an explicit Dark');
  theme.set(false); // system switches to light
  eq(doc.documentElement.getAttribute('data-theme'), 'dark',
    'explicit dark preference ignores the system switch');
  dom.window.close();

  let theme2;
  const dom2 = await makeDom(
    '<!doctype html><html><head></head><body><pre>{"a": 1}</pre></body></html>',
    { beforeEval: (w) => { theme2 = stubSystemTheme(w, true); } }
  );
  const doc2 = dom2.window.document;
  eq(doc2.documentElement.getAttribute('data-theme'), 'dark', 'starts dark (system dark)');
  theme2.set(false);
  eq(doc2.documentElement.getAttribute('data-theme'), 'light',
    'auto theme re-resolves when the system flips to light');
  theme2.set(true);
  eq(doc2.documentElement.getAttribute('data-theme'), 'dark',
    'auto theme re-resolves when the system flips back to dark');
  dom2.window.close();
}

/* ------------------------------------------------------------------ test 6 */
async function testFontListNative() {
  console.log('\n[6] font list from the native app (via background relay)');
  const NATIVE = ['Fira Code', 'Menlo', 'Zebra Mono'];
  const dom = await makeDom(
    '<!doctype html><html><head></head><body><pre>{"a": 1}</pre></body></html>',
    {
      beforeEval: (w) => {
        w.browser = { runtime: { sendMessage: () => Promise.resolve({ fonts: NATIVE }) } };
      }
    }
  );
  await sleep(150);
  const sel = dom.window.document.querySelector('.jv-select');
  const values = [...sel.options].map((o) => o.value);
  eq(sel.options[0].textContent, 'Default font',
    'default entry kept: ' + values.join(', '));
  for (const f of NATIVE) ok(values.includes(f), 'native font listed: ' + f);
  eq(values.length, 1 + NATIVE.length, 'no duplicate entries');
  eq([...sel.options].map((o) => o.value)[0], '', '"Default font" stays first');
  dom.window.close();
}

/* ------------------------------------------------------------------ test 7 */
async function testFontListCanvas() {
  console.log('\n[7] canvas font probe fallback (preview pages)');

  // installed + monospaced → listed; unknown → skipped
  const dom = await makeDom(
    '<!doctype html><html><head></head><body><pre>{"a": 1}</pre></body></html>',
    { beforeEval: (w) => stubCanvas(w, { mono: ['Menlo', 'JetBrains Mono'] }) }
  );
  await sleep(80);
  let values = [...dom.window.document.querySelector('.jv-select').options].map((o) => o.value);
  ok(values.includes('Menlo'), 'installed mono font detected: ' + values.join(', '));
  ok(values.includes('JetBrains Mono'), 'second mono font detected');
  ok(!values.includes('SF Mono'), 'missing font not listed');
  dom.window.close();

  // installed but proportional → rejected by the monospace check
  const dom2 = await makeDom(
    '<!doctype html><html><head></head><body><pre>{"a": 1}</pre></body></html>',
    { beforeEval: (w) => stubCanvas(w, { proportional: ['Menlo'] }) }
  );
  await sleep(80);
  values = [...dom2.window.document.querySelector('.jv-select').options].map((o) => o.value);
  ok(!values.includes('Menlo'), 'proportional font rejected by the i==W check');
  eq(values.length, 1, 'only the default entry remains');
  dom2.window.close();
}

/* ------------------------------------------------------------------ test 8 */
async function testContracts() {
  console.log('\n[8] stylesheet & manifest contract (static checks)');
  ok(CSS.includes("html.jv-html[data-theme='dark']"),
    'dark palette is keyed on html[data-theme] (matches what JS sets)');
  ok(CSS.includes('counter-reset: jv-line'), 'line-number counter reset present');
  ok(CSS.includes('counter-increment: jv-line'), 'line-number counter increment present');
  ok(CSS.includes('.jv-ln::before'), 'line-number gutter styled');
  ok(!/border-right/.test(CSS), 'no divider line in the gutter');
  ok(/scrollbar-width:\s*none/.test(CSS), 'scrollbars hidden (standard property)');
  ok(/::-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(CSS),
    'scrollbars hidden (WebKit)');
  ok(!/scrollbar-thumb/.test(CSS), 'old scrollbar styling fully removed');
  ok(!CSS.includes('.jv-tree') && !CSS.includes('.jv-toggle'), 'tree styles fully removed');
  ok(CSS.includes('.jv-select'), 'pickers styled');
  ok(CSS.includes('--jv-lh: 1.8'), 'line height fixed at 1.8');
  ok((CSS.match(/var\(--jv-lh\)/g) || []).length >= 4,
    'line-height variable drives root / pre / line block / gutter');
  ok(!CSS.includes('.jv-title'), 'file-name styles removed');
  ok(CSS.includes('.jv-time') && CSS.includes('.jv-url'), 'timestamp + request URL styled');
  ok(CSS.includes('.jv-stack') && CSS.includes('.jv-meta'), 'two-line stack styled');
  ok(!CSS.includes('.jv-logo'), 'logo styles removed');
  ok(/\.jv-url\s*\{[^}]*text-overflow:\s*ellipsis/.test(CSS),
    'long URL truncates with an ellipsis');
  ok(/\.jv-url\s*\{[^}]*min-width:\s*8ch/.test(CSS),
    'URL never collapses below 8ch');
  ok(/\.jv-url\s*\{[^}]*cursor:\s*pointer/.test(CSS), 'URL is click-to-copy');
  ok(/\.jv-top\s*\{[^}]*position:\s*fixed/.test(CSS), 'back-to-top is fixed-positioned');
  ok(CSS.includes('.jv-top.is-visible'), 'back-to-top visibility state styled');
  ok(CSS.includes('.jv-link'), 'link styles present');
  ok(CSS.includes('.is-cmd'), 'Cmd-held link state present');
  ok(CSS.includes('.jv-root.is-cmd .jv-link:hover'),
    'hover effect is gated behind the Cmd-held state');
  ok(CSS.includes('cursor: default'), 'no hand cursor at rest');
  ok(!/text-decoration-style:\s*dotted/.test(CSS), 'no resting underline on links');

  ok((MANIFEST.permissions || []).includes('nativeMessaging'),
    'nativeMessaging permission present (system font list)');
  ok((MANIFEST.permissions || []).includes('storage'), 'storage permission present');
  ok(!MANIFEST.browser_action && !MANIFEST.action, 'no toolbar action (single-mode view)');
  ok(Array.isArray(MANIFEST.background?.scripts), 'background relay kept');

  /* welcome window shows the version + repo, and every version stays in sync */
  const projRoot = path.join(here, '..');
  const mainHtml = fs.readFileSync(
    path.join(projRoot, 'xcode/JSON Viewer/JSON Viewer/Resources/Base.lproj/Main.html'), 'utf8');
  const pbxproj = fs.readFileSync(
    path.join(projRoot, 'xcode/JSON Viewer/JSON Viewer.xcodeproj/project.pbxproj'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(projRoot, 'package.json'), 'utf8'));
  ok(mainHtml.includes('v' + MANIFEST.version),
    'welcome window shows the version (v' + MANIFEST.version + ')');
  ok(mainHtml.includes('github.com/xlab6/json-viewer-safari'),
    'welcome window shows the GitHub address');
  eq((pbxproj.match(/MARKETING_VERSION = /g) || []).length, 4, 'four MARKETING_VERSION entries');
  ok(pbxproj.includes('MARKETING_VERSION = ' + MANIFEST.version + ';'),
    'MARKETING_VERSION matches the manifest version');
  eq(pkg.version, MANIFEST.version, 'package.json version matches the manifest');
}

/* ------------------------------------------------------------------ test 9 */
async function testBackgroundRelay() {
  console.log('\n[9] background relay: content -> native handler');
  const BG = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8');

  function loadBackground(sendNativeMessage) {
    const listeners = [];
    const browserMock = {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendNativeMessage
      }
    };
    const noop = () => 0;
    // eslint-disable-next-line no-new
    new Function('browser', 'chrome', 'setTimeout', 'clearTimeout', BG)(
      browserMock, undefined, noop, () => {}
    );
    return listeners[0];
  }

  const calls = [];
  const listener = loadBackground((id, msg, cb) => {
    calls.push({ id, msg });
    cb({ fonts: ['Menlo', 'JetBrains Mono'] });
  });
  eq(typeof listener, 'function', 'onMessage listener registered');

  let response;
  const keepAlive = listener({ type: 'jv-system-fonts' }, {}, (payload) => { response = payload; });
  eq(keepAlive, true, 'listener keeps the channel open for async reply');
  eq(calls.length, 1, 'exactly one native call');
  eq(calls[0].id, 'cn.oxzz.json-viewer', 'routes to the containing app id');
  eq(calls[0].msg.action, 'listMonospaceFonts', 'asks for the system font list');
  eq(JSON.stringify(response), JSON.stringify({ fonts: ['Menlo', 'JetBrains Mono'] }),
    'fonts relayed back to the content script');

  response = 'sentinel';
  eq(listener({ type: 'something-else' }, {}, () => { response = 'called'; }), false,
    'unrelated messages are ignored');
  eq(response, 'sentinel', 'no reply for unrelated messages');

  const failing = loadBackground(() => { throw new Error('native unavailable'); });
  let failedReply = 'unset';
  failing({ type: 'jv-system-fonts' }, {}, (payload) => { failedReply = payload; });
  eq(failedReply, null, 'native failure degrades to null (canvas fallback takes over)');
}

/* ----------------------------------------------------------------- test 10 */
async function testLongUrlBar() {
  console.log('\n[10] long request URL handling');
  const longHref = 'https://api.example.com/v1/resources/' + 'a'.repeat(50) +
    '?filter=' + 'b'.repeat(60);
  const dom = await makeDom(
    '<!doctype html><html><head></head><body><pre>{"a":1}</pre></body></html>',
    { url: longHref }
  );
  const doc = dom.window.document;
  const u = doc.querySelector('.jv-url');
  ok(!!u, 'URL element present');
  ok(u.textContent.includes('\u2026'), 'middle ellipsis used');
  ok(u.textContent.length < longHref.length,
    'display shortened (' + u.textContent.length + ' < ' + longHref.length + ')');
  ok(u.textContent.startsWith('https://api.example.com'),
    'head (scheme + host + path start) kept');
  ok(u.textContent.endsWith(longHref.slice(-24)),
    'tail (end of the query string) kept');
  ok(u.title.includes(longHref), 'tooltip still carries the full URL');
  eq(u.getAttribute('data-act'), 'copy-url', 'clicking copies the full URL');

  u.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(50);
  ok(!!doc.querySelector('.jv-toast.is-show'), 'clicking the URL shows a copy toast');
  dom.window.close();
}

try {
  await testSingleView();
  await testNoTakeover();
  await testJsonErrorPage();
  await testArrayRoot();
  await testSystemDarkMode();
  await testFontListNative();
  await testFontListCanvas();
  await testContracts();
  await testBackgroundRelay();
  await testLongUrlBar();
} catch (err) {
  failed++;
  console.error('\nUNCAUGHT: ' + (err && err.stack ? err.stack : err));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
