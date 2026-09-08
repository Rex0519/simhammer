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
 *   node fetch-localized-names.mjs <locale> [outDir] [--build=<x.y.z.nnnnn>]
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
const TABLES = [
  { key: "items", table: "ItemSparse", idColumn: "ID", nameColumn: "Display_lang" },
  { key: "spells", table: "SpellName", idColumn: "ID", nameColumn: "Name_lang" },
  { key: "enchants", table: "SpellItemEnchantment", idColumn: "ID", nameColumn: "Name_lang" },
  { key: "instances", table: "JournalInstance", idColumn: "ID", nameColumn: "Name_lang" },
  { key: "encounters", table: "JournalEncounter", idColumn: "ID", nameColumn: "Name_lang" },
  { key: "currencies", table: "CurrencyTypes", idColumn: "ID", nameColumn: "Name_lang" },
  {
    key: "nameDescriptions",
    table: "ItemNameDescription",
    idColumn: "ID",
    nameColumn: "Description_lang",
  },
  { key: "maps", table: "Map", idColumn: "ID", nameColumn: "MapName_lang" },
  { key: "classes", table: "ChrClasses", idColumn: "ID", nameColumn: "Name_lang" },
  { key: "specs", table: "ChrSpecialization", idColumn: "ID", nameColumn: "Name_lang" },
  { key: "difficulties", table: "Difficulty", idColumn: "ID", nameColumn: "Name_lang" },
];

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
  const response = await fetch(url, { headers: { "User-Agent": "SimHammer" } });
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

async function fetchTable({ table, idColumn, nameColumn }, locale, build) {
  const params = new URLSearchParams({ locale: wagoLocale(locale) });
  if (build) params.set("build", build);
  const url = `https://wago.tools/db2/${table}/csv?${params}`;

  const names = {};
  let header = null;
  let idIndex = -1;
  let nameIndex = -1;

  await streamCsv(url, (fields) => {
    if (header === null) {
      header = fields;
      idIndex = header.indexOf(idColumn);
      nameIndex = header.indexOf(nameColumn);
      if (idIndex < 0 || nameIndex < 0) {
        throw new Error(
          `${table}: missing column ${idIndex < 0 ? idColumn : nameColumn} in header [${header.slice(0, 8).join(",")}...]`
        );
      }
      return;
    }
    const name = fields[nameIndex];
    if (!name) return; // no localized string for this row
    const id = Number.parseInt(fields[idIndex], 10);
    if (!Number.isFinite(id)) return;
    names[String(id)] = name;
  });

  return names;
}

/** Two tries: a single flaky wago response should not lose a whole run. */
async function fetchTableWithRetry(config, locale, build) {
  try {
    return await fetchTable(config, locale, build);
  } catch (err) {
    console.warn(`  ${config.table}: ${err.message} — retrying`);
    return await fetchTable(config, locale, build);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const build = args.find((a) => a.startsWith("--build="))?.slice("--build=".length);
  const positional = args.filter((a) => !a.startsWith("--"));
  const locale = positional[0];
  const outDir = positional[1] || DEFAULT_OUT_DIR;

  if (!locale || !/^[a-z]{2}_[A-Z]{2}$/.test(locale)) {
    console.error("Usage: node fetch-localized-names.mjs <locale> [outDir] [--build=x.y.z.nnnnn]");
    console.error("  e.g. node fetch-localized-names.mjs zh_CN");
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  const output = {
    locale,
    source: "wago.tools",
    fetched_at: new Date().toISOString(),
  };

  console.log(`Fetching ${locale} game names from wago.tools${build ? ` (build ${build})` : ""}...`);
  for (const config of TABLES) {
    const names = await fetchTableWithRetry(config, locale, build);
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
