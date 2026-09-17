import { decodeHeader } from './talentDecode';
import { SPEC_ID_TO_NAME } from './classSpecs';

/** Adler-32 matching the SimC addon. The Lua addon processes raw UTF-8 bytes, so we do too. */
function adler32(s: string): number {
  const prime = 65521;
  let s1 = 1;
  let s2 = 0;
  const bytes = new TextEncoder().encode(s);
  for (let i = 0; i < bytes.length; i++) {
    s1 = (s1 + bytes[i]) % prime;
    s2 = (s2 + s1) % prime;
  }
  return ((s2 << 16) | s1) >>> 0;
}

/** Validate the SimC addon checksum. Returns null if no checksum present. */
export function validateChecksum(input: string): 'valid' | 'invalid' | null {
  const match = input.match(/^#\s*Checksum:\s*([0-9a-fA-F]+)\s*$/m);
  if (!match) return null;
  const expected = parseInt(match[1], 16);
  // Checksum covers everything before the checksum line.
  const idx = input.indexOf(match[0]);
  let body = input.substring(0, idx);
  // Normalize to \n, then try both \n and \r\n (line endings vary by export source).
  body = body.replace(/\r\n/g, '\n');
  if (adler32(body) === expected) return 'valid';
  if (adler32(body.replace(/\n/g, '\r\n')) === expected) return 'valid';
  return 'invalid';
}

/** Check if text looks like a valid SimC addon export (class line, spec, level, valid checksum). */
export function isValidSimcExport(text: string): boolean {
  if (!text || text.length < 50) return false;
  const hasClass = /^\w+="[^"]+"/m.test(text);
  const hasSpec = /^spec=\w+/m.test(text);
  const hasLevel = /^level=\d+/m.test(text);
  const checksum = validateChecksum(text);
  return hasClass && hasSpec && hasLevel && checksum === 'valid';
}

const GEAR_SLOT_RE =
  /^#?\s*(head|neck|shoulder|back|chest|wrist|hands|waist|legs|feet|finger1|finger2|trinket1|trinket2|main_hand|off_hand)=(.+)/i;

interface BagItem {
  slot: string;
  line: string;
}

/** Parse bag items from a SimC export. Bag items are commented-out gear lines (`#`);
 *  equipped items are uncommented. */
function parseBagItems(simcInput: string): BagItem[] {
  const items: BagItem[] = [];
  for (const rawLine of simcInput.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('#')) continue;
    const clean = line.replace(/^#+\s*/, '');
    const match = clean.match(GEAR_SLOT_RE);
    if (match) {
      items.push({ slot: match[1].toLowerCase(), line: clean });
    }
  }
  return items;
}

/** Diff bag items between two SimC exports (added = in new not old, and vice versa). */
export function diffBagItems(
  oldSimc: string,
  newSimc: string
): { added: string[]; removed: string[] } {
  const oldItems = new Set(parseBagItems(oldSimc).map((i) => i.line));
  const newItems = new Set(parseBagItems(newSimc).map((i) => i.line));

  const added: string[] = [];
  const removed: string[] = [];

  for (const line of newItems) {
    if (!oldItems.has(line)) added.push(line);
  }
  for (const line of oldItems) {
    if (!newItems.has(line)) removed.push(line);
  }

  return { added, removed };
}

/** Extract a readable item name from a SimC item line, falling back to the slot. */
export function itemNameFromLine(line: string): string {
  const slotMatch = line.match(/^(\w+)=/);
  const nameMatch = line.match(/name=([^,]+)/);
  if (nameMatch) return nameMatch[1].replace(/_/g, ' ');
  return slotMatch?.[1]?.replace(/_/g, ' ') ?? 'Unknown item';
}

/** Check if two SimC exports differ in meaningful content (ignores whitespace/ordering). */
export function hasSimcChanged(oldSimc: string, newSimc: string): boolean {
  if (!oldSimc && !newSimc) return false;
  if (!oldSimc || !newSimc) return true;

  const normalize = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .sort()
      .join('\n');

  return normalize(oldSimc) !== normalize(newSimc);
}

/** Class/spec pairs the SimC engine rejects at init, leaving the sim with no
 *  actor. Mirrors UNSIMMABLE_SPECS in backend/core/src/types/class_data.rs —
 *  test-simc-validation.cjs asserts the two lists stay in step.
 *
 *  Not derived from role: SimC sims Restoration Druid and Restoration Shaman as
 *  DPS actors, so they are deliberately absent. */
export const UNSIMMABLE_SPECS: [string, string][] = [
  ['paladin', 'holy'],
  ['priest', 'discipline'],
  ['priest', 'holy'],
  ['monk', 'mistweaver'],
  ['evoker', 'preservation'],
];

/** Whether SimC can produce a result for this class/spec pair. Unknown pairs are
 *  simmable: the gate rejects only what SimC is known to reject. */
export function specIsSimmable(className: string, spec: string): boolean {
  const c = className.toLowerCase();
  const s = spec.toLowerCase();
  return !UNSIMMABLE_SPECS.some(([uc, us]) => uc === c && us === s);
}

/** Spec encoded in a talent loadout string, or '' when it won't decode. */
export function specFromTalentString(talentString: string): string {
  if (!talentString) return '';
  try {
    return SPEC_ID_TO_NAME[decodeHeader(talentString).specId] ?? '';
  } catch {
    return '';
  }
}

/** The spec the backend will actually sim: a selected talent loadout rewrites
 *  `spec=` (see apply_spec_override), so a Holy Paladin on a Retribution
 *  loadout sims as Retribution. Falls back to the profile's own spec= line. */
export function effectiveSpec(simcInput: string, selectedTalent: string): string {
  return specFromTalentString(selectedTalent) || (simcInput.match(/^spec=(\w+)/m)?.[1] ?? '');
}
