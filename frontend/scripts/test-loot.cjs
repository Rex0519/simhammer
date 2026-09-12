const assert = require('node:assert/strict');
const { test } = require('node:test');
require('./register-typescript.cjs');
const {
  lootSelectionReducer: reduce,
  initialLootSelection: initial,
  visibleIds,
} = require('../src/app/components/loot/lootSelection.ts');
const { embellishmentCapReached } = require('../src/app/components/loot/lootTableModel.ts');
const { categoryMayUsePreferredStats } = require('../src/app/components/loot/lootConfiguration.ts');
const {
  resolveDropConfiguration: resolve,
  dropPayload,
  dropWowheadAttr,
} = require('../src/app/components/loot/dropConfiguration.ts');
const { CLASS_SPEC_DATA, CLASS_SPECS, SPEC_ID_TO_NAME } = require('../src/app/lib/classSpecs.ts');
const item = (id, extra = {}) => ({
  item_id: id,
  name: 'Item',
  icon: '',
  ilevel: 100,
  quality: 4,
  encounter: '',
  ...extra,
});
const drops = { Head: [item(1)], Finger: [item(2), item(2, { is_void_forge: true })] };
const { dropUid, effectiveUpgradeLevel } = require('../src/app/components/loot/dropUtils.ts');
const sync = (state, source = drops, filtered = source, datasetId = 'dataset') =>
  reduce(state, {
    type: 'reconcile',
    datasetId,
    availableBySlot: Object.fromEntries(
      Object.entries(filtered ?? {}).map(([slot, items]) => [slot, items.map(dropUid)])
    ),
  });
const ids = (state) => [...state.selected].sort();

test('new data selects visible items and keeps variants distinct', () => {
  assert.deepEqual(ids(sync(initial)), ['1', '2', '2:vf']);
  const filtered = { Head: drops.Head };
  assert.deepEqual(ids(sync(initial, drops, filtered)), ['1']);
});
test('pool or difficulty filtering removes items without restoring manual selections', () => {
  let state = reduce(sync(initial), { type: 'clear', uids: ['1'] });
  state = sync(state, drops, { Head: drops.Head, Finger: [drops.Finger[0]] });
  assert.deepEqual(ids(state), ['2']);
  state = sync(state, drops, drops);
  assert.deepEqual(ids(state), ['2']);
});
test('a saved filter is applied whole, not toggled', () => {
  // Restoring is not the same as switching: the saved sets replace whatever is
  // there, so re-mounting with a stored setup cannot flip an exclusion back on.
  let state = reduce(initial, {
    type: 'reconcile',
    datasetId: 'dataset',
    availableBySlot: { Head: ['1'], Finger: ['2'] },
    sourceByUid: { 1: 'boss:10', 2: 'boss:11' },
  });
  state = reduce(state, { type: 'restoreFilters', slots: ['Finger'], sources: ['boss:10'] });
  assert.deepEqual([...state.excludedSlots], ['Finger']);
  assert.deepEqual([...state.excludedSources], ['boss:10']);
  assert.deepEqual(ids(state), [], 'both rows leave the run');
  state = reduce(state, { type: 'restoreFilters', slots: [], sources: ['boss:10'] });
  assert.deepEqual(ids(state), ['2'], 'the un-hidden slot returns, the excluded boss stays out');
});

test('switching a boss off takes its drops out of the run, and back on restores them', () => {
  // Same shape as hiding a slot: the rows leave the run while they are switched
  // off, and come back when they are switched on again.
  const sourceByUid = { 1: 'boss:10', 2: 'boss:11', '2:vf': 'boss:11' };
  let state = reduce(initial, {
    type: 'reconcile',
    datasetId: 'dataset',
    availableBySlot: { Head: ['1'], Finger: ['2', '2:vf'] },
    sourceByUid,
  });
  state = reduce(state, { type: 'toggleSource', keys: ['boss:11'] });
  assert.deepEqual(ids(state), ['1']);
  assert.deepEqual([...visibleIds(state.availableBySlot, state.excludedSlots, state)], ['1']);
  state = reduce(state, { type: 'toggleSource', keys: ['boss:11'] });
  assert.deepEqual(ids(state), ['1', '2', '2:vf']);
});

test('an instance header switches every boss under it at once', () => {
  const sourceByUid = { 1: 'boss:10', 2: 'boss:11' };
  let state = reduce(initial, {
    type: 'reconcile',
    datasetId: 'dataset',
    availableBySlot: { Head: ['1', '2'] },
    sourceByUid,
  });
  state = reduce(state, { type: 'toggleSource', keys: ['boss:10', 'boss:11'] });
  assert.deepEqual(ids(state), []);
  state = reduce(state, { type: 'toggleSource', keys: ['boss:10', 'boss:11'] });
  assert.deepEqual(ids(state), ['1', '2']);
});

