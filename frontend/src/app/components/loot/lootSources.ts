import type { DropItem } from './types';

/** A boss whose drops the run can be narrowed to. */
export interface PoolBoss {
  key: string;
  name: string;
}

/** One raid or dungeon in the pool, with the bosses that drop into it. */
export interface PoolSource {
  key: string;
  name: string;
  bosses: PoolBoss[];
}

/** Identity of the boss a drop comes from. The id is what makes it an identity:
 *  two instances can share a boss name, and excluding one must not silence the
 *  other. Falls back to the name for pools that answer without ids. */
export function bossKey(item: DropItem): string {
  return `boss:${item.encounter_id ?? item.encounter}`;
}

function instanceKey(item: DropItem): string {
  return `instance:${item.instance_id ?? item.instance_name ?? ''}`;
}

/** The instances the given drops come from, each with its bosses, in the order
 *  they first appear — so the filter reads in the same order as the table it
 *  narrows. Pass the rows the table is showing, not the raw pool, or it offers
 *  bosses whose drops are not on screen. */
export function poolSources(items: DropItem[]): PoolSource[] {
  const sources = new Map<string, PoolSource>();
  const seenBosses = new Set<string>();
  for (const item of items) {
    if (!item.encounter) continue;
    const key = instanceKey(item);
    const source = sources.get(key) ?? { key, name: item.instance_name ?? '', bosses: [] };
    sources.set(key, source);
    const boss = bossKey(item);
    if (seenBosses.has(boss)) continue;
    seenBosses.add(boss);
    source.bosses.push({ key: boss, name: item.encounter });
  }
  return [...sources.values()];
}

/** Whether a drop is out of the run because its boss is switched off. An
 *  instance is switched off by excluding every boss under it, so there is one
 *  kind of key to reason about rather than two that can disagree. */
export function isSourceExcluded(item: DropItem, excluded: ReadonlySet<string>): boolean {
  return excluded.has(bossKey(item));
}
