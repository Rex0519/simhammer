import type { DropItem, TrackInfo, UpgradeTracks } from './types';

/** Stable selection/render key. Variants share item_id with their base, so
 *  they need a distinct id. */
export function dropUid(item: DropItem): string {
  if (item.is_void_forge) return `${item.item_id}:vf`;
  if (item.is_catalyst) return `${item.item_id}:cat:${item.source_item_id ?? 0}`;
  return `${item.item_id}`;
}

/** Upgrade tracks lowest to highest. Rank, not item level, is what says whether
 *  a drop can give you something crests on your own copy cannot. */
export const TRACK_ORDER = ['Explorer', 'Adventurer', 'Veteran', 'Champion', 'Hero', 'Myth'];

/** Position of a track, or -1 for gear that sits off the tracks entirely
 *  (crafted pieces, the Very Rare fixed-ilvl drops). */
export function trackRank(track?: string | null): number {
  if (!track) return -1;
  return TRACK_ORDER.findIndex((name) => track.startsWith(name));
}

export function getTrackInfo(
  item: DropItem,
  raidDiff: string,
  dungeonDiff: string
): TrackInfo | null {
  return item.dungeon_info?.[dungeonDiff] ?? item.difficulty_info?.[raidDiff] ?? null;
}

export function resolveUpgrade(
  item: DropItem,
  raidDiff: string,
  dungeonDiff: string,
  upgradeLevel: number,
  tracks: UpgradeTracks
): { ilvl: number; bonus_id: number; quality: number } {
  const base = getTrackInfo(item, raidDiff, dungeonDiff);
  if (!base || !base.track || upgradeLevel <= 0) {
    return {
      ilvl: base?.ilvl ?? item.ilevel,
      bonus_id: base?.bonus_id ?? 0,
      quality: base?.quality ?? item.quality,
    };
  }
  const trackLevels = tracks[base.track];
  if (!trackLevels) return { ilvl: base.ilvl, bonus_id: base.bonus_id, quality: base.quality };
  const target = trackLevels.find((t) => t.level === upgradeLevel);
  if (!target) return { ilvl: base.ilvl, bonus_id: base.bonus_id, quality: base.quality };
  return { ilvl: target.ilvl, bonus_id: target.bonus_id, quality: target.quality };
}

/** The rank a candidate is actually simmed at: the rank picked in the control
 *  when the item's track has it, else the rank the drop comes at. 0 for gear
 *  that sits off the tracks (crafted, the Very Rare fixed-ilvl drops), which no
 *  rank can move. Mirrors `resolveUpgrade` — they must agree on what a run tests
 *  so the equipped baseline can be raised to meet it. */
export function effectiveUpgradeLevel(
  item: DropItem,
  raidDiff: string,
  dungeonDiff: string,
  upgradeLevel: number,
  tracks: UpgradeTracks
): number {
  const base = getTrackInfo(item, raidDiff, dungeonDiff);
  if (!base?.track) return 0;
  if (upgradeLevel > 0 && tracks[base.track]?.some((level) => level.level === upgradeLevel))
    return upgradeLevel;
  return base.level ?? 0;
}

export function detectClass(simcInput: string): string | null {
  const m = simcInput.match(
    /^(warrior|paladin|hunter|rogue|priest|death_knight|deathknight|shaman|mage|warlock|monk|demon_hunter|demonhunter|druid|evoker)\s*=/m
  );
  return m ? m[1] : null;
}

export function detectSpec(simcInput: string): string | null {
  const m = simcInput.match(/^spec=(\w+)/m);
  return m ? m[1] : null;
}
