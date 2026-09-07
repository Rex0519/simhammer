/**
 * Node-level diff between two talent export strings (upstream #97). Decodes both
 * against the same tree, then classifies every node as added / removed / changed
 * (rank or choice entry). Cross-spec pairs can't be diffed node-for-node because
 * the two strings index different spec trees, so those return `null`.
 */

import { decodeHeader, decodeNodes, type NodeSelection } from './talentDecode';
import type { TalentNode, TalentTreeData } from './useTalentTree';

export interface TalentDiffEntry {
  nodeId: number;
  name: string;
  icon: string;
  spellId?: number;
  from?: string;
  to?: string;
}

export interface TalentDiff {
  added: TalentDiffEntry[];
  removed: TalentDiffEntry[];
  changed: TalentDiffEntry[];
}

/** nodeId -> maxRanks, using the tree-wide map with a per-node fallback.
 *  Same fallback chain as `TalentPicker.getBuildStatus` — `fullNodeMaxRanks`
 *  covers every node of the class, the local map only the fetched spec. */
function buildMaxRanks(tree: TalentTreeData, nodes: TalentNode[]): Map<number, number> {
  const localMap = new Map(nodes.map((n) => [n.id, n.maxRanks ?? 1]));
  return new Map(
    tree.fullNodeOrder.map((id) => [id, tree.fullNodeMaxRanks?.[id] ?? localMap.get(id) ?? 1])
  );
}

/** The entry a selection points at: the picked side of a choice node, else the first. */
function selectedEntry(node: TalentNode, sel: NodeSelection) {
  if (sel.choiceIndex >= 0 && node.entries[sel.choiceIndex]) return node.entries[sel.choiceIndex];
  return node.entries[0];
}

function toEntry(node: TalentNode, sel: NodeSelection): TalentDiffEntry {
  const entry = selectedEntry(node, sel);
  return {
    nodeId: node.id,
    name: entry?.name || node.name,
    icon: entry?.icon || '',
    spellId: entry?.spellId,
  };
}

/** Human label for one side of a changed node: the entry name when the choice
 *  moved, otherwise the rank count. */
function selectionLabel(node: TalentNode, sel: NodeSelection): string {
  if (sel.choiceIndex >= 0) {
    const entry = node.entries[sel.choiceIndex];
    if (entry?.name) return entry.name;
  }
  return `rank ${sel.ranks}`;
}

function decode(
  talentString: string,
  tree: TalentTreeData,
  nodes: TalentNode[]
): { specId: number; selections: Map<number, NodeSelection> } | null {
  try {
    const header = decodeHeader(talentString);
    const selections = decodeNodes(
      header.bits,
      header.offset,
      tree.fullNodeOrder,
      buildMaxRanks(tree, nodes)
    );
    return { specId: header.specId, selections };
  } catch {
    return null;
  }
}

/**
 * Diff talent string `b` against baseline `a`. Returns `null` when either string
 * fails to decode or the two target different specs (the caller shows the
 * cross-spec notice instead).
 */
export function diffTalentStrings(a: string, b: string, tree: TalentTreeData): TalentDiff | null {
  if (!a || !b || !tree?.fullNodeOrder) return null;

  const nodes: TalentNode[] = [...tree.classNodes, ...tree.specNodes, ...tree.heroNodes];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const from = decode(a, tree, nodes);
  const to = decode(b, tree, nodes);
  if (!from || !to || from.specId !== to.specId) return null;

  const diff: TalentDiff = { added: [], removed: [], changed: [] };

  for (const nodeId of tree.fullNodeOrder) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const before = from.selections.get(nodeId);
    const after = to.selections.get(nodeId);
    if (!before && !after) continue;

    if (!before && after) {
      diff.added.push(toEntry(node, after));
    } else if (before && !after) {
      diff.removed.push(toEntry(node, before));
    } else if (
      before &&
      after &&
      (before.ranks !== after.ranks || before.choiceIndex !== after.choiceIndex)
    ) {
      diff.changed.push({
        ...toEntry(node, after),
        from: selectionLabel(node, before),
        to: selectionLabel(node, after),
      });
    }
  }

  return diff;
}