test('hiding and re-enabling a slot restores that slot while preserving other choices', () => {
  let state = reduce(sync(initial), { type: 'clear', uids: ['1', '2'] });
  state = reduce(state, { type: 'toggleSlot', slot: 'Finger' });
  assert.deepEqual(ids(state), []);
  assert.deepEqual([...visibleIds(state.availableBySlot, state.excludedSlots)], ['1']);
  state = reduce(state, { type: 'toggleSlot', slot: 'Finger' });
  assert.deepEqual(ids(state), ['2', '2:vf']);
});
test('refreshing data honors hidden slots and resetting slots restores their items', () => {
  let state = reduce(sync(initial), { type: 'toggleSlot', slot: 'Head' });
  state = sync(state, { ...drops }, drops, 'refreshed-dataset');
  assert.deepEqual(ids(state), ['2', '2:vf']);
  state = reduce(state, { type: 'resetSlots' });
  assert.deepEqual(ids(state), ['1', '2', '2:vf']);
  assert.equal(state.excludedSlots.size, 0);
  assert.deepEqual(ids(sync(state, null)), []);
});
test('selection actions cannot retain unavailable IDs and do not mutate previous state', () => {
  const state = sync(initial);
  const next = reduce(state, { type: 'toggle', uid: '1' });
  assert.deepEqual(ids(state), ['1', '2', '2:vf']);
  assert.deepEqual(ids(next), ['2', '2:vf']);
  assert.deepEqual(ids(reduce(next, { type: 'select', uids: ['1', 'missing'] })), [
    '1',
    '2',
    '2:vf',
  ]);
});
const options = {
  difficulty: 'heroic',
  dungeonDiff: 'mythic+10',
  upgradeLevel: 2,
  upgradeTracks: { Hero: [{ level: 2, max_level: 6, ilvl: 110, bonus_id: 9002, quality: 4 }] },
  preferredStats: [36, 49],
};
const flexible = item(271638, {
  accepts_preferred_stats: true,
  difficulty_info: { heroic: { ilvl: 100, bonus_id: 9001, quality: 4, track: 'Hero' } },
  extra_bonus_ids: [13575, 9002],
});
test('tooltip and payload agree on upgrades and variant bonuses', () => {
  const config = resolve(flexible, options);
  const payload = dropPayload(flexible, config);
  assert.equal(payload.ilevel, 110);
  assert.deepEqual(payload.bonus_ids, [9002, 13575]);
  const tooltip = new URLSearchParams(dropWowheadAttr(flexible, config));
  assert.equal(tooltip.get('bonus'), payload.bonus_ids.join(':'));
  assert.equal(tooltip.get('ilvl'), String(payload.ilevel));
  assert.equal(tooltip.get('crafted-stats'), '36:49');
  assert.equal('preferredStats' in payload, false);
});
test('fixed-stat items ignore preferences and unknown upgrades fall back to base', () => {
  const fixed = { ...flexible, accepts_preferred_stats: false };
  const config = resolve(fixed, { ...options, upgradeLevel: 99 });
  assert.equal(config.ilevel, 100);
  assert.equal(config.preferredStats, undefined);
  assert.equal(new URLSearchParams(dropWowheadAttr(fixed, config)).has('crafted-stats'), false);
});
test('tooltip retains catalyst source, inheritance and embellishments', () => {
  const catalyst = { ...flexible, is_catalyst: true, source_item_id: 123 };
  const tooltip = new URLSearchParams(
    dropWowheadAttr(catalyst, resolve(catalyst, options), { enchant_id: 42, gem_id: 43 }, [44])
  );
  assert.equal(tooltip.get('original-item'), '123');
  assert.equal(tooltip.get('ench'), '42');
  assert.equal(tooltip.get('gems'), '43');
  assert.equal(tooltip.get('bonus'), '9002:13575:44');
});
test('canonical spec data round-trips IDs and disambiguates shared names', () => {
  for (const [cls, specs] of Object.entries(CLASS_SPEC_DATA)) {
    assert.deepEqual(
      CLASS_SPECS[cls],
      specs.map((spec) => spec.name)
    );
    for (const spec of specs) {
      assert.equal(SPEC_ID_TO_NAME[spec.id], spec.name);
    }
  }
  // Ambiguous names must stay distinct per class, and Devourer must be present.
  assert.equal(SPEC_ID_TO_NAME[64], 'frost');
  assert.equal(SPEC_ID_TO_NAME[251], 'frost');
  assert.equal(SPEC_ID_TO_NAME[1480], 'devourer');
  assert.deepEqual(
    CLASS_SPEC_DATA['demon_hunter'].map((spec) => spec.id),
    [577, 581, 1480]
  );
});

