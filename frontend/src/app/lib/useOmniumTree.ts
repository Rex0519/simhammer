import { useEffect, useState } from 'react';
import { apiUrl } from './api';
import type { OmniumTree } from '../components/omnium/omniumSelection';

// Module-level cache: one tree for every class and spec, so it is fetched once
// per session (same pattern as useTalentTree).
let cache: OmniumTree | null = null;
let pending: Promise<OmniumTree | null> | undefined;
// A 404 is the season's settled answer — it ships no folio data — so stop
// asking. Every other failure stays retryable: `useSharedSimPayload` runs this
// hook on four pages, and one transient blip must not hide the folio for the
// rest of the session.
let absent = false;

/** The Omnium Folio tree, or null while it loads and on a season that ships no
 *  folio data (callers hide their folio UI). */
export function useOmniumTree(): OmniumTree | null {
  const [tree, setTree] = useState<OmniumTree | null>(cache);

  useEffect(() => {
    if (cache) {
      setTree(cache);
      return;
    }
    if (absent) return;

    let cancelled = false;
    pending ??= fetch(apiUrl('/api/omnium-tree')).then(async (res) => {
      if (res.status === 404) {
        absent = true;
        return null;
      }
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      return (await res.json()) as OmniumTree;
    });
    pending
      .then((data) => {
        if (!data) return;
        cache = data;
        if (!cancelled) setTree(data);
      })
      .catch(() => {
        // Retryable failure — let the next mount try again.
        pending = undefined;
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return tree;
}
