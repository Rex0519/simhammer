/** Pure Omnium Folio selection logic: seeding from an import, building the
 *  `omnium_talents=` values, and multiplying rows into combinations. No React,
 *  so the rules are testable on their own (scripts/test-omnium.cjs). */

export interface OmniumEntry {
  /** Trait entry id — what `omnium_talents=` is written with. */
  id: number;
  name: string;
  spellId: number;
  icon?: string;
  index: number;
}

export interface OmniumNode {
  id: number;
  type: 'single' | 'choice';
  posY: number;
  entries: OmniumEntry[];
}

export interface OmniumTree {
  traitTreeId: number;
  nodes: OmniumNode[];
}

/** nodeId → selected entry ids. A row with an empty list contributes no rune. */
export type OmniumSelection = Record<number, number[]>;

export interface FolioCombo {
  name: string;
  omnium_string: string;
}

/** Rows top to bottom, each row's runes left to right — the order the game
 *  and the export use. */
export function folioRows(tree: OmniumTree): OmniumNode[] {
  return [...tree.nodes]
    .sort((a, b) => a.posY - b.posY)
    .map((node) => ({ ...node, entries: [...node.entries].sort((a, b) => a.index - b.index) }));
}

/** Entry ids from a profile's `omnium_talents=` line, in the order it lists them. */
export function parseOmniumEntryIds(simcInput: string): number[] {
  const line = simcInput.match(/^omnium_talents=(.+)$/m);
  if (!line) return [];
  return line[1]
    .split('/')
    .map((pair) => Number.parseInt(pair.split(':')[0], 10))
    .filter((id) => Number.isFinite(id) && id > 0);
}

/** Place imported entry ids on the rows they belong to. Ids the tree doesn't
 *  know (a rune removed between patches) are dropped. */
export function seedSelection(tree: OmniumTree, entryIds: number[]): OmniumSelection {
  const selection: OmniumSelection = {};
  for (const row of folioRows(tree)) {
    const picked = row.entries.filter((entry) => entryIds.includes(entry.id));
    if (picked.length > 0) selection[row.id] = picked.map((entry) => entry.id);
  }
  return selection;
}

/** What the folio selection should become for a given import, or `null` when it
 *  should be left alone.
 *
 *  The folio belongs to the imported character, so a new import replaces the
 *  selection — including with `{}` when it names no folio, which is what stops
 *  the next character inheriting the previous one's runes. `null` covers the two
 *  no-ops: the same import again (so edits survive), and a tree that hasn't
 *  loaded yet (seeding from it would blank a valid selection).
 *
 *  Lives here rather than inside SimContext's effect so the rule is testable
 *  without a React harness. */
export function folioSelectionForImport(
  tree: OmniumTree | null,
  simcInput: string,
  lastImport: string | null
): OmniumSelection | null {
  if (!tree || lastImport === simcInput) return null;
  return seedSelection(tree, parseOmniumEntryIds(simcInput));
}

/** `<id>:1/<id>:1` — every node in this tree is single-rank. */
export function omniumString(entryIds: number[]): string {
  return entryIds.map((id) => `${id}:1`).join('/');
}

/** The folio the sim runs unless a row varies: each row's first pick. */
export function primaryOmniumString(tree: OmniumTree, selection: OmniumSelection): string {
  const ids = folioRows(tree)
    .map((row) => (selection[row.id] ?? [])[0])
    .filter((id): id is number => id != null);
  return omniumString(ids);
}

/** The `omnium_talents=` value to send with the sim, or empty when the picked
 *  folio is the one the import already seeds.
 *
 *  Compared against the **seed**, not the raw export: rune order differs between
 *  the two (the addon lists bottom row first, the picker top row first), and an
 *  export can name runes this tree doesn't know — a season newer than the app's
 *  folio data. Seeding drops those, so comparing against the export would read
 *  as a deliberate change and rewrite the character's folio from partial data,
 *  silently simming without the missing rune. An untouched selection overrides
 *  nothing and the profile's own line stands. */
export function primaryOmniumOverride(
  tree: OmniumTree,
  selection: OmniumSelection,
  simcInput: string
): string {
  const primary = primaryOmniumString(tree, selection);
  if (!primary) return '';
  const seeded = seedSelection(tree, parseOmniumEntryIds(simcInput));
  return primary === primaryOmniumString(tree, seeded) ? '' : primary;
}

/** How many folios the current selection describes. */
export function combinationCount(selection: OmniumSelection): number {
  return Object.values(selection).reduce(
    (total, entries) => (entries.length > 0 ? total * entries.length : total),
    1
  );
}

/** Every folio the selection describes, primary first, named after the runes in
 *  the rows that vary. Empty when nothing varies — one folio needs no axis, it
 *  rides `omnium_talents` on the shared sim options instead. */
export function folioCombos(tree: OmniumTree, selection: OmniumSelection): FolioCombo[] {
  const rows = folioRows(tree).filter((row) => (selection[row.id] ?? []).length > 0);
  if (rows.every((row) => selection[row.id].length === 1)) return [];

  const entryById = new Map(rows.flatMap((row) => row.entries.map((e) => [e.id, e] as const)));
  const varying = new Set(rows.filter((row) => selection[row.id].length > 1).map((r) => r.id));

  let combos: number[][] = [[]];
  for (const row of rows) {
    combos = combos.flatMap((prefix) => selection[row.id].map((id) => [...prefix, id]));
  }

  return combos.map((ids) => ({
    name: ids
      .filter((_, i) => varying.has(rows[i].id))
      .map((id) => runeLabel(entryById.get(id)?.name ?? ''))
      .join(' · '),
    omnium_string: omniumString(ids),
  }));
}

/** Runes selected beyond the imported folio — what the section's count badge
 *  shows, so an untouched section reads 0 like Enchants and Gems. */
export function extraSelectedCount(selection: OmniumSelection, seed: OmniumSelection): number {
  return Object.entries(selection).reduce((total, [nodeId, entries]) => {
    const seeded = seed[Number(nodeId)] ?? [];
    return total + entries.filter((id) => !seeded.includes(id)).length;
  }, 0);
}

/** "Rune of Overload" → "Overload", the way the folio UI reads in game. */
export function runeLabel(name: string): string {
  const stripped = name.replace(/^Rune of /, '');
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}
