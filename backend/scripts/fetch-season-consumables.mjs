#!/usr/bin/env node
/**
 * Fetch the per-spec recommended consumables from SimulationCraft's own season
 * profiles and write them to `season-consumables.json` in the game-data
 * directory.
 *
 * SimulationCraft applies NO consumable when a profile carries no
 * `flask=`/`food=`/`potion=`/`augmentation=`/`temporary_enchant=` line, so a
 * user who never touches the consumable dropdowns sims unbuffed (~1.3% DPS
 * low). Raidbots defaults to fully consumed; this file is what lets the backend
 * do the same, using exactly the items SimC's own profiles use.
 *
 *   node fetch-season-consumables.mjs [outDir] [--profiles-dir=MID2] \
 *       [--branch=midnight] [--season-config=<path>]
 *
 * `--profiles-dir` defaults to `simcProfilesDir` in core/season-config.json
 * (the directory under `profiles/` in github.com/simulationcraft/simc);
 * `--season-config` points at that file where it is not next to this script
 * (the standalone image bakes the two in as siblings under /app).
 *
 * Node 20+ (global fetch), no dependencies. Idempotent; prints per-spec counts.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = path.join(SCRIPT_DIR, "..", "resources", "data");
const SEASON_CONFIG = path.join(SCRIPT_DIR, "..", "core", "season-config.json");

const REPO = "simulationcraft/simc";
const DEFAULT_BRANCH = "midnight";

/** Consumable keys, verbatim as SimC writes them in a profile. */
const CONSUMABLE_KEYS = ["potion", "flask", "food", "augmentation", "temporary_enchant"];

/**
 * Hero-talent variants share a spec (`MID2_Paladin_Retribution_Templar.simc`
 * and `MID2_Paladin_Retribution.simc` both key `paladin/retribution`), so the
 * spec count is well under the file count. 25 sits under today's 29 with room
 * for a spec or two to drop out, but far above a truncated fetch.
 */
const MIN_SPECS = 25;

/** `<class>="<profile name>"` — the first line of every SimC profile. */
const CLASS_LINE = /^([a-z_]+)="/;

/** Fetch with a timeout; GitHub occasionally accepts and then stalls. */
async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "SimHammer" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.text();
}

/** The `*.simc` files in `profiles/<dir>`, as `{ name, download_url }`. */
async function listProfiles(profilesDir, branch) {
  const url = `https://api.github.com/repos/${REPO}/contents/profiles/${profilesDir}?ref=${branch}`;
  const entries = JSON.parse(await fetchText(url));
  if (!Array.isArray(entries)) {
    throw new Error(`profiles/${profilesDir} is not a directory on ${branch}`);
  }
  // `download_url` rather than a hand-built raw URL: some profile names carry
  // an apostrophe (MID2_Death_Knight_Unholy_San'layn.simc) that needs escaping.
  return entries
    .filter((e) => e.type === "file" && e.name.endsWith(".simc") && e.download_url)
    .map((e) => ({ name: e.name, url: e.download_url }));
}

/**
 * The class, spec and consumables of one profile. Only line-initial keys count:
 * `potion` also appears inside the APL as `actions.precombat+=/potion,...`.
 */
function parseProfile(text) {
  let className = null;
  let spec = null;
  const consumables = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (className === null) {
      const match = line.match(CLASS_LINE);
      if (match) {
        className = match[1];
        continue;
      }
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "spec") {
      if (spec === null) spec = value;
    } else if (CONSUMABLE_KEYS.includes(key) && value && !(key in consumables)) {
      // Kept verbatim: `temporary_enchant` values are already in SimC syntax
      // (`main_hand:thalassian_phoenix_oil_2`).
      consumables[key] = value;
    }
  }
  return { className, spec, consumables };
}

/** `--flag=value` and `--flag value` both, plus positional args, in one pass. */
function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) options[arg.slice(2, eq)] = arg.slice(eq + 1);
    else options[arg.slice(2)] = argv[++i];
  }
  return { options, positional };
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const outDir = positional[0] || DEFAULT_OUT_DIR;
  const branch = options.branch || DEFAULT_BRANCH;
  let profilesDir = options["profiles-dir"];
  if (!profilesDir) {
    // The season's profile directory moves every patch cycle (MID1 -> MID2 ...),
    // so it lives next to the rest of the season constants, not in this script.
    const configPath = options["season-config"] || SEASON_CONFIG;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    profilesDir = cfg.simcProfilesDir;
    if (!profilesDir) {
      throw new Error(`${configPath} has no simcProfilesDir — pass --profiles-dir=<dir>`);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Fetching ${REPO} ${branch} profiles/${profilesDir}...`);
  const profiles = await listProfiles(profilesDir, branch);
  console.log(`  ${profiles.length} profile files`);

  // Parse every profile first: one spec key is usually covered by several files
  // (the base profile plus one per hero tree), and which of them wins must not
  // depend on the order GitHub lists them in.
  const byspec = new Map();
  for (const profile of profiles) {
    const { className, spec, consumables } = parseProfile(await fetchText(profile.url));
    if (!className || !spec) {
      console.warn(`  SKIP ${profile.name} (no class/spec line)`);
      continue;
    }
    const key = `${className}/${spec}`;
    if (!byspec.has(key)) byspec.set(key, []);
    byspec.get(key).push({ name: profile.name, consumables });
  }

  const specs = {};
  for (const [key, entries] of byspec) {
    // The base profile is named `<prefix>_<Class>_<Spec>.simc`; a hero-talent
    // variant appends `_<HeroTree>` to exactly that name, so the base is the
    // shortest name in the group. Take the base and never let a variant
    // overwrite it: they do disagree (mage/fire and shaman/enhancement each
    // carry a different flask in their variant), and "last wins" silently
    // shipped a hero-tree-specific recommendation to everyone in the spec.
    entries.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
    const [base, ...variants] = entries;
    specs[key] = base.consumables;
    for (const variant of variants) {
      const differing = CONSUMABLE_KEYS.filter(
        (k) => (variant.consumables[k] ?? null) !== (base.consumables[k] ?? null)
      );
      if (differing.length) {
        console.warn(
          `  WARN ${variant.name} disagrees with ${base.name} on ${differing.join(", ")} — keeping the base profile`
        );
      }
    }
    console.log(
      `  ${key.padEnd(32)} ${Object.keys(base.consumables).length} consumables (${base.name})`
    );
  }

  const count = Object.keys(specs).length;
  if (count < MIN_SPECS) {
    throw new Error(
      `only ${count} specs parsed (expected at least ${MIN_SPECS}) — refusing to ship`
    );
  }

  const output = {
    source: `${REPO} ${branch} profiles/${profilesDir}`,
    fetched_at: new Date().toISOString(),
    specs,
  };
  const outPath = path.join(outDir, "season-consumables.json");
  fs.writeFileSync(outPath, JSON.stringify(output));
  console.log(`Wrote ${outPath} (${count} specs)`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
