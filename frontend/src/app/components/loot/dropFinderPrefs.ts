import { readStoredJson } from '../../lib/storage';
import {
  categoryDetails,
  selectLootCategory,
  type LootCatalog,
  type LootConfiguration,
} from './lootConfiguration';

export const DROP_FINDER_PREFS_KEY = 'simhammer_drop_finder';

/** Version of the shape below. A blob written by a newer build is left alone
 *  rather than half-read, the same stance the sim profile takes. */
const PREFS_VERSION = 1;

/** The Drop Finder setup that outlives a visit: how the pool is chosen and how
 *  candidates are built, but never which individual items are ticked — a stale
 *  untick silently dropping an item from a run is too quiet to debug. */
export interface DropFinderPrefs {
  category: string;
  difficulty: string;
  dungeonDifficulty: string;
  upgradeLevel: number;
  pool: string[];
  includeVoidForge: boolean;
  includeCatalyst: boolean;
  upgradeEquipped: boolean;
  addVaultSocket: boolean;
  forceSinglePass: boolean;
  preferredGemId: number | null;
  preferredStats: [number, number] | null;
  excludedSlots: string[];
  excludedSources: string[];
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStatPair(value: unknown): [number, number] | null {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number')
    ? [value[0] as number, value[1] as number]
    : null;
}

/** Read a stored setup, or null when there is nothing this build can trust.
 *  A field that is malformed falls back on its own rather than discarding the
 *  whole setup — the category and the version are the only hard requirements. */
export function parseDropFinderPrefs(raw: unknown): DropFinderPrefs | null {
  if (!raw || typeof raw !== 'object') return null;
  const stored = raw as Record<string, unknown>;
  if (stored.v !== PREFS_VERSION) return null;
  if (typeof stored.category !== 'string' || !stored.category) return null;
  return {
    category: stored.category,
    difficulty: typeof stored.difficulty === 'string' ? stored.difficulty : '',
    dungeonDifficulty: typeof stored.dungeonDifficulty === 'string' ? stored.dungeonDifficulty : '',
    upgradeLevel: typeof stored.upgradeLevel === 'number' ? stored.upgradeLevel : 0,
    pool: asStringList(stored.pool),
    includeVoidForge: asBool(stored.includeVoidForge, false),
    includeCatalyst: asBool(stored.includeCatalyst, false),
    upgradeEquipped: asBool(stored.upgradeEquipped, false),
    addVaultSocket: asBool(stored.addVaultSocket, false),
    forceSinglePass: asBool(stored.forceSinglePass, true),
    preferredGemId: typeof stored.preferredGemId === 'number' ? stored.preferredGemId : null,
    preferredStats: asStatPair(stored.preferredStats),
    excludedSlots: asStringList(stored.excludedSlots),
    excludedSources: asStringList(stored.excludedSources),
  };
}

/** Whether the catalog still offers this category — a season can retire one, and
 *  restoring it would leave the browser showing nothing with no way back. */
function categoryStillExists(catalog: LootCatalog, category: string): boolean {
  if (category === 'raids') return true;
  const details = categoryDetails(catalog, category);
  if (details.isBonusRoll) return details.raidTiers.length > 0;
  return details.dungeonCats.some((group) => group.cat.key === category);
}

/** The saved selection as a configuration this catalog can serve: anything the
 *  season no longer has (a retired category, a renamed difficulty, an instance
 *  that left the pool) gives way to the category's own default. Null when the
 *  category itself is gone, so the caller keeps its default. */
export function restoreConfiguration(
  catalog: LootCatalog,
  prefs: DropFinderPrefs
): LootConfiguration | null {
  if (!categoryStillExists(catalog, prefs.category)) return null;
  const base = selectLootCategory(catalog, prefs.category);
  const details = categoryDetails(catalog, prefs.category);
  const raidKeys = details.isBonusRoll ? details.raidTiers : details.difficulties;
  const difficulty = raidKeys.some((entry) => entry.key === prefs.difficulty)
    ? prefs.difficulty
    : base.difficulty;
  // "No roll on this side" is a real choice in Bonus Rolls, so an empty key is
  // kept rather than corrected back to the default tier.
  const dungeonDifficulty =
    details.isBonusRoll &&
    (prefs.dungeonDifficulty === '' ||
      details.dungeonTiers.some((tier) => tier.key === prefs.dungeonDifficulty))
      ? prefs.dungeonDifficulty
      : base.dungeonDifficulty;
  const pool = prefs.pool.filter((id) => base.pool.has(id));
  return {
    category: prefs.category,
    difficulty,
    dungeonDifficulty,
    upgradeLevel: prefs.upgradeLevel,
    pool: pool.length ? new Set(pool) : base.pool,
  };
}

export function readDropFinderPrefs(): DropFinderPrefs | null {
  return parseDropFinderPrefs(readStoredJson<unknown>(DROP_FINDER_PREFS_KEY, null));
}

export function writeDropFinderPrefs(prefs: DropFinderPrefs): void {
  // Storage can refuse (private mode, a full quota); losing the setup is not
  // worth breaking the page over.
  try {
    localStorage.setItem(DROP_FINDER_PREFS_KEY, JSON.stringify({ v: PREFS_VERSION, ...prefs }));
  } catch {
    /* setup will not persist this session */
  }
}
