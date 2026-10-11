#!/usr/bin/env node
/** Validates extension/manifest.json and that every referenced file exists. */
'use strict';

const fs = require('fs');
const path = require('path');

const extDir = path.join(__dirname, '..', 'extension');
const manifestPath = path.join(extDir, 'manifest.json');
const errors = [];

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error('FAIL cannot parse manifest.json: ' + e.message);
  process.exit(1);
}

function need(cond, msg) { if (!cond) errors.push(msg); }
function fileExists(rel) { return fs.existsSync(path.join(extDir, rel)); }

need(manifest.manifest_version === 2, 'manifest_version must be 2 (Safari Web Extensions)');
need(typeof manifest.name === 'string' && manifest.name.length > 0, 'name is required');
need(typeof manifest.version === 'string' && /^\d+(\.\d+)*$/.test(manifest.version), 'version must look like 1.0.0');
need(typeof manifest.description === 'string' && manifest.description.length > 0, 'description is required');

const perms = manifest.permissions || [];
need(perms.indexOf('storage') !== -1, 'storage permission expected (theme/font persistence)');
need(perms.indexOf('nativeMessaging') !== -1,
  'nativeMessaging permission expected (system monospace font list)');
need(!manifest.browser_action && !manifest.action,
  'no toolbar action expected — the view has a single mode now');

// icons
const iconMap = Object.assign({}, manifest.icons || {},
  (manifest.browser_action && manifest.browser_action.default_icon) || {},
  (manifest.action && manifest.action.default_icon) || {});
for (const [size, rel] of Object.entries(iconMap)) {
  need(fileExists(rel), 'missing icon ' + rel + ' (size ' + size + ')');
}

// background
for (const s of (manifest.background && manifest.background.scripts) || []) {
  need(fileExists(s), 'missing background script ' + s);
}

// content scripts
const cs = manifest.content_scripts || [];
need(cs.length > 0, 'at least one content_scripts entry expected');
for (const entry of cs) {
  need(Array.isArray(entry.matches) && entry.matches.length > 0, 'content script needs matches');
  for (const j of entry.js || []) need(fileExists(j), 'missing content script ' + j);
  for (const c of entry.css || []) need(fileExists(c), 'missing content css ' + c);
}

// referenced files should live inside extension/ (nothing escapes it)
const allRefs = [
  ...Object.values(iconMap),
  ...((manifest.background && manifest.background.scripts) || []),
  ...cs.flatMap((e) => [...(e.js || []), ...(e.css || [])])
];
for (const rel of allRefs) {
  const abs = path.resolve(extDir, rel);
  if (!abs.startsWith(extDir + path.sep)) errors.push('path escapes extension dir: ' + rel);
}

if (errors.length) {
  for (const e of errors) console.error('FAIL ' + e);
  process.exit(1);
}
console.log('ok   manifest.json valid (' + manifest.name + ' v' + manifest.version + '), ' +
  allRefs.length + ' referenced files present');