const { buildLootItemRow: prepareRow } = require('../src/app/components/loot/lootItemRowModel.ts');
const buildLootItemRow = (item, slot, context) =>
  prepareRow(item, slot, { ...context, configuration: resolve(item, context.configuration) });
const rowContext = {
  configuration: options,
  equippedGear: { neck: { enchant_id: 42, gem_id: 43 } },
  spec: 'frost',
  locale: 'en_US',
  selected: new Set(),
};
test('row model prepares upgraded tooltip, inheritance, source and variant identity', () => {
  const drop = {
    ...flexible,
    inventory_type: 2,
    instance_name: 'Raid',
    encounter: 'Boss',
    is_void_forge: true,
  };
  const row = buildLootItemRow(drop, 'Neck', rowContext);
  assert.equal(row.uid, '271638:vf');
  assert.equal(row.slot, 'Neck');
  assert.equal(row.ilevel, 110);
  assert.equal(row.source, 'Raid • Boss');
  assert.equal(row.variants.is_void_forge, true);
  const tooltip = new URLSearchParams(row.tooltip);
  assert.equal(tooltip.get('crafted-stats'), '36:49');
  assert.equal(tooltip.get('ench'), '42');
  assert.equal(tooltip.get('gems'), '43');
  assert.equal(row.embellishment, undefined);
});
test('two rows for the same tier piece are told apart by origin', () => {
  // A tier head reachable both ways: the token hands over its own secondaries,
  // the conversion carries the fed item's. Same name, same id, different stats.
  const token = buildLootItemRow(
    { ...flexible, inventory_type: 1, from_tier_token: true },
    'Head',
    rowContext
  );
  assert.equal(token.variants.from_tier_token, true);
  assert.equal(token.catalystSource, undefined);

  const converted = buildLootItemRow(
    {
      ...flexible,
      inventory_type: 1,
      is_catalyst: true,
      source_item_id: 268229,
      source_name: 'Skullguard of the Risen Sacrifice',
    },
    'Head',
    rowContext
  );
  assert.equal(converted.catalystSource, 'Skullguard of the Risen Sacrifice');
  assert.equal(converted.variants.is_catalyst, true);
  assert.equal(converted.variants.from_tier_token, undefined);

  // A plain drop claims neither origin.
  const plain = buildLootItemRow({ ...flexible, inventory_type: 1 }, 'Head', rowContext);
  assert.equal(plain.catalystSource, undefined);
  assert.equal(plain.variants.from_tier_token, undefined);
});
test('a catalyst row without a resolved source name shows no origin line', () => {
  const row = buildLootItemRow(
    { ...flexible, inventory_type: 1, is_catalyst: true, source_item_id: 268229 },
    'Head',
    rowContext
  );
  assert.equal(row.catalystSource, undefined);
});
test('alternative embellished candidates are selectable independently', () => {
  const row = buildLootItemRow(
    item(3, { embellished: true, off_spec: true }),
    'Finger',
    rowContext
  );
  assert.equal(row.embellished, true);
  assert.equal(row.offSpec, true);
  assert.equal('disabled' in row, false);
});
test('row model filters embellishments and carries the selected bonus into its tooltip', () => {
  const matching = { id: 7, name: 'Effect', bonus_ids: [44], item_ids: [271638] };
  const context = {
    ...rowContext,
    embellishmentOptions: [matching, { id: 8, name: 'Other', bonus_ids: [45], item_ids: [99] }],
    embellishmentPicks: { 271638: 7 },
  };
  const row = buildLootItemRow(flexible, 'Neck', context);
  assert.deepEqual(row.embellishment, { value: 7, options: [matching] });
  assert.equal(new URLSearchParams(row.tooltip).get('bonus'), '9002:13575:44');
  const other = buildLootItemRow(item(5), 'Head', context);
  assert.equal(other.embellishment, undefined);
  assert.equal(new URLSearchParams(other.tooltip).has('crafted-stats'), false);
});

test('embellishment cap counts equipped pieces plus drops picked in this run', () => {
  // The case the equipped-only count missed: wear 1, select 2.
  assert.equal(embellishmentCapReached(1, 2), true);
  assert.equal(embellishmentCapReached(0, 2), true);
  assert.equal(embellishmentCapReached(2, 0), true);
  assert.equal(embellishmentCapReached(1, 0), false);
  assert.equal(embellishmentCapReached(0, 1), false);
  assert.equal(embellishmentCapReached(0, 0), false);
});

