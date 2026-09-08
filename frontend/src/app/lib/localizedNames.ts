'use client';

import { useEffect, useState } from 'react';
import { apiUrl } from './api';
import { useLanguage } from './i18n';
import { CLASS_NAME_TO_ID, SPEC_NAME_TO_ID, specDisplayName } from './types';

/** Locales the backend ships a `/api/localized-names/{locale}` bundle for.
 *  Anything else renders the English fallback and never issues a request. */
export const SUPPORTED_DATA_LOCALES = new Set(['zh_CN']);

/** The small game-data name tables, keyed by the numeric id as a string
 *  (JSON object keys). Items and spells are NOT here — those stay on the
 *  on-demand path in `useItemInfo`. */
export interface LocalizedNamesBundle {
  locale: string;
  instances?: Record<string, string>;
  encounters?: Record<string, string>;
  currencies?: Record<string, string>;
  nameDescriptions?: Record<string, string>;
  maps?: Record<string, string>;
  classes?: Record<string, string>;
  specs?: Record<string, string>;
  difficulties?: Record<string, string>;
  enchants?: Record<string, string>;
}

type BundleTable = keyof Omit<LocalizedNamesBundle, 'locale'>;

const bundles: Record<string, LocalizedNamesBundle> = {};
/** Locales whose fetch is in flight or already settled — one request per session. */
const requestedLocales = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const cb of listeners) cb();
}

/** Fetch the bundle for `locale` once. Unsupported locales never hit the
 *  network; a failed fetch is swallowed so every helper falls back to English. */
function ensureLocalizedNames(locale: string) {
  if (typeof window === 'undefined') return;
  if (!SUPPORTED_DATA_LOCALES.has(locale)) return;
  if (requestedLocales.has(locale)) return;
  requestedLocales.add(locale);
  fetch(apiUrl(`/api/localized-names/${locale}`))
    .then((res) => (res.ok ? res.json() : null))
    .then((data: LocalizedNamesBundle | null) => {
      if (!data) return;
      bundles[locale] = data;
      notify();
    })
    .catch(() => {});
}

function lookup(table: BundleTable, id: number | string, locale: string): string | undefined {
  if (!locale || !SUPPORTED_DATA_LOCALES.has(locale)) return undefined;
  if (!id && id !== 0) return undefined;
  return bundles[locale]?.[table]?.[String(id)];
}

/** Subscribe to the bundle for the active locale; re-renders when it arrives.
 *  Every component that calls one of the helpers below must call this. */
export function useLocalizedNames() {
  const { locale } = useLanguage();
  const [, bumpVersion] = useState(0);

  useEffect(() => {
    const cb = () => bumpVersion((n) => n + 1);
    listeners.add(cb);
    ensureLocalizedNames(locale);
    return () => {
      listeners.delete(cb);
    };
  }, [locale]);
}

/** Journal instance (dungeon / raid) name. */
export function localizedInstanceName(
  instanceId: number | undefined | null,
  fallback: string,
  locale: string
): string {
  return lookup('instances', instanceId ?? 0, locale) ?? fallback;
}

/** Journal encounter (boss) name. */
export function localizedEncounterName(
  encounterId: number | undefined | null,
  fallback: string,
  locale: string
): string {
  return lookup('encounters', encounterId ?? 0, locale) ?? fallback;
}

/** Currency name (crests, valorstones, ...). */
export function localizedCurrencyName(
  currencyId: number | undefined | null,
  fallback: string,
  locale: string
): string {
  return lookup('currencies', currencyId ?? 0, locale) ?? fallback;
}

/** UI map name — the dungeon a M+ route runs in. */
export function localizedMapName(
  mapId: number | undefined | null,
  fallback: string,
  locale: string
): string {
  return lookup('maps', mapId ?? 0, locale) ?? fallback;
}

/** `ItemNameDescription` — the affix / crafted suffix on an item name
 *  ("Venomcursed", "Tidal Crafted"). */
export function localizedNameDescription(
  descriptionId: number | undefined | null,
  fallback: string,
  locale: string
): string {
  return lookup('nameDescriptions', descriptionId ?? 0, locale) ?? fallback;
}

/** `Difficulty` DB2 name by id. */
export function localizedDifficultyName(
  difficultyId: number | undefined | null,
  fallback: string,
  locale: string
): string {
  return lookup('difficulties', difficultyId ?? 0, locale) ?? fallback;
}

/** Enchant name from `SpellItemEnchantment`. Use as a fallback for enchants the
 *  on-demand item/spell lookup in `useItemInfo` cannot name. */
export function localizedEnchantDisplayName(
  enchantId: number | undefined | null,
  fallback: string,
  locale: string
): string {
  return lookup('enchants', enchantId ?? 0, locale) ?? fallback;
}

/** Class name from a SimC class id (`death_knight` → 死亡骑士). */
export function localizedClassName(classSimcName: string, locale: string): string {
  const fallback = specDisplayName(classSimcName);
  if (!classSimcName) return fallback;
  const id = CLASS_NAME_TO_ID[classSimcName];
  if (!id) return fallback;
  return lookup('classes', id, locale) ?? fallback;
}

/** Spec name from a SimC spec id (`beast_mastery` → 野兽掌握). */
export function localizedSpecName(specSimcName: string, locale: string): string {
  const fallback = specDisplayName(specSimcName);
  if (!specSimcName) return fallback;
  const id = SPEC_NAME_TO_ID[specSimcName];
  if (!id) return fallback;
  return lookup('specs', id, locale) ?? fallback;
}

/** "Retribution Paladin" → "惩戒 圣骑士", localizing each half independently. */
export function localizedSpecClassName(
  specSimcName: string,
  classSimcName: string,
  locale: string
): string {
  const spec = localizedSpecName(specSimcName, locale);
  const cls = localizedClassName(classSimcName, locale);
  if (!classSimcName) return spec;
  if (!specSimcName) return cls;
  return `${spec} ${cls}`;
}
