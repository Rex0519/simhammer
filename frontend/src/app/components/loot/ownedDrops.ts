import type { ResolveGearResponse } from '../../lib/types';
import { trackRank } from './dropUtils';

/** An item the character already wears, reduced to what decides whether a drop
 *  of it would add anything. */
export interface OwnedItem {
  ilevel: number;
  /** Track name parsed off the resolved `upgrade` string ("Hero 4/6"); empty
   *  for gear that carries no upgrade track. */
  track: string;
}

/** Two items are the same item only if they carry the same secondaries. A
 *  catalysed piece takes its secondaries from the item it was converted from,
 *  so the source is part of the identity — the tier helm you made from one drop
 *  is not the tier helm you would make from another. */
export function ownedKey(itemId: number, sourceItemId?: number): string {
  return `${itemId}:${sourceItemId || 0}`;
}

/** Which of two worn copies a drop has to beat: the higher track, or the higher
 *  item level when neither carries one (crafted gear, Very Rare drops). */
function isBetterCopy(candidate: OwnedItem, existing: OwnedItem): boolean {
  const candidateRank = trackRank(candidate.track);
  const existingRank = trackRank(existing.track);
  if (candidateRank !== existingRank) return candidateRank > existingRank;
  return candidate.ilevel > existing.ilevel;
}

export function collectOwned(resolved: ResolveGearResponse | null): Map<string, OwnedItem> {
  const owned = new Map<string, OwnedItem>();
  for (const slot of Object.values(resolved?.slots ?? {})) {
    const item = slot.equipped;
    if (!item) continue;
    const key = ownedKey(item.item_id, item.source_item_id);
    const entry = { ilevel: item.ilevel, track: item.upgrade || '' };
    // A ring worn in both fingers resolves twice; keep the better copy, since
    // that is the one a drop has to beat. Track first, to match what decides
    // ownership below: a Myth 1/6 (318) beats a Hero 6/6 (321) despite the item
    // level, because crests can take it the rest of the way.
    const existing = owned.get(key);
    if (!existing || isBetterCopy(entry, existing)) owned.set(key, entry);
  }
  return owned;
}

/** Whether a drop would hand the character nothing they do not already have.
 *
 *  Track decides it: a copy on the track you already own is reachable with
 *  crests, so a Myth 6/6 roll of a Myth 1/6 you wear is not an acquisition. Only
 *  a higher track is. Where either side sits off the tracks — crafted gear, the
 *  Very Rare fixed-ilvl drops — item level is the only thing left to compare. */
export function isAlreadyOwned(
  drop: { item_id: number; source_item_id?: number },
  dropTrack: string | null | undefined,
  dropIlvl: number,
  owned: Map<string, OwnedItem>
): boolean {
  const have = owned.get(ownedKey(drop.item_id, drop.source_item_id));
  if (!have) return false;
  const dropRank = trackRank(dropTrack);
  const ownedRank = trackRank(have.track);
  if (dropRank >= 0 && ownedRank >= 0) return dropRank <= ownedRank;
  return dropIlvl <= have.ilevel;
}