test('preferred-stats categories cover every pool holding flexible-stat gear', () => {
  // Raids plus all three profession pools; a raid+crafted whitelist missed the
  // Rare (-89) and PVP (-90) profession pools entirely.
  for (const category of ['raids', 'crafted', 'rare-profession', 'pvp-profession'])
    assert.equal(categoryMayUsePreferredStats(category), true, category);
  for (const category of ['mplus', 'normal-dungeons', 'delves', 'prey', 'catalyst', 'pvp-honor'])
    assert.equal(categoryMayUsePreferredStats(category), false, category);
});

test('variant tooltips: catalyst rows carry original-item, Void Forge rows do not', () => {
  const catalyst = item(250042, {
    ...flexible,
    item_id: 250042,
    is_catalyst: true,
    source_item_id: 271638,
  });
  const catalystTip = new URLSearchParams(dropWowheadAttr(catalyst, resolve(catalyst, options)));
  assert.equal(catalystTip.get('original-item'), '271638');

  // Void Forge catalog rows reuse source_item_id for their own id.
  const voidForged = item(271638, {
    ...flexible,
    is_void_forge: true,
    source_item_id: 271638,
  });
  const vfTip = new URLSearchParams(dropWowheadAttr(voidForged, resolve(voidForged, options)));
  assert.equal(vfTip.get('original-item'), null);
});

// ---- Bonus Rolls ----
const {
  BONUS_ROLL_CATEGORY,
  categoryDetails,
  effectiveDifficultyKeys,
  selectBonusRollTier,
  selectLootCategory,
  selectLootDifficulty,
} = require('../src/app/components/loot/lootConfiguration.ts');
const { mergeDrops } = require('../src/app/components/loot/useDropFinderData.ts');

const tier = (key, track, level, extra = {}) => ({
  key,
  label: key,
  track,
  level,
  sortOrder: 0,
  ...extra,
});
const bonusCatalog = {
  instances: [
    { id: -1, name: 'Pool', type: 'meta', encounters: [{ id: 10, name: 'Dungeon' }] },
    { id: 10, name: 'Dungeon', type: 'dungeon', encounters: [] },
    { id: 20, name: 'Raid', type: 'raid', encounters: [] },
  ],
  seasonConfig: {
    raid_instance_ids: [20],
    raid_difficulties: [tier('heroic', 'Hero', 1)],
    raid_vault_difficulties: [
      tier('vault-lfr', 'Champion', 1, { baseDifficulty: 'lfr' }),
      tier('vault-heroic', 'Myth', 1, { baseDifficulty: 'heroic' }),
      tier('vault-mythic', 'Myth', 6, { baseDifficulty: 'mythic' }),
    ],
    bonus_roll: {
      dungeonCategory: 'mplus',
      dungeonDifficulties: ['vault+0', 'vault+10-13'],
    },
    dungeon_categories: [
      {
        key: 'mplus',
        label: 'Dungeons',
        poolInstanceId: -1,
        defaultDifficulty: 'mythic+10',
        difficulties: [
          tier('mythic+10', 'Hero', 3),
          tier('vault+0', 'Champion', 4),
          tier('vault+10-13', 'Myth', 1),
        ],
      },
    ],
  },
  upgradeTracks: {},
};

// ---- Saved setup ----
const {
  parseDropFinderPrefs,
  restoreConfiguration,
} = require('../src/app/components/loot/dropFinderPrefs.ts');

const savedPrefs = (extra = {}) => ({
  v: 1,
  category: BONUS_ROLL_CATEGORY,
  difficulty: 'vault-heroic',
  dungeonDifficulty: 'vault+0',
  upgradeLevel: 0,
  pool: [],
  includeVoidForge: false,
  includeCatalyst: true,
  upgradeEquipped: true,
  addVaultSocket: false,
  forceSinglePass: true,
  preferredGemId: 240908,
  preferredStats: [49, 36],
  excludedSlots: ['Head'],
  excludedSources: ['boss:10'],
  ...extra,
});

