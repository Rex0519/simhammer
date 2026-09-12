export interface LootSelectionState {
  datasetId: string;
  availableBySlot: Record<string, string[]>;
  selected: Set<string>;
  excludedSlots: Set<string>;
  /** Listed but unselectable: gear a drop could not improve on. Held in state
   *  so no action can select it — including a bulk "select all". */
  owned: Set<string>;
  /** Bosses switched off in the source filter. Their drops leave the run the
   *  same way a hidden slot's do. */
  excludedSources: Set<string>;
  /** uid → the boss it drops from, so the gate below can tell which uids a
   *  switched-off source covers. */
  sourceByUid: Record<string, string>;
}
export const initialLootSelection: LootSelectionState = {
  datasetId: '',
  availableBySlot: {},
  selected: new Set(),
  excludedSlots: new Set(),
  owned: new Set(),
  excludedSources: new Set(),
  sourceByUid: {},
};
export type LootSelectionAction =
  | {
      type: 'reconcile';
      datasetId: string;
      availableBySlot: Record<string, string[]>;
      /** Shown, but never selectable: gear the character already has nothing to
       *  gain from. */
      ownedUids?: string[];
      /** uid → boss key, for the source filter. */
      sourceByUid?: Record<string, string>;
    }
  | { type: 'toggleSource'; keys: string[] }
  /** Apply a saved setup: the sets replace what is there rather than toggling,
   *  so restoring twice lands in the same place. */
  | { type: 'restoreFilters'; slots: string[]; sources: string[] }
  | { type: 'select' | 'clear'; uids: string[] }
  | { type: 'toggle'; uid: string }
  | { type: 'toggleSlot'; slot: string }
  | { type: 'resetSlots' };
/** The uids a run can contain: everything on offer, minus hidden slots and
 *  switched-off bosses. `sources` is optional so callers that only care about
 *  slots (tests, the slot filter itself) stay unchanged. */
export function visibleIds(
  availableBySlot: Record<string, string[]>,
  excludedSlots: Set<string>,
  sources?: Pick<LootSelectionState, 'excludedSources' | 'sourceByUid'>
): Set<string> {
  return new Set(
    Object.entries(availableBySlot)
      .filter(([slot]) => !excludedSlots.has(slot))
      .flatMap(([, ids]) => ids)
      .filter((uid) => !sources?.excludedSources.has(sources.sourceByUid[uid] ?? ''))
  );
}
export function lootSelectionReducer(
  state: LootSelectionState,
  action: LootSelectionAction
): LootSelectionState {
  const next = { ...state, selected: new Set(state.selected) };
  if (action.type === 'reconcile') {
    next.datasetId = action.datasetId;
    next.availableBySlot = action.availableBySlot;
    next.owned = new Set(action.ownedUids ?? []);
    if (action.sourceByUid) next.sourceByUid = action.sourceByUid;
    if (state.datasetId !== action.datasetId)
      next.selected = new Set(Object.values(action.availableBySlot).flat());
    // Ownership is re-resolved whenever the difficulty or rank moves. A row that
    // stops being owned is a candidate again, so it rejoins the run — while a row
    // the user ticked off was never owned and is left alone.
    else for (const uid of state.owned) if (!next.owned.has(uid)) next.selected.add(uid);
  } else if (action.type === 'restoreFilters') {
    next.excludedSlots = new Set(action.slots);
    next.excludedSources = new Set(action.sources);
    // A slot that is no longer hidden has its rows back in the run, matching
    // what un-hiding one by hand does.
    for (const [slot, uids] of Object.entries(next.availableBySlot))
      if (!next.excludedSlots.has(slot)) for (const uid of uids) next.selected.add(uid);
  } else if (action.type === 'toggleSource') {
    next.excludedSources = new Set(state.excludedSources);
    // The whole group moves together, so an instance header reads as one switch
    // rather than flipping each of its bosses in turn.
    const switchingOn = action.keys.every((key) => next.excludedSources.has(key));
    for (const key of action.keys) {
      if (switchingOn) next.excludedSources.delete(key);
      else next.excludedSources.add(key);
    }
    if (switchingOn) {
      const restored = new Set(action.keys);
      for (const [uid, source] of Object.entries(next.sourceByUid))
        if (restored.has(source)) next.selected.add(uid);
    }
  } else if (action.type === 'toggleSlot' || action.type === 'resetSlots') {
    next.excludedSlots = new Set(state.excludedSlots);
    if (action.type === 'resetSlots') next.excludedSlots.clear();
    else if (next.excludedSlots.has(action.slot)) next.excludedSlots.delete(action.slot);
    else next.excludedSlots.add(action.slot);
    for (const slot of state.excludedSlots)
      if (!next.excludedSlots.has(slot)) {
        for (const uid of state.availableBySlot[slot] ?? []) next.selected.add(uid);
      }
  } else if (action.type === 'toggle') {
    if (next.selected.has(action.uid)) next.selected.delete(action.uid);
    else next.selected.add(action.uid);
  } else {
    for (const uid of action.uids) {
      if (action.type === 'select') next.selected.add(uid);
      else next.selected.delete(uid);
    }
  }
  // One gate for every action: nothing hidden and nothing owned can be selected,
  // so neither a toggle nor a bulk select can slip an unselectable row into a run.
  const available = visibleIds(next.availableBySlot, next.excludedSlots, next);
  next.selected = new Set(
    [...next.selected].filter((uid) => available.has(uid) && !next.owned.has(uid))
  );
  return next;
}
