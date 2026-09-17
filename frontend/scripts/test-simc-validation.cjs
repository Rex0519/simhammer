const assert = require('node:assert/strict');
const { test } = require('node:test');
require('./register-typescript.cjs');
const {
  UNSIMMABLE_SPECS,
  specIsSimmable,
  specFromTalentString,
  effectiveSpec,
} = require('../src/app/lib/simcDetect.ts');

test('the five specs SimC rejects are not simmable', () => {
  for (const [cls, spec] of [
    ['paladin', 'holy'],
    ['priest', 'discipline'],
    ['priest', 'holy'],
    ['monk', 'mistweaver'],
    ['evoker', 'preservation'],
  ]) {
    assert.equal(specIsSimmable(cls, spec), false, `${cls}/${spec}`);
  }
});

test('restoration druid and shaman stay simmable', () => {
  // SimC sims both as DPS actors — a blanket healer rule would wrongly block them.
  assert.equal(specIsSimmable('druid', 'restoration'), true);
  assert.equal(specIsSimmable('shaman', 'restoration'), true);
});

test('unsimmable is scoped per class', () => {
  assert.equal(specIsSimmable('paladin', 'retribution'), true);
  assert.equal(specIsSimmable('priest', 'shadow'), true);
  assert.equal(specIsSimmable('evoker', 'augmentation'), true);
});

test('unknown specs are treated as simmable', () => {
  assert.equal(specIsSimmable('paladin', 'notaspec'), true);
  assert.equal(specIsSimmable('', ''), true);
});

test('a talent loadout overrides the spec= line', () => {
  // Colite's Holy loadout decodes to Holy Paladin (spec 65).
  const holy =
    'CEEAzbn3egSOtoSwvPw1U1vTLAAAALAwMAAD2GzMzMjZmZBmZYZsZmFjmYYMzMMmtMAMAsB2YZmZmlZbmZ2aAAAAWAGsZgZMDzAAYmhZMGNA';
  assert.equal(specFromTalentString(holy), 'holy');
  const profile = 'paladin="Colite"\nlevel=90\nspec=holy\n';
  assert.equal(effectiveSpec(profile, holy), 'holy');
  assert.equal(effectiveSpec(profile, ''), 'holy');
});

test('a garbage talent string falls back to the spec= line', () => {
  assert.equal(specFromTalentString('not-a-talent-string'), '');
  assert.equal(effectiveSpec('paladin="C"\nspec=holy\n', 'not-a-talent-string'), 'holy');
});

test('a profile with no spec line yields an empty effective spec', () => {
  assert.equal(effectiveSpec('hunter="T"\nlevel=90\n', ''), '');
});

test('the TS list matches UNSIMMABLE_SPECS in the Rust source', () => {
  // The two lists are duplicated by necessity (Rust gate + browser gate). This
  // is the only thing stopping them drifting apart.
  const fs = require('node:fs');
  const path = require('node:path');
  const rust = fs.readFileSync(
    path.join(__dirname, '../../backend/core/src/types/class_data.rs'),
    'utf8'
  );
  const body = rust.match(/const UNSIMMABLE_SPECS: &\[\(&str, &str\)\] = &\[([\s\S]*?)\];/)?.[1];
  assert.ok(body, 'UNSIMMABLE_SPECS not found in class_data.rs');
  const fromRust = [...body.matchAll(/\("(\w+)",\s*"(\w+)"\)/g)].map((m) => `${m[1]}/${m[2]}`);
  assert.equal(fromRust.length, 5, 'expected 5 entries in the Rust list');
  assert.deepEqual(
    fromRust.sort(),
    UNSIMMABLE_SPECS.map(([c, s]) => `${c}/${s}`).sort()
  );
});