test('a stored setup is only trusted when it is shaped like one', () => {
  // localStorage is an unchecked boundary: anything that is not this build's
  // shape is ignored rather than half-applied.
  assert.equal(parseDropFinderPrefs(null), null);
  assert.equal(parseDropFinderPrefs('bonus-rolls'), null);
  assert.equal(parseDropFinderPrefs({ category: 'raids' }), null, 'no version');
  assert.equal(
    parseDropFinderPrefs(savedPrefs({ v: 99 })),
    null,
    'a version this build cannot read'
  );
  assert.equal(parseDropFinderPrefs(savedPrefs({ category: 7 })), null, 'category must be a name');
  const parsed = parseDropFinderPrefs(savedPrefs({ excludedSlots: 'Head' }));
  assert.deepEqual(parsed.excludedSlots, [], 'a malformed field falls back, the rest survives');
  assert.equal(parsed.includeCatalyst, true);
  assert.deepEqual(parsed.excludedSources, ['boss:10']);
});

test('a saved category that no longer exists gives way to the default', () => {
  assert.equal(restoreConfiguration(bonusCatalog, savedPrefs({ category: 'delves' })), null);
  assert.notEqual(restoreConfiguration(bonusCatalog, savedPrefs()), null);
});

test('a saved difficulty that no longer exists gives way to the category default', () => {
  const state = restoreConfiguration(bonusCatalog, savedPrefs({ difficulty: 'vault-gone' }));
  assert.equal(state.category, BONUS_ROLL_CATEGORY);
  assert.equal(state.difficulty, 'vault-heroic', 'the category default stands in');
  assert.equal(state.dungeonDifficulty, 'vault+0', 'the tier that still exists is kept');
});

test('a saved raid pool keeps only the instances still in the catalog', () => {
  const state = restoreConfiguration(
    bonusCatalog,
    savedPrefs({ category: 'raids', difficulty: 'heroic', pool: ['20', '999'] })
  );
  assert.deepEqual([...state.pool], ['20']);
});

test('bonus rolls draw on the season raid endpoint plus the M+ pool', () => {
  const details = categoryDetails(bonusCatalog, BONUS_ROLL_CATEGORY);
  assert.equal(details.isBonusRoll, true);
  // The raid endpoint is already season-scoped; the meta raid pool serves nothing.
  assert.deepEqual(details.sources, ['type:raid', '-1']);
  assert.deepEqual(
    details.raidTiers.map((t) => t.key),
    ['vault-lfr', 'vault-heroic', 'vault-mythic']
  );
  // Config order, and only the keys the season nominates as bonus-roll tiers.
  assert.deepEqual(
    details.dungeonTiers.map((t) => t.key),
    ['vault+0', 'vault+10-13']
  );
  // No shared difficulty row, and so no upgrade-level control.
  assert.deepEqual(details.difficulties, []);
});

test('bonus rolls default to Heroic and the top M+ tier, with no upgrade level', () => {
  const state = selectLootCategory(bonusCatalog, BONUS_ROLL_CATEGORY);
  assert.equal(state.difficulty, 'vault-heroic');
  assert.equal(state.dungeonDifficulty, 'vault+10-13');
  assert.equal(state.upgradeLevel, 0);
});

test('picking either bonus-roll tier leaves the other alone and never raises upgrade level', () => {
  let state = selectLootCategory(bonusCatalog, BONUS_ROLL_CATEGORY);
  state = selectBonusRollTier(state, 'dungeon', 'vault+0');
  assert.equal(state.difficulty, 'vault-heroic');
  assert.equal(state.dungeonDifficulty, 'vault+0');
  assert.equal(state.upgradeLevel, 0);
  // An empty key is "no roll on this side".
  state = selectBonusRollTier(state, 'raid', '');
  assert.equal(state.difficulty, '');
  assert.equal(state.dungeonDifficulty, 'vault+0');
  assert.equal(state.upgradeLevel, 0);
  // The shared difficulty setter must not reintroduce one either.
  state = selectLootDifficulty(state, tier('vault+10-13', 'Myth', 1));
  assert.equal(state.upgradeLevel, 0, 'bonus-roll rewards arrive at a fixed rank');
});

test('only bonus rolls resolve two ladders at once', () => {
  const state = {
    category: BONUS_ROLL_CATEGORY,
    difficulty: 'vault-heroic',
    dungeonDifficulty: 'vault+0',
    upgradeLevel: 0,
    pool: new Set(),
  };
  assert.deepEqual(effectiveDifficultyKeys(state, { isRaid: false, isBonusRoll: true }), {
    raidDiff: 'vault-heroic',
    dungeonDiff: 'vault+0',
  });
  // Raids blank the dungeon key so `dungeon_info` cannot shadow `difficulty_info`.
  const raid = { ...state, category: 'raids', difficulty: 'mythic' };
  assert.deepEqual(effectiveDifficultyKeys(raid, { isRaid: true, isBonusRoll: false }), {
    raidDiff: 'mythic',
    dungeonDiff: '',
  });
  const dungeon = { ...state, category: 'mplus', difficulty: 'mythic+10' };
  assert.deepEqual(effectiveDifficultyKeys(dungeon, { isRaid: false, isBonusRoll: false }), {
    raidDiff: 'mythic+10',
    dungeonDiff: 'mythic+10',
  });
});

