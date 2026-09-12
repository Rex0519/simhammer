import { useEffect, useReducer } from 'react';
import { initialLootSelection, lootSelectionReducer, visibleIds } from './lootSelection';
export function useLootSelection(
  datasetId: string,
  availableBySlot: Record<string, string[]>,
  ownedUids: string[] = [],
  sourceByUid: Record<string, string> = {}
) {
  const [state, dispatch] = useReducer(lootSelectionReducer, initialLootSelection);
  // Reconcile on dataset identity and the available IDs, not on fetched object
  // references — hence a string key rather than the object as an effect dep.
  const availabilityKey = JSON.stringify(availableBySlot);
  // Ownership is resolved asynchronously and lands AFTER the drops, and moves
  // again with the difficulty or rank — so it drives a reconcile, but it is NOT
  // part of the dataset identity. Folding it in made every ownership change read
  // as a new dataset, which re-selects everything and discards explicit unticks.
  const ownedKey = ownedUids.join('|');
  const sourceKey = JSON.stringify(sourceByUid);
  useEffect(() => {
    dispatch({ type: 'reconcile', datasetId, availableBySlot, ownedUids, sourceByUid });
    // `availableBySlot` is rebuilt every render; `availabilityKey` is its value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId, availabilityKey, ownedKey, sourceKey]);
  const visible = visibleIds(availableBySlot, state.excludedSlots, state);
  // Before the reducer has caught up, fall back to the same default it will
  // apply — otherwise owned rows flash as selected for a render.
  const owned = new Set(ownedUids);
  const selected =
    state.datasetId === datasetId
      ? new Set([...state.selected].filter((uid) => visible.has(uid) && !owned.has(uid)))
      : new Set([...visible].filter((uid) => !owned.has(uid)));
  return {
    selected,
    excludedSlots: state.excludedSlots,
    excludedSources: state.excludedSources,
    toggleSource: (keys: string[]) => dispatch({ type: 'toggleSource', keys }),
    restoreFilters: (slots: string[], sources: string[]) =>
      dispatch({ type: 'restoreFilters', slots, sources }),
    toggleItem: (uid: string) => dispatch({ type: 'toggle', uid }),
    selectItems: (uids: string[]) => dispatch({ type: 'select', uids }),
    clearItems: (uids: string[]) => dispatch({ type: 'clear', uids }),
    toggleSlot: (slot: string) => dispatch({ type: 'toggleSlot', slot }),
    resetExcludedSlots: () => dispatch({ type: 'resetSlots' }),
  };
}
