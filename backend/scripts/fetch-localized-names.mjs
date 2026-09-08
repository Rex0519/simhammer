#!/usr/bin/env node
/**
 * Fetch localized game names (items, spells, enchants, journal instances and
 * encounters, currencies, name descriptions, maps, classes, specs,
 * difficulties) from wago.tools' DB2 CSV exports and write them to
 * `localized-names.<locale>.json` in the game-data directory.
 *
 * Raidbots ships localized *item* names only, and its bundle has no zh_CN for
 * anything else, so every other name the UI shows comes from here.
 *
 *   node fetch-localized-names.mjs <locale> [outDir] [--data-dir=<dir>] \
 *       [--build=<x.y.z.nnnnn>]
 *
 * `spells` is 416k rows client-side; only the ids the UI renders from local data
 * (talent node entries + enchantment spells, read from `--data-dir`, default
 * `outDir`) are bundled. Everything else resolves on demand through Wowhead.
 *
 * Node 20+ (global fetch), no dependencies. Idempotent; prints per-table counts.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = path.join(SCRIPT_DIR, "..", "resources", "data");

// Which DB2 table each output section comes from. `ID` is NOT always the first
// column (JournalEncounter, ChrSpecialization and ChrClasses put the localized
// name first), so columns are always resolved by header name.
// `minRows` is an inclusive floor on the *raw* row count of the export (before
// empty names and the spell filter drop anything): a truncated response or a
// table wago silently emptied must fail the run instead of shipping a bundle
// that is quietly English. Floors sit far under today's counts (ItemSparse
// 175 836, JournalInstance 232, JournalEncounter 1 217, CurrencyTypes 1 872,
// ChrClasses 16, ChrSpecialization 140) so a normal patch never trips them.
const TABLES = [
  {
    key: "items",
    table: "ItemSparse",
    idColumn: "ID",
    nameColumn: "Display_lang",
    minRows: 50_001,
  },
  { key: "spells", table: "SpellName", idColumn: "ID", nameColumn: "Name_lang", referenced: true },
  { key: "enchants", table: "SpellItemEnchantment", idColumn: "ID", nameColumn: "Name_lang" },
  {
    key: "instances",
    table: "JournalInstance",
    idColumn: "ID",
    nameColumn: "Name_lang",
    minRows: 101,
  },
  {
    key: "encounters",
    table: "JournalEncounter",
    idColumn: "ID",
    nameColumn: "Name_lang",
    minRows: 501,
  },
  {
    key: "currencies",
    table: "CurrencyTypes",
    idColumn: "ID",
    nameColumn: "Name_lang",
    minRows: 501,
  },
  {
    key: "nameDescriptions",
    table: "ItemNameDescription",
    idColumn: "ID",
    nameColumn: "Description_lang",
  },
  { key: "maps", table: "Map", idColumn: "ID", nameColumn: "MapName_lang" },
  { key: "classes", table: "ChrClasses", idColumn: "ID", nameColumn: "Name_lang", minRows: 10 },
  {
    key: "specs",
    table: "ChrSpecialization",
    idColumn: "ID",
    nameColumn: "Name_lang",
    minRows: 30,
  },
  { key: "difficulties", table: "Difficulty", idColumn: "ID", nameColumn: "Name_lang" },
];

/** Files in the data dir that name the spell ids the UI renders locally. */
const SPELL_ID_SOURCES = ["talents.json", "enchantments.json"];

/** A talents.json that parses but yields almost nothing is a broken fetch. */
const MIN_REFERENCED_SPELLS = 1000;

/**
 * RFC-4180 CSV parser fed in chunks: emits complete rows as they close, so the
 * 49 MB ItemSparse export never has to be held as one string. Quoted fields may
 * contain commas, newlines and doubled quotes (spec descriptions do all three).
 */
class CsvRowParser {
  constructor(onRow) {
    this.onRow = onRow;
    this.field = "";
    this.row = [];
    this.inQuotes = false;
    this.pendingQuote = false; // saw `"` inside quotes; `""` is a literal quote
    this.started = false; // distinguishes "" from a trailing blank line
  }

  push(text) {
    for (const ch of text) {
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (ch === '"') {
          this.field += '"';
          continue;
        }
        this.inQuotes = false;
        // fall through: this char is a normal delimiter/content char
      }
      if (this.inQuotes) {
        if (ch === '"') this.pendingQuote = true;
        else this.field += ch;
        continue;
      }
      if (ch === '"') {
        this.inQuotes = true;
        this.started = true;
      } else if (ch === ",") {
        this.endField();
      } else if (ch === "\n") {
        this.endField();
        this.endRow();
      } else if (ch !== "\r") {
        this.field += ch;
        this.started = true;
      }
    }
  }

  endField() {
    this.row.push(this.field);
    this.field = "";
    this.started = true;
  }

  endRow() {
    this.onRow(this.row);
    this.row = [];
    this.started = false;
  }

  end() {
    if (this.field !== "" || this.row.length > 0 || this.started) {
      this.endField();
      this.endRow();
    }
  }
}