test('an item served by two pools keeps both ladders', () => {
  // Bonus Rolls prices a drop off whichever ladder the roll is spent on, so an
  // item in both pools must not lose the second pool's tiers to the dedupe.
  const fromRaid = item(9, { difficulty_info: { heroic: { ilvl: 321 } } });
  const fromDungeon = item(9, { dungeon_info: { 'vault+10-13': { ilvl: 324 } } });
  const merged = mergeDrops([{ Head: [fromRaid] }, { Head: [fromDungeon] }]);
  assert.equal(merged.Head.length, 1, 'still one row');
  assert.deepEqual(merged.Head[0].difficulty_info, { heroic: { ilvl: 321 } });
  assert.deepEqual(merged.Head[0].dungeon_info, { 'vault+10-13': { ilvl: 324 } });
});

test('an ownership update keeps unticks and picks up rows that became eligible', () => {
  // Ownership lands after the drops, and changes again with difficulty. Neither
  // may undo what the user ticked off, and gear that stops being owned is a
  // fresh candidate that belongs in the run.
  const avail = { Head: ['1'], Finger: ['2', '2:vf'] };
  const reconcile = (state, ownedUids) =>
    reduce(state, { type: 'reconcile', datasetId: 'dataset', availableBySlot: avail, ownedUids });

  let state = reconcile(initial, []);
  state = reduce(state, { type: 'toggle', uid: '2' });
  state = reconcile(state, ['1']);
  assert.deepEqual(ids(state), ['2:vf'], 'owned row out, unticked row stays out');

  state = reconcile(state, []);
  assert.deepEqual(
    ids(state),
    ['1', '2:vf'],
    'the newly eligible row comes back, the untick holds'
  );
});

test('a candidate is simmed at its drop rank until a rank is picked', () => {
  // "Upgrade equipped gear" has to raise the baseline to the rank the candidates
  // are actually tested at. With the control on Base that is the rank the drop
  // comes at, not zero.
  const tracks = {
    Hero: [
      { level: 4, ilvl: 315 },
      { level: 6, ilvl: 321 },
    ],
  };
  const heroic = item(1, { difficulty_info: { heroic: { track: 'Hero', level: 4, ilvl: 315 } } });
  assert.equal(effectiveUpgradeLevel(heroic, 'heroic', '', 0, tracks), 4);
  assert.equal(effectiveUpgradeLevel(heroic, 'heroic', '', 6, tracks), 6);
  // A rank the track does not have falls back to the drop's own rank.
  assert.equal(effectiveUpgradeLevel(heroic, 'heroic', '', 9, tracks), 4);
  // Crafted and Very Rare gear sits off the tracks, so no rank applies.
  const offTrack = item(2, { difficulty_info: { heroic: { ilvl: 344 } } });
  assert.equal(effectiveUpgradeLevel(offTrack, 'heroic', '', 6, tracks), 0);
});

// ---- Source (boss / instance) filter ----
const {
  bossKey,
  poolSources,
  isSourceExcluded,
} = require('../src/app/components/loot/lootSources.ts');

const fromBoss = (itemId, encounterId, encounter, instanceId, instanceName) =>
  item(itemId, {
    encounter_id: encounterId,
    encounter,
    instance_id: instanceId,
    instance_name: instanceName,
  });

test('a pool lists each instance once, with the bosses that drop into it', () => {
  const sources = poolSources([
    fromBoss(1, 10, "Ula'tek", 100, 'The Venomous Abyss'),
    fromBoss(2, 20, 'Nymrissa Wavecaller', 200, 'The Tidebound Grotto'),
    fromBoss(3, 10, "Ula'tek", 100, 'The Venomous Abyss'),
    fromBoss(4, 11, 'Sszorak', 100, 'The Venomous Abyss'),
  ]);
  assert.deepEqual(
    sources.map((source) => [source.name, source.bosses.map((boss) => boss.name)]),
    [
      ['The Venomous Abyss', ["Ula'tek", 'Sszorak']],
      ['The Tidebound Grotto', ['Nymrissa Wavecaller']],
    ]
  );
});

