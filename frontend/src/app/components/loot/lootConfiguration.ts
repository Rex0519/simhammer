import type { DifficultyDef, SeasonConfigResponse } from '../../lib/types';
import { groupInstances } from '../../lib/instanceCategories';
import type { Instance, UpgradeTracks } from './types';
import { detectClass, detectSpec, trackRank } from './dropUtils';
import { parseEquippedGear } from '../../lib/inheritedGear';
import { CLASS_SPECS } from '../../lib/classSpecs';

export interface LootCatalog {
  instances: Instance[];
  seasonConfig: SeasonConfigResponse;
  upgradeTracks: UpgradeTracks;
}
export function parseLootCharacter(input: string) {
  const className = detectClass(input);
  const specName = detectSpec(input);
  return {
    className,
    specName,
    identity: [className, specName].join(':'),
    specs: CLASS_SPECS[className ?? ''] ?? [],
    equippedGear: parseEquippedGear(input),
  };
}
/** Categories whose pools contain gear with placeholder secondaries: raids, and
 *  every profession pool (Epic `crafted`, plus `rare-profession` /
 *  `pvp-profession`). Used where per-item eligibility isn't available. */
export function categoryMayUsePreferredStats(category: string): boolean {
  return category === 'raids' || category === 'crafted' || category.endsWith('-profession');
}

/** Bonus Rolls draws on two pools at once, so it is its own category rather than
 *  a difficulty of either. */
export const BONUS_ROLL_CATEGORY = 'bonus-roll';

/** The Mythic+ bonus-roll tiers, in the order the season config lists them. */
function bonusRollDungeonTiers(catalog: LootCatalog): DifficultyDef[] {
  const config = catalog.seasonConfig.bonus_roll;
  if (!config) return [];
  const category = catalog.seasonConfig.dungeon_categories.find(
    (cat) => cat.key === config.dungeonCategory
  );
  const all =
    category?.difficultyGroups?.flatMap((group) => group.difficulties) ??
    category?.difficulties ??
    [];
  return config.dungeonDifficulties
    .map((key) => all.find((difficulty) => difficulty.key === key))
    .filter((difficulty): difficulty is DifficultyDef => difficulty !== undefined);
}

export function categoryDetails(catalog: LootCatalog, category: string) {
  const { raids, dungeonCats } = groupInstances(catalog.instances, catalog.seasonConfig);
  const dungeon = dungeonCats.find((group) => group.cat.key === category);
  const isRaid = category === 'raids';
  const isCrafted = category === 'crafted';
  const isBonusRoll = category === BONUS_ROLL_CATEGORY;
  // Bonus Rolls drives its own two ladders, so it exposes no `difficulties`:
  // that keeps the shared difficulty row and the upgrade-level control — which
  // cannot mean one thing across two tracks — out of the card entirely.
  const difficulties = isBonusRoll
    ? []
    : isRaid
      ? catalog.seasonConfig.raid_difficulties
      : (dungeon?.cat.difficultyGroups?.flatMap((group) => group.difficulties) ??
        dungeon?.cat.difficulties ??
        []);
  const instances = isRaid ? raids : (dungeon?.instances ?? []);
  const raidTiers = isBonusRoll ? (catalog.seasonConfig.raid_vault_difficulties ?? []) : [];
  const dungeonTiers = isBonusRoll ? bonusRollDungeonTiers(catalog) : [];
  const dungeonPool = catalog.seasonConfig.dungeon_categories.find(
    (cat) => cat.key === catalog.seasonConfig.bonus_roll?.dungeonCategory
  );
  const source = isRaid ? 'type:raid' : dungeon ? String(dungeon.cat.poolInstanceId) : '';
  return {
    raids,
    dungeonCats,
    isRaid,
    isCrafted,
    isBonusRoll,
    instances,
    difficulties,
    difficultyGroups: dungeon?.cat.difficultyGroups ?? null,
    raidTiers,
    dungeonTiers,
    source,
    // The raid endpoint is already season-scoped, so it needs no extra filtering;
    // the meta raid pool carries no drops of its own and would serve nothing.
    sources: isBonusRoll
      ? ['type:raid', String(dungeonPool?.poolInstanceId ?? '')].filter((s) => s !== '')
      : source
        ? [source]
        : [],
    defaultDifficulty: isBonusRoll
      ? (raidTiers.find((tier) => tier.baseDifficulty === 'heroic')?.key ?? raidTiers[0]?.key ?? '')
      : isRaid
        ? (difficulties.find((d) => d.key === 'heroic')?.key ?? difficulties[0]?.key ?? '')
        : (dungeon?.cat.defaultDifficulty ?? ''),
    defaultDungeonDifficulty: isBonusRoll ? (dungeonTiers.at(-1)?.key ?? '') : '',
    poolOnly: !isRaid && instances.length === 0,
  };
}
export interface LootConfiguration {
  category: string;
  difficulty: string;
  /** Bonus Rolls only: the Mythic+ tier, chosen independently of the raid one.
   *  Empty for every other category, which resolves both sides from `difficulty`. */
  dungeonDifficulty: string;
  upgradeLevel: number;
  pool: Set<string>;
}
/** The keys each half of the pool resolves against. Raid items index
 *  `difficulty_info`, dungeon items `dungeon_info`; only Bonus Rolls sets both. */
