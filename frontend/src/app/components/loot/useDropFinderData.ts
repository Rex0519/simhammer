import { useCallback, useEffect, useState } from 'react';
import { apiUrl, fetchJson } from '../../lib/api';
import { dropUid } from './dropUtils';
import type { DropItem } from './types';
import type { LoadState } from './useLootCatalog';
export interface DropQuery {
  /** One entry per pool. Bonus Rolls draws on two; every other category on one. */
  sources: string[];
  className: string | null;
  specs: string[];
  voidForge: boolean;
  catalyst: boolean;
}
export function dropQueryUrl(query: Omit<DropQuery, 'sources'>, source: string): string {
  if (!source) return '';
  const params = new URLSearchParams();
  if (query.className) params.set('class_name', query.className);
  if (query.specs.length) params.set('spec', query.specs.join(','));
  params.set('void_forge', String(query.voidForge));
  params.set('catalyst', String(query.catalyst));
  const path = source.startsWith('type:')
    ? '/api/instances/type/' + source.slice(5) + '/drops'
    : '/api/instances/' + source + '/drops';
  return apiUrl(path) + '?' + params;
}
export function dropQueryUrls(query: DropQuery): string[] {
  return query.sources.map((source) => dropQueryUrl(query, source)).filter(Boolean);
}
/** Concatenate pools slot by slot. Variants already carry distinct uids, so the
 *  dedupe only guards against one item being served by two pools — and when it
 *  is, the two copies carry different ladders (a raid pool answers with
 *  `difficulty_info`, the M+ pool with `dungeon_info`). Keeping the first copy
 *  alone would leave the drop unpriceable on the other side's bonus roll, so
 *  the ladders merge onto the row that is already there. */
export function mergeDrops(pools: Record<string, DropItem[]>[]): Record<string, DropItem[]> {
  const merged: Record<string, DropItem[]> = {};
  const seen = new Map<string, DropItem>();
  for (const pool of pools) {
    for (const [slot, items] of Object.entries(pool)) {
      for (const item of items) {
        const uid = slot + ':' + dropUid(item);
        const existing = seen.get(uid);
        if (existing) {
          // Only where there is something to merge: an item with no ladder at
          // all keeps `undefined` rather than gaining an empty, truthy object.
          if (item.difficulty_info)
            existing.difficulty_info = { ...item.difficulty_info, ...existing.difficulty_info };
          if (item.dungeon_info)
            existing.dungeon_info = { ...item.dungeon_info, ...existing.dungeon_info };
          continue;
        }
        const copy = { ...item };
        seen.set(uid, copy);
        (merged[slot] ??= []).push(copy);
      }
    }
  }
  return merged;
}
export function useDropFinderData(query: DropQuery) {
  const urls = dropQueryUrls(query);
  const [attempt, setAttempt] = useState(0);
  // One key for the whole query: a pool arriving on its own must never render as
  // the complete set, so loading, errors and retries stay whole-query.
  const key = urls.join('|') + ':' + attempt;
  const [result, setResult] = useState<{
    key: string;
    state: LoadState<Record<string, DropItem[]>>;
  }>({ key: '', state: { status: 'idle' } });
  useEffect(() => {
    if (!urls.length) return;
    const controller = new AbortController();
    setResult({ key, state: { status: 'loading' } });
    Promise.all(
      urls.map((url) =>
        fetchJson<Record<string, DropItem[]> | { detail: string }>(url, {
          signal: controller.signal,
        }).then((data) => {
          if ('detail' in data) throw new Error(String(data.detail));
          return data;
        })
      )
    )
      .then((pools) => {
        if (!controller.signal.aborted)
          setResult({ key, state: { status: 'success', data: mergeDrops(pools) } });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult({ key, state: { status: 'error', error: String(error.message ?? error) } });
      });
    return () => controller.abort();
    // `urls` is rebuilt each render; `key` is its stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const state: LoadState<Record<string, DropItem[]>> = !urls.length
    ? { status: 'idle' }
    : result.key === key
      ? result.state
      : { status: 'loading' };
  return {
    ...state,
    datasetId: key,
    retry: useCallback(() => setAttempt((value) => value + 1), []),
  };
}