test('two bosses sharing a name in different instances stay separate entries', () => {
  const sources = poolSources([
    fromBoss(1, 10, 'The Menagerie', 100, 'Raid'),
    fromBoss(2, 20, 'The Menagerie', 200, 'Dungeon'),
  ]);
  assert.equal(sources.length, 2);
  assert.notEqual(sources[0].bosses[0].key, sources[1].bosses[0].key);
});

test('excluding a boss takes only that boss out', () => {
  const kept = fromBoss(1, 10, "Ula'tek", 100, 'The Venomous Abyss');
  const dropped = fromBoss(2, 11, 'Sszorak', 100, 'The Venomous Abyss');
  const excluded = new Set([bossKey(dropped)]);
  assert.equal(isSourceExcluded(dropped, excluded), true);
  assert.equal(isSourceExcluded(kept, excluded), false);
  assert.equal(isSourceExcluded(dropped, new Set()), false);
});

test('merging pools keeps every slot and drops only genuine duplicates', () => {
  const raidItem = item(1, { instance_id: 20 });
  const dungeonItem = item(2, { instance_id: 10 });
  const merged = mergeDrops([
    { Head: [raidItem], Finger: [item(3)] },
    { Head: [dungeonItem], Finger: [item(3)] },
  ]);
  assert.deepEqual(Object.keys(merged).sort(), ['Finger', 'Head']);
  assert.deepEqual(merged.Head.map(dropUid), ['1', '2']);
  assert.deepEqual(merged.Finger.map(dropUid), ['3'], 'one item served by two pools appears once');
  // Same item id in different slots is not a duplicate.
  const across = mergeDrops([{ Head: [item(4)] }, { Finger: [item(4)] }]);
  assert.deepEqual(Object.keys(across).sort(), ['Finger', 'Head']);
});

const { rankTrackName } = require('../src/app/components/loot/lootConfiguration.ts');

test('the upgrade rank is labelled by the higher of the two selected ladders', () => {
  const details = categoryDetails(bonusCatalog, BONUS_ROLL_CATEGORY);
  let state = selectLootCategory(bonusCatalog, BONUS_ROLL_CATEGORY);
  // Defaults: raid Heroic (Myth) + top M+ tier (Myth).
  assert.equal(rankTrackName(state, details), 'Myth');
  // Both on Champion.
  state = selectBonusRollTier(state, 'raid', 'vault-lfr');
  state = selectBonusRollTier(state, 'dungeon', 'vault+0');
  assert.equal(rankTrackName(state, details), 'Champion');
  // Mixed ladders take the higher one, since that is where the reward tops out.
  state = selectBonusRollTier(state, 'dungeon', 'vault+10-13');
  assert.equal(rankTrackName(state, details), 'Myth');
  // One side off still labels from the side that is on.
  state = selectBonusRollTier(state, 'dungeon', '');
  assert.equal(rankTrackName(state, details), 'Champion');
  // Nothing selected, nothing to label.
  state = selectBonusRollTier(state, 'raid', '');
  assert.equal(rankTrackName(state, details), null);
});

test('changing a bonus-roll tier keeps the rank, since a rank is per own track', () => {
  let state = selectLootCategory(bonusCatalog, BONUS_ROLL_CATEGORY);
  state = { ...state, upgradeLevel: 6 };
  state = selectBonusRollTier(state, 'raid', 'vault-lfr');
  assert.equal(state.upgradeLevel, 6);
  state = selectBonusRollTier(state, 'dungeon', '');
  assert.equal(state.upgradeLevel, 6);
});

// ---- Already-owned drops ----
const {
  collectOwned,
  isAlreadyOwned,
  ownedKey,
} = require('../src/app/components/loot/ownedDrops.ts');

const equipped = (slot, item) => ({ [slot]: { equipped: item, alternatives: [] } });
const worn = (itemId, upgrade, ilevel, sourceItemId) => ({
  item_id: itemId,
  ilevel,
  upgrade,
  ...(sourceItemId ? { source_item_id: sourceItemId } : {}),
});

test('a drop on the track you already own adds nothing, a higher track does', () => {
  const owned = collectOwned({ slots: equipped('head', worn(100, 'Myth 1/6', 318)) });
  // Crests get you from Myth 1/6 to Myth 6/6, so the roll is not an acquisition.
  assert.equal(isAlreadyOwned({ item_id: 100 }, 'Myth', 334, owned), true);
  assert.equal(isAlreadyOwned({ item_id: 100 }, 'Myth', 318, owned), true);
  // A lower track is worse than what is worn.
  assert.equal(isAlreadyOwned({ item_id: 100 }, 'Hero', 321, owned), true);
  // Nothing owned, nothing to compare against.
  assert.equal(isAlreadyOwned({ item_id: 999 }, 'Myth', 334, owned), false);
});