export function effectiveDifficultyKeys(
  state: LootConfiguration,
  details: { isRaid: boolean; isBonusRoll: boolean }
): { raidDiff: string; dungeonDiff: string } {
  if (details.isBonusRoll)
    return { raidDiff: state.difficulty, dungeonDiff: state.dungeonDifficulty };
  // Passing the raid key as the dungeon key too lets `dungeon_info` shadow
  // `difficulty_info` whenever the two share a name — a raid Mythic selection
  // would then resolve on the Mythic-dungeon (M0) track.
  return { raidDiff: state.difficulty, dungeonDiff: details.isRaid ? '' : state.difficulty };
}
/** Bonus-roll rewards arrive at a fixed rank, and one upgrade level cannot mean
 *  the same thing across two different tracks. */
function baseUpgradeLevel(category: string, level: number | undefined): number {
  return category === 'raids' || category === BONUS_ROLL_CATEGORY ? 0 : (level ?? 0);
}
export function selectLootCategory(catalog: LootCatalog, category: string): LootConfiguration {
  const details = categoryDetails(catalog, category);
  return {
    category,
    difficulty: details.defaultDifficulty,
    dungeonDifficulty: details.defaultDungeonDifficulty,
    upgradeLevel: baseUpgradeLevel(
      category,
      details.difficulties.find((d) => d.key === details.defaultDifficulty)?.level
    ),
    pool: new Set(details.instances.map((instance) => String(instance.id))),
  };
}
export function selectLootDifficulty(
  state: LootConfiguration,
  difficulty: DifficultyDef
): LootConfiguration {
  return {
    ...state,
    difficulty: difficulty.key,
    upgradeLevel: baseUpgradeLevel(state.category, difficulty.level),
  };
}
/** Pick one side of the Bonus Rolls pair. An empty key means "no roll on this
 *  side", which drops that half of the pool. The chosen rank carries over: it
 *  means "level N of each item's own track", so it survives a tier change. */
export function selectBonusRollTier(
  state: LootConfiguration,
  side: 'raid' | 'dungeon',
  key: string
): LootConfiguration {
  return {
    ...state,
    ...(side === 'raid' ? { difficulty: key } : { dungeonDifficulty: key }),
  };
}

/** The track whose item levels label the upgrade-rank control. An upgrade rank
 *  means "level N of whatever track this item is on", so with two tiers selected
 *  only the label has to pick a side: the higher of the two, since that is where
 *  the reward tops out. Ordering comes from `trackRank`, the one list. */
export function rankTrackName(
  state: LootConfiguration,
  details: ReturnType<typeof categoryDetails>
): string | null {
  if (!details.isBonusRoll)
    return details.difficulties.find((d) => d.key === state.difficulty)?.track ?? null;
  const selected = [
    details.raidTiers.find((tier) => tier.key === state.difficulty)?.track,
    details.dungeonTiers.find((tier) => tier.key === state.dungeonDifficulty)?.track,
  ].filter((track): track is string => !!track);
  if (!selected.length) return null;
  return selected.reduce((a, b) => (trackRank(b) > trackRank(a) ? b : a));
}
