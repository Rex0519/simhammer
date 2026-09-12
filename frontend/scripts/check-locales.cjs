#!/usr/bin/env node
/**
 * Localization audit. `npm run check:locales`
 *
 * en_US is the source of truth: features add keys there and translations follow
 * later, so a locale being behind is normal — `t()` falls back to English, so a
 * missing key renders the English string rather than breaking. Coverage is
 * therefore reported, not enforced.
 *
 * Three things ARE errors, because each means a file is wrong rather than behind:
 *   - a key referenced in code but absent from en_US (nothing to fall back to,
 *     so the raw key reaches the screen)
 *   - a key a locale still carries after en_US dropped it (dead weight that
 *     hides real drift)
 *   - a translation whose {placeholders} don't match en_US: a dropped {count}
 *     silently loses the number, and an invented one renders literally
 */
const fs = require('node:fs');
const path = require('node:path');

const LOCALES = path.join(__dirname, '..', 'src', 'locales');
const SRC = path.join(__dirname, '..', 'src');

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const locales = {};
for (const file of fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json')).sort()) {
  locales[path.basename(file, '.json')] = read(path.join(LOCALES, file));
}
const base = locales.en_US;
const baseKeys = Object.keys(base);

// ── coverage, informational ─────────────────────────────────────────────────
console.log(`en_US: ${baseKeys.length} keys\n`);
console.log('locale      keys  missing  coverage  untranslated');
const stale = [];
for (const [name, data] of Object.entries(locales)) {
  if (name === 'en_US') continue;
  const keys = Object.keys(data);
  const missing = baseKeys.filter((k) => !(k in data));
  // Byte-identical to English: usually a passthrough nobody has translated yet.
  const same = keys.filter((k) => k in base && data[k] === base[k]).length;
  const extra = keys.filter((k) => !(k in base));
  if (extra.length) stale.push([name, extra]);
  const coverage = (100 * (baseKeys.length - missing.length)) / baseKeys.length;
  console.log(
    `${name.padEnd(10)}${String(keys.length).padStart(5)}${String(missing.length).padStart(9)}` +
      `${coverage.toFixed(1).padStart(9)}%${String(same).padStart(14)}`
  );
}

// ── what is missing, grouped so it points at a feature ──────────────────────
const byPrefix = new Map();
for (const [name, data] of Object.entries(locales)) {
  if (name === 'en_US') continue;
  for (const k of baseKeys.filter((key) => !(key in data))) {
    const prefix = k.split('.')[0];
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
  }
}
if (byPrefix.size) {
  console.log('\nmissing translations by feature (total across locales):');
  for (const [prefix, n] of [...byPrefix].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${prefix.padEnd(16)}${String(n).padStart(5)}`);
  }
}

// ── keys referenced in code ─────────────────────────────────────────────────
const referenced = new Set();
let dynamic = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry.name)) {
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*(['"`])([^'"`]+)\1/g)) {
        // Template literals with an interpolation are resolved at runtime.
        if (!m[2].includes('${')) referenced.add(m[2]);
      }
      dynamic += [...text.matchAll(/\bt\(\s*[A-Za-z_$]/g)].length;
    }
  }
};
walk(SRC);

const undefinedKeys = [...referenced].filter((k) => !(k in base)).sort();
console.log(
  `\nreferenced by a literal: ${referenced.size} keys ` +
    `(+${dynamic} dynamic call sites, not checkable)`
);

// ── placeholder agreement ───────────────────────────────────────────────────
const placeholders = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
const sameSet = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));
const mismatched = [];
for (const [name, data] of Object.entries(locales)) {
  if (name === 'en_US') continue;
  for (const k of Object.keys(data)) {
    if (!(k in base)) continue;
    const want = placeholders(base[k]);
    const got = placeholders(data[k]);
    if (!sameSet(want, got)) {
      mismatched.push(`${name} ${k}: {${[...got].join('} {')}} vs en_US {${[...want].join('} {')}}`);
    }
  }
}

// ── errors ──────────────────────────────────────────────────────────────────
let failed = false;
if (mismatched.length) {
  failed = true;
  console.log(`\nERROR: placeholders disagree with en_US (${mismatched.length}):`);
  for (const m of mismatched) console.log(`  ${m}`);
}
if (undefinedKeys.length) {
  failed = true;
  console.log(`\nERROR: referenced in code but missing from en_US (${undefinedKeys.length}):`);
  for (const k of undefinedKeys) console.log(`  ${k}`);
}
if (stale.length) {
  failed = true;
  console.log('\nERROR: keys en_US no longer has, still carried by:');
  for (const [name, keys] of stale) console.log(`  ${name}: ${keys.join(', ')}`);
}

console.log(failed ? '\nFAILED' : '\nOK');
process.exit(failed ? 1 : 0);