test('a higher track is a real acquisition even at a lower rank', () => {
  const owned = collectOwned({ slots: equipped('head', worn(100, 'Hero 6/6', 321)) });
  // Myth 1/6 is 318 — three item levels BELOW the Hero 6/6 worn — but crests
  // cannot take a Hero piece onto the Myth track, so the drop still counts.
  assert.equal(isAlreadyOwned({ item_id: 100 }, 'Myth', 318, owned), false);
});

test('tier pieces only match when their secondaries came from the same item', () => {
  const owned = collectOwned({ slots: equipped('head', worn(100, 'Myth 1/6', 318, 555)) });
  // Same tier piece, converted from the same drop: identical secondaries.
  assert.equal(isAlreadyOwned({ item_id: 100, source_item_id: 555 }, 'Myth', 334, owned), true);
  // Converted from something else, so it carries different secondaries.
  assert.equal(isAlreadyOwned({ item_id: 100, source_item_id: 777 }, 'Myth', 334, owned), false);
  // The directly-dropped version is its own item too.
  assert.equal(isAlreadyOwned({ item_id: 100 }, 'Myth', 334, owned), false);
  assert.notEqual(ownedKey(100, 555), ownedKey(100, 777));
  assert.equal(ownedKey(100, 0), ownedKey(100, undefined));
});

test('off-track gear falls back to item level', () => {
  // Crafted and Very Rare drops carry no upgrade track, so rank cannot decide.
  const owned = collectOwned({ slots: equipped('trinket1', worn(100, '', 344)) });
  assert.equal(isAlreadyOwned({ item_id: 100 }, null, 344, owned), true);
  assert.equal(isAlreadyOwned({ item_id: 100 }, null, 334, owned), true);
  assert.equal(isAlreadyOwned({ item_id: 100 }, null, 350, owned), false);
});

test('the better copy is the higher track, not the higher item level', () => {
  // Hero 6/6 is 321 and Myth 1/6 is 318, so item level picks the wrong one:
  // crests can take the Myth copy all the way up, which is what a Myth drop
  // has to beat.
  const owned = collectOwned({
    slots: {
      ...equipped('finger1', worn(100, 'Hero 6/6', 321)),
      ...equipped('finger2', worn(100, 'Myth 1/6', 318)),
    },
  });
  assert.equal(isAlreadyOwned({ item_id: 100 }, 'Myth', 334, owned), true);
});

test('a ring worn in both fingers is compared at its better copy', () => {
  const owned = collectOwned({
    slots: {
      ...equipped('finger1', worn(100, 'Hero 6/6', 321)),
      ...equipped('finger2', worn(100, 'Champion 1/6', 292)),
    },
  });
  // The Hero copy is what a drop has to beat, not the Champion one.
  assert.equal(isAlreadyOwned({ item_id: 100 }, 'Hero', 321, owned), true);
  assert.equal(isAlreadyOwned({ item_id: 100 }, 'Myth', 318, owned), false);
});

test('no resolved gear means nothing is excluded', () => {
  assert.equal(collectOwned(null).size, 0);
  assert.equal(isAlreadyOwned({ item_id: 100 }, 'Myth', 334, collectOwned(null)), false);
});

test('owned items stay listed but can never be selected, by any route', () => {
  const state = reduce(initial, {
    type: 'reconcile',
    datasetId: 'dataset',
    availableBySlot: { Head: ['1'], Finger: ['2', '3'] },
    ownedUids: ['2'],
  });
  // Still visible — the table shows it, greyed, with its badge.
  assert.deepEqual([...visibleIds(state.availableBySlot, state.excludedSlots)].sort(), [
    '1',
    '2',
    '3',
  ]);
  assert.deepEqual(ids(state), ['1', '3']);
  // Every route into the selection has to refuse it, not just the default.
  assert.deepEqual(ids(reduce(state, { type: 'toggle', uid: '2' })), ['1', '3'], 'toggle');
  assert.deepEqual(ids(reduce(state, { type: 'select', uids: ['2'] })), ['1', '3'], 'select one');
  assert.deepEqual(
    ids(reduce(state, { type: 'select', uids: ['1', '2', '3'] })),
    ['1', '3'],
    'select all'
  );
  // Hiding and restoring the slot must not let it back in either.
  let hidden = reduce(state, { type: 'toggleSlot', slot: 'Finger' });
  assert.deepEqual(ids(reduce(hidden, { type: 'toggleSlot', slot: 'Finger' })), ['1', '3']);
});
