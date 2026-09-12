const assert = require('node:assert/strict');
const { test } = require('node:test');
require('./register-typescript.cjs');
const {
  folioRows,
  parseOmniumEntryIds,
  seedSelection,
  primaryOmniumString,
  folioCombos,
  combinationCount,
  extraSelectedCount,
  folioSelectionForImport,
  primaryOmniumOverride,
  runeLabel,
} = require('../src/app/components/omnium/omniumSelection.ts');

// Two rows of the real tree: row 4 (four runes) and row 5 (three runes).
// posY is deliberately out of order to prove rows sort by it.
const TREE = {
  traitTreeId: 1186,
  nodes: [
    {
      id: 110271,
      type: 'choice',
      posY: 4500,
      entries: [
        { id: 136814, name: 'Rune of Overload', spellId: 1279614, index: 100 },
        { id: 136824, name: 'Rune of Residual Energy', spellId: 1279615, index: 200 },
        { id: 136826, name: 'Rune of Echoes', spellId: 1279616, index: 300 },
      ],
    },
    {
      id: 110272,
      type: 'choice',
      posY: 3900,
      entries: [
        { id: 136815, name: 'Rune of Critical Power', spellId: 1279609, index: 100 },
        { id: 136818, name: 'Rune of Masterful Cunning', spellId: 1279612, index: 300 },
        { id: 136820, name: 'Rune of the Versatile Warrior', spellId: 1279613, index: 400 },
      ],
    },
  ],
};

const EXPORT = `hunter="Sørtbek"
level=90
spec=beast_mastery
omnium_talents=136814:1/136818:1
head=,id=249988
`;

test('rows come back in tree order, top row first', () => {
  assert.deepEqual(
    folioRows(TREE).map((row) => row.id),
    [110272, 110271]
  );
});

test('the exported folio line yields its entry ids', () => {
  assert.deepEqual(parseOmniumEntryIds(EXPORT), [136814, 136818]);
});

test('a profile with no folio line yields no ids', () => {
  assert.deepEqual(parseOmniumEntryIds('hunter="T"\ntalents=C0PAD57\n'), []);
});

test('the seed puts each exported rune on its own row', () => {
  assert.deepEqual(seedSelection(TREE, parseOmniumEntryIds(EXPORT)), {
    110272: [136818],
    110271: [136814],
  });
});

test('the primary folio takes the first pick per row, top row first', () => {
  const selection = { 110272: [136818, 136815], 110271: [136814] };
  assert.equal(primaryOmniumString(TREE, selection), '136818:1/136814:1');
});

test('one varying row produces one combo per rune, the primary first', () => {
  const selection = { 110272: [136818], 110271: [136814, 136826] };
  assert.deepEqual(folioCombos(TREE, selection), [
    { name: 'Overload', omnium_string: '136818:1/136814:1' },
    { name: 'Echoes', omnium_string: '136818:1/136826:1' },
  ]);
});

test('two varying rows multiply, and the name names both', () => {
  const selection = { 110272: [136818, 136815], 110271: [136814, 136826] };
  const combos = folioCombos(TREE, selection);
  assert.equal(combos.length, 4);
  assert.deepEqual(
    combos.map((c) => c.name),
    [
      'Masterful Cunning · Overload',
      'Masterful Cunning · Echoes',
      'Critical Power · Overload',
      'Critical Power · Echoes',
    ]
  );
  assert.equal(combos[3].omnium_string, '136815:1/136826:1');
});

test('nothing varying needs no combos at all', () => {
  assert.deepEqual(folioCombos(TREE, { 110272: [136818], 110271: [136814] }), []);
});

test('an empty row drops out of the folio instead of blanking it', () => {
  const selection = { 110272: [], 110271: [136814, 136826] };
  assert.deepEqual(folioCombos(TREE, selection), [
    { name: 'Overload', omnium_string: '136814:1' },
    { name: 'Echoes', omnium_string: '136826:1' },
  ]);
  assert.equal(primaryOmniumString(TREE, selection), '136814:1');
});