/** Streams `url` through the CSV parser, calling `onRow(fields)` per row. */
async function streamCsv(url, onRow) {
  const response = await fetch(url, {
    headers: { "User-Agent": "SimHammer" },
    // wago occasionally accepts the connection and then stalls; without this the
    // run hangs forever inside a CI step that has no timeout of its own.
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const parser = new CsvRowParser(onRow);
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of response.body) {
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.end();
}

/** wago.tools spells locales without the underscore: `zh_CN` -> `zhCN`. */
function wagoLocale(locale) {
  return locale.replace("_", "");
}

/** Marks an error the retry must not paper over (schema drift, row floor). */
function fatal(message) {
  const err = new Error(message);
  err.fatal = true;
  return err;
}

async function fetchTable({ table, idColumn, nameColumn, minRows }, locale, build, keepIds) {
  const params = new URLSearchParams({ locale: wagoLocale(locale) });
  if (build) params.set("build", build);
  const url = `https://wago.tools/db2/${table}/csv?${params}`;

  const names = {};
  let header = null;
  let idIndex = -1;
  let nameIndex = -1;
  let rows = 0;

  await streamCsv(url, (fields) => {
    if (header === null) {
      header = fields;
      idIndex = header.indexOf(idColumn);
      nameIndex = header.indexOf(nameColumn);
      if (idIndex < 0 || nameIndex < 0) {
        // Schema drift, not a flaky response: retrying just fails twice.
        throw fatal(
          `${table}: missing column ${idIndex < 0 ? idColumn : nameColumn} in header [${header.slice(0, 8).join(",")}...]`
        );
      }
      return;
    }
    rows += 1;
    const name = fields[nameIndex];
    if (!name) return; // no localized string for this row
    const id = Number.parseInt(fields[idIndex], 10);
    if (!Number.isFinite(id)) return;
    if (keepIds && !keepIds.has(id)) return; // not referenced by local data
    names[String(id)] = name;
  });

  if (minRows && rows < minRows) {
    throw fatal(`${table}: only ${rows} rows (expected at least ${minRows}) — refusing to ship`);
  }

  return names;
}

/** Two tries: a single flaky wago response should not lose a whole run. */
async function fetchTableWithRetry(config, locale, build, keepIds) {
  try {
    return await fetchTable(config, locale, build, keepIds);
  } catch (err) {
    if (err.fatal) throw err;
    console.warn(`  ${config.table}: ${err.message} — retrying`);
    return await fetchTable(config, locale, build, keepIds);
  }
}

/** Every numeric value under a `*spellId` key, at any depth. */
function collectSpellIds(node, out) {
  if (Array.isArray(node)) {
    for (const child of node) collectSpellIds(child, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (/spellid$/i.test(key) && Number.isInteger(value)) out.add(value);
      else collectSpellIds(value, out);
    }
  }
}

/**
 * Spell ids the UI renders from local data: talent node entries (`spellId` and
 * `visibleSpellId`, class/spec/hero/subtree trees alike) and enchantment
 * spells. Sim-result abilities are not here on purpose — they are unbounded and
 * already resolve through the on-demand Wowhead path.
 */
function referencedSpellIds(dataDir) {
  const ids = new Set();
  for (const filename of SPELL_ID_SOURCES) {
    const file = path.join(dataDir, filename);
    if (!fs.existsSync(file)) {
      throw new Error(
        `${file} not found — fetch the Raidbots data first, or pass --data-dir. ` +
          `Without it the bundle would ship no spell names at all.`
      );
    }
    collectSpellIds(JSON.parse(fs.readFileSync(file, "utf8")), ids);
  }
  if (ids.size < MIN_REFERENCED_SPELLS) {
    throw new Error(
      `only ${ids.size} referenced spell ids found in ${SPELL_ID_SOURCES.join(" + ")} ` +
        `(expected at least ${MIN_REFERENCED_SPELLS}) — refusing to ship`
    );
  }
  return ids;
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
  const build = options.build;
  const locale = positional[0];
  const outDir = positional[1] || DEFAULT_OUT_DIR;
  // Where talents.json / enchantments.json live. Same dir as the output in
  // every wired-in call site; separate flag so a one-off fetch can point at it.
  const dataDir = options["data-dir"] || outDir;

  if (!locale || !/^[a-z]{2}_[A-Z]{2}$/.test(locale)) {
    console.error(
      "Usage: node fetch-localized-names.mjs <locale> [outDir] [--data-dir=<dir>] [--build=x.y.z.nnnnn]"
    );
    console.error("  e.g. node fetch-localized-names.mjs zh_CN");
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const spellIds = referencedSpellIds(dataDir);

  const output = {
    locale,
    source: "wago.tools",
    fetched_at: new Date().toISOString(),
  };

  console.log(`Fetching ${locale} game names from wago.tools${build ? ` (build ${build})` : ""}...`);
  console.log(`  ${spellIds.size} spell ids referenced by ${SPELL_ID_SOURCES.join(" + ")}`);
  for (const config of TABLES) {
    const names = await fetchTableWithRetry(config, locale, build, config.referenced ? spellIds : null);
    output[config.key] = names;
    console.log(`  ${config.key.padEnd(17)} ${Object.keys(names).length} names (${config.table})`);
  }

  const outPath = path.join(outDir, `localized-names.${locale}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output));
  console.log(`Wrote ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