test('the combination count is the product of the rows', () => {
  assert.equal(combinationCount({ 110272: [136818, 136815], 110271: [136814, 136826] }), 4);
  assert.equal(combinationCount({ 110272: [136818], 110271: [136814] }), 1);
  assert.equal(combinationCount({}), 1);
  // An empty row contributes nothing rather than multiplying by zero.
  assert.equal(combinationCount({ 110272: [], 110271: [136814, 136826] }), 2);
});

test('the section badge counts only runes added on top of the seed', () => {
  const seed = { 110272: [136818], 110271: [136814] };
  assert.equal(extraSelectedCount(seed, seed), 0);
  assert.equal(extraSelectedCount({ 110272: [136818], 110271: [136814, 136826] }, seed), 1);
  // Swapping a row's pick is a change, not an addition.
  assert.equal(extraSelectedCount({ 110272: [136815], 110271: [136814] }, seed), 1);
});

test('an untouched folio sends no override, whatever order the export listed', () => {
  // The export lists bottom row first; the picker reads top row first. Same
  // runes either way, so there is nothing to override.
  const seeded = seedSelection(TREE, parseOmniumEntryIds(EXPORT));
  assert.equal(primaryOmniumOverride(TREE, seeded, EXPORT), '');
});

test('changing a row sends the whole folio as an override', () => {
  const changed = { 110272: [136815], 110271: [136814] };
  assert.equal(primaryOmniumOverride(TREE, changed, EXPORT), '136815:1/136814:1');
});

test('extra picks in a row do not themselves change the primary folio', () => {
  // Row 5 gains a second rune: the combinations axis handles that, and the
  // primary folio is still the one the character has equipped.
  const widened = { 110272: [136818], 110271: [136814, 136826] };
  assert.equal(primaryOmniumOverride(TREE, widened, EXPORT), '');
});

test('a profile with no folio line takes the picked folio as an override', () => {
  const picked = { 110272: [136818], 110271: [136814] };
  assert.equal(primaryOmniumOverride(TREE, picked, 'hunter="T"\n'), '136818:1/136814:1');
});

test('an export the tree does not fully know sends no override', () => {
  // The app's folio data can lag a character's export (a rune added mid-season).
  // seedSelection drops the ids it cannot place, and sending that reduced folio
  // as an override would silently sim the character without the missing rune.
  const exportWithUnknownRune = `hunter="T"
omnium_talents=136818:1/999999:1
head=,id=1
`;
  const seeded = seedSelection(TREE, parseOmniumEntryIds(exportWithUnknownRune));
  assert.deepEqual(seeded, { 110272: [136818] }, 'the unknown rune is dropped from the seed');
  assert.equal(
    primaryOmniumOverride(TREE, seeded, exportWithUnknownRune),
    '',
    'an untouched folio must never be rewritten from partial data'
  );
});

// The seeding rule behind SimContext's effect: the folio belongs to the
// imported character, so these four cases decide when the selection is replaced.
test('a new import seeds the folio it names', () => {
  assert.deepEqual(folioSelectionForImport(TREE, EXPORT, null), {
    110272: [136818],
    110271: [136814],
  });
});

test('a new import naming no folio clears the previous character', () => {
  assert.deepEqual(
    folioSelectionForImport(TREE, 'hunter="B"\ntalents=C0PAD57\n', EXPORT),
    {},
    'character B must not inherit character A runes'
  );
});

test('the same import is left alone, so edits survive', () => {
  assert.equal(folioSelectionForImport(TREE, EXPORT, EXPORT), null);
});

test('no tree yet means no decision, rather than blanking a selection', () => {
  assert.equal(folioSelectionForImport(null, EXPORT, null), null);
});

test('rune labels drop the "Rune of" prefix the way the game tooltip reads', () => {
  assert.equal(runeLabel('Rune of Overload'), 'Overload');
  assert.equal(runeLabel('Rune of the Versatile Warrior'), 'The Versatile Warrior');
  assert.equal(runeLabel('Lingering'), 'Lingering');
});
