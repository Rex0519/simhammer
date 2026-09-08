import {
  type Dispatch,
  type SetStateAction,
  type SyntheticEvent,
  useEffect,
  useState,
} from 'react';
import { API_URL, apiUrl, fetchJsonOr } from './api';
import { QUALITY_HEX } from './qualityColors';

export interface ItemQuery {
  item_id: number;
  bonus_ids?: number[];
}

export interface ItemInfo {
  item_id: number;
  name: string;
  quality: number;
  quality_name: string;
  icon: string;
  ilevel: number;
  tag?: string;
  sockets?: number;
  upgrade?: string;
  armor_subclass?: number; // 0=Misc, 1=Cloth, 2=Leather, 3=Mail, 4=Plate
  inventory_type?: number; // 13=One-hand, 14=Shield, 17=Two-hand, 21=Main-hand, 22=Off-hand, 23=Held
}

// Module-level cache persists across renders/components.
const cache: Record<string, ItemInfo> = {};

function cacheKey(item_id: number, bonus_ids?: number[]): string {
  if (!bonus_ids || bonus_ids.length === 0) return String(item_id);
  return `${item_id}:${[...bonus_ids].sort((a, b) => a - b).join(':')}`;
}

/** @deprecated import `QUALITY_HEX` from `lib/qualityColors` instead. */
export const QUALITY_COLORS = QUALITY_HEX;

/**
 * Shared effect skeleton for the three batch-info hooks.
 * - `depKey` drives the effect dependency array.
 * - `prepare` runs inside the effect (so module-cache reads are fresh) and
 *   splits inputs into `{ cached, toFetch }`.
 * - `fetchMissing` POSTs `toFetch`, populates the module cache, and resolves
 *   the new entries; takes a `cancelled()` guard.
 * - `setState` is the hook's own dispatcher (generic so each keeps its Record type).
 */
function useBatchEffect<TItem, TFetch>(
  depKey: string,
  prepare: () => { cached: Record<number, TItem>; toFetch: TFetch[] },
  fetchMissing: (
    toFetch: TFetch[],
    signalCancelled: () => boolean
  ) => Promise<Record<number, TItem>>,
  setState: Dispatch<SetStateAction<Record<number, TItem>>>
) {
  useEffect(() => {
    const { cached, toFetch } = prepare();

    if (Object.keys(cached).length > 0) {
      setState((prev) => ({ ...prev, ...cached }));
    }

    if (toFetch.length === 0) return;

    let cancelled = false;

    (async () => {
      try {
        const batch = await fetchMissing(toFetch, () => cancelled);
        if (cancelled) return;
        if (Object.keys(batch).length > 0) setState((prev) => ({ ...prev, ...batch }));
      } catch {
        // Silently fail
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [depKey]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function useItemInfo(queries: ItemQuery[]): Record<number, ItemInfo> {
  const [items, setItems] = useState<Record<number, ItemInfo>>({});

  const depKey = queries
    .filter((q) => q.item_id > 0)
    .map((q) => cacheKey(q.item_id, q.bonus_ids))
    .join(',');

  useBatchEffect<ItemInfo, ItemQuery>(
    depKey,
    () => {
      const unique = new Map<string, ItemQuery>();
      for (const q of queries) {
        if (q.item_id <= 0) continue;
        const key = cacheKey(q.item_id, q.bonus_ids);
        if (!unique.has(key)) unique.set(key, q);
      }

      const cached: Record<number, ItemInfo> = {};
      const toFetch: ItemQuery[] = [];
      for (const [key, q] of unique) {
        if (cache[key]) {
          cached[q.item_id] = cache[key];
        } else {
          toFetch.push(q);
        }
      }
      return { cached, toFetch };
    },
    async (toFetch, signalCancelled) => {
      const body = {
        items: toFetch.map((q) => ({ item_id: q.item_id, bonus_ids: q.bonus_ids ?? [] })),
      };
      const res = await fetch(`${API_URL}/api/item-info/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok || signalCancelled()) return {};
      const data: Record<string, ItemInfo> = await res.json();
      if (signalCancelled()) return {};
      const batch: Record<number, ItemInfo> = {};
      for (const q of toFetch) {
        const info = data[String(q.item_id)];
        if (!info) continue;
        const key = cacheKey(q.item_id, q.bonus_ids);
        cache[key] = info;
        batch[q.item_id] = info;
      }
      return batch;
    },
    setItems
  );

  return items;
}

export interface EnchantInfo {
  enchant_id: number;
  name: string;
  item_id?: number;
  /** Backing spell — the only name handle for enchants with no item. */
  spell_id?: number;
}

const enchantCache: Record<number, EnchantInfo> = {};

export function useEnchantInfo(enchantIds: number[]): Record<number, EnchantInfo> {
  const [enchants, setEnchants] = useState<Record<number, EnchantInfo>>({});

  const depKey = enchantIds
    .filter((id) => id > 0)
    .sort()
    .join(',');

  useBatchEffect<EnchantInfo, number>(
    depKey,
    () => {
      const unique = new Set(enchantIds.filter((id) => id > 0));
      const cached: Record<number, EnchantInfo> = {};
      const toFetch: number[] = [];
      for (const id of unique) {
        if (enchantCache[id]) {
          cached[id] = enchantCache[id];
        } else {
          toFetch.push(id);
        }
      }
      return { cached, toFetch };
    },
    async (toFetch, signalCancelled) => {
      const res = await fetch(`${API_URL}/api/enchant-info/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: toFetch }),
      });
      if (!res.ok || signalCancelled()) return {};
      const data: { enchants: EnchantInfo[] } = await res.json();
      if (signalCancelled()) return {};
      const batch: Record<number, EnchantInfo> = {};
      for (const info of data.enchants) {
        if (!info.name) continue;
        enchantCache[info.enchant_id] = info;
        batch[info.enchant_id] = info;
      }
      return batch;
    },
    setEnchants
  );

  return enchants;
}

export interface GemInfo {
  gem_id: number;
  name: string;
  icon: string;
  quality: number;
}

const gemCache: Record<number, GemInfo> = {};

export function useGemInfo(gemIds: number[]): Record<number, GemInfo> {
  const [gems, setGems] = useState<Record<number, GemInfo>>({});

  const depKey = gemIds
    .filter((id) => id > 0)
    .sort()
    .join(',');

  useBatchEffect<GemInfo, number>(
    depKey,
    () => {
      const unique = new Set(gemIds.filter((id) => id > 0));
      const cached: Record<number, GemInfo> = {};
      const toFetch: number[] = [];
      for (const id of unique) {
        if (gemCache[id]) {
          cached[id] = gemCache[id];
        } else {
          toFetch.push(id);
        }
      }
      return { cached, toFetch };
    },
    async (toFetch, signalCancelled) => {
      const res = await fetch(`${API_URL}/api/gem-info/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: toFetch }),
      });
      if (!res.ok || signalCancelled()) return {};
      const data: { gems: GemInfo[] } = await res.json();
      if (signalCancelled()) return {};
      const batch: Record<number, GemInfo> = {};
      for (const info of data.gems) {
        if (!info.name) continue;
        gemCache[info.gem_id] = info;
        batch[info.gem_id] = info;
      }
      return batch;
    },
    setGems
  );

  return gems;
}

// ---- Localized item names (bulk from /api/item-names, then on demand) ----

// `id -> locale -> name`. Filled from /api/item-names, then extended in place by
// on-demand lookups; never reassigned so merges can't be clobbered by the bulk
// fetch resolving late.
const itemNamesMap: Record<number, Record<string, string>> = {};
const spellNamesMap: Record<number, Record<string, string>> = {};
let itemNamesLoaded = false;
let itemNamesFetching = false;
const itemNamesListeners = new Set<() => void>();

function notifyItemNames() {
  for (const cb of itemNamesListeners) cb();
}

function ensureItemNames() {
  if (itemNamesLoaded || itemNamesFetching) return;
  itemNamesFetching = true;
  fetchJsonOr<Record<string, Record<string, string>>>(apiUrl('/api/item-names'), {})
    .then((data) => {
      // JSON object keys are strings; rekey by number. Only ids that already
      // have an on-demand name need merging — those names win, being from the
      // same cache or newer. 175k plain assignments otherwise.
      for (const [id, locales] of Object.entries(data)) {
        const key = Number(id);
        const onDemand = itemNamesMap[key];
        itemNamesMap[key] = onDemand ? { ...locales, ...onDemand } : locales;
      }
      itemNamesLoaded = true;
      notifyItemNames();
    })
    .catch(() => {
      itemNamesLoaded = true;
    })
    .finally(() => {
      itemNamesFetching = false;
    });
}

// ---- On-demand names for locales item-names.json doesn't ship ----

/** Locales the backend can resolve via Wowhead (see `wowhead_locale_id`). */
const ON_DEMAND_LOCALES = new Set(['zh_CN']);
/** Matches the backend's per-request id cap. */
const MAX_LOCALIZE_IDS = 500;
const LOCALIZE_DEBOUNCE_MS = 150;

type NameKind = 'item' | 'spell';

const pendingNameIds: Record<NameKind, Set<number>> = { item: new Set(), spell: new Set() };
/** `locale:kind:id` already sent once — a miss is never re-requested this session. */
const requestedNameKeys = new Set<string>();
let pendingNameLocale: string | null = null;
let localizeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Queue one missing name for the next debounced batch. Safe to call during
 * render: it only touches module state and schedules a timer.
 */
function requestLocalizedName(kind: NameKind, id: number, locale: string) {
  if (typeof window === 'undefined') return;
  if (!id || !ON_DEMAND_LOCALES.has(locale)) return;
  const key = `${locale}:${kind}:${id}`;
  if (requestedNameKeys.has(key)) return;
  requestedNameKeys.add(key);
  // A locale switch mid-batch: send what we have before mixing locales.
  if (pendingNameLocale && pendingNameLocale !== locale) flushLocalizedNames();
  pendingNameLocale = locale;
  pendingNameIds[kind].add(id);
  // First-enqueue-wins: the timer is armed once and never reset by later
  // enqueues, so the batch flushes a fixed 150 ms after the first miss
  // rather than after the queue goes quiet. Intended — it bounds latency
  // instead of letting a steady trickle of ids starve the flush.
  if (localizeTimer === null) {
    localizeTimer = setTimeout(flushLocalizedNames, LOCALIZE_DEBOUNCE_MS);
  }
}

function mergeLocalizedNames(
  target: Record<number, Record<string, string>>,
  names: Record<string, string> | undefined,
  locale: string
): boolean {
  let merged = false;
  for (const [id, name] of Object.entries(names ?? {})) {
    if (!name) continue;
    const key = Number(id);
    target[key] = { ...target[key], [locale]: name };
    merged = true;
  }
  return merged;
}

function flushLocalizedNames(forcedLocale?: string) {
  if (localizeTimer !== null) {
    clearTimeout(localizeTimer);
    localizeTimer = null;
  }
  // Normally reads the shared locale, but a rescheduled leftover flush (below)
  // passes its own captured locale so it can't be relabeled by a locale
  // switch that lands on `pendingNameLocale` in between.
  const locale = forcedLocale ?? pendingNameLocale;
  pendingNameLocale = null;
  const items = [...pendingNameIds.item];
  const spells = [...pendingNameIds.spell];
  pendingNameIds.item.clear();
  pendingNameIds.spell.clear();
  if (!locale || (items.length === 0 && spells.length === 0)) return;

  const batchItems = items.slice(0, MAX_LOCALIZE_IDS);
  const batchSpells = spells.slice(0, MAX_LOCALIZE_IDS - batchItems.length);
  // Over the cap: keep the remainder queued for the next flush.
  const leftoverItems = items.slice(batchItems.length);
  const leftoverSpells = spells.slice(batchSpells.length);
  if (leftoverItems.length || leftoverSpells.length) {
    for (const id of leftoverItems) pendingNameIds.item.add(id);
    for (const id of leftoverSpells) pendingNameIds.spell.add(id);
    pendingNameLocale = locale;
    localizeTimer = setTimeout(() => flushLocalizedNames(locale), LOCALIZE_DEBOUNCE_MS);
  }

  void fetch(`${API_URL}/api/item-names/localize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale, items: batchItems, spells: batchSpells }),
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { items?: Record<string, string>; spells?: Record<string, string> } | null) => {
      if (!data) return;
      const itemsChanged = mergeLocalizedNames(itemNamesMap, data.items, locale);
      const spellsChanged = mergeLocalizedNames(spellNamesMap, data.spells, locale);
      if (itemsChanged || spellsChanged) notifyItemNames();
    })
    .catch(() => {});
}

/** Get item name in the given locale, falling back to the English name. */
export function localizedItemName(itemId: number, fallbackName: string, locale: string): string {
  if (!locale || locale === 'en_US') return fallbackName;
  const name = itemNamesMap[itemId]?.[locale];
  if (name) return name;
  requestLocalizedName('item', itemId, locale);
  return fallbackName;
}

/** Hook that fetches item names and re-renders whenever new names arrive. */
export function useItemNames() {
  const [, bumpVersion] = useState(0);

  useEffect(() => {
    const cb = () => bumpVersion((n) => n + 1);
    itemNamesListeners.add(cb);
    ensureItemNames();
    return () => {
      itemNamesListeners.delete(cb);
    };
  }, []);
}

/** Translate an upgrade string like "Champion 2/6" using the t() function for the track name. */
export function localizedUpgrade(upgrade: string, t: (key: string) => string): string {
  if (!upgrade) return upgrade;
  const match = upgrade.match(/^(\w+)(\s.*)$/);
  if (!match) return upgrade;
  const translated = t(`track.${match[1]}`);
  // If the key wasn't found (returned as-is), keep original
  if (translated === `track.${match[1]}`) return upgrade;
  return translated + match[2];
}

/** Get enchant name in the given locale. Enchants without a backing item
 *  (runes, weapon enchants) are named through their spell instead. */
export function localizedEnchantName(enchant: EnchantInfo, locale: string): string {
  if (!locale || locale === 'en_US') return enchant.name;
  if (enchant.item_id) {
    const name = itemNamesMap[enchant.item_id]?.[locale];
    if (name) return name;
    requestLocalizedName('item', enchant.item_id, locale);
    return enchant.name;
  }
  if (enchant.spell_id) {
    const name = spellNamesMap[enchant.spell_id]?.[locale];
    if (name) return name;
    requestLocalizedName('spell', enchant.spell_id, locale);
  }
  return enchant.name;
}

/** Get gem name in the given locale using the item-names lookup. */
export function localizedGemName(gem: GemInfo, locale: string): string {
  if (!locale || locale === 'en_US') return gem.name;
  const name = itemNamesMap[gem.gem_id]?.[locale];
  if (name) return name;
  requestLocalizedName('item', gem.gem_id, locale);
  return gem.name;
}

const ICON_BASE = 'https://render.worldofwarcraft.com/icons/56';
const FALLBACK_ICON = 'inv_misc_questionmark';

/** Icon name → FileDataID, for icons Blizzard's CDN refuses to serve by name.
 *  Blizzard addresses icons by FileDataID; the name path is a legacy alias that
 *  was never populated for newer art, so those names 403. The backend builds
 *  this map from `icon-file-ids.json` (see `backend/scripts/fetch_icon_file_ids.py`);
 *  it is empty until the fetch resolves and when that file hasn't been generated. */
let iconFileIds: Record<string, number> = {};
let iconFileIdsPromise: Promise<void> | undefined;

/** Load the FileDataID map once per session. A failed fetch degrades to an empty
 *  map, leaving every icon on its name — the pre-existing behaviour. */
function loadIconFileIds(): Promise<void> {
  if (!iconFileIdsPromise) {
    iconFileIdsPromise = fetchJsonOr<Record<string, number>>(apiUrl('/api/icon-file-ids'), {}).then(
      (map) => {
        iconFileIds = map;
      }
    );
  }
  return iconFileIdsPromise;
}

// Warm the map at import so the common case builds a working URL on first
// render. Browser-only: during SSR there is no API base to resolve against.
if (typeof window !== 'undefined') void loadIconFileIds();

function getIconUrl(iconName: string): string {
  const fileDataId = iconFileIds[iconName?.toLowerCase()];
  return `${ICON_BASE}/${fileDataId ?? iconName}.jpg`;
}

/** `onError` for icon images. Icons that raced the map load retry once via
 *  FileDataID, then settle on the questionmark rather than a broken-image glyph.
 *  Requires `data-icon={iconName}` on the element to know what to retry —
 *  `iconProps` wires that up for you.
 *
 *  Handles both `<img>` and SVG `<image>`, which carry their URL on different
 *  attributes (TalentTree renders icons inside an SVG). */
type IconEl = HTMLImageElement | SVGImageElement;

const iconSrc = (el: IconEl): string =>
  el instanceof SVGImageElement ? (el.getAttribute('href') ?? '') : el.src;

function setIconSrc(el: IconEl, url: string): void {
  if (el instanceof SVGImageElement) el.setAttribute('href', url);
  else el.src = url;
}

function onIconError(e: SyntheticEvent<IconEl>): void {
  const el = e.currentTarget;
  const iconName = el.dataset.icon?.toLowerCase() ?? '';
  const fallbackUrl = getIconUrl(FALLBACK_ICON);
  // Key the guard to the icon name, not the element: React reuses the same
  // <img> node when a gear slot's item changes, and a plain "already retried"
  // flag would cost every later icon in that slot its retry for the session.
  const stage = el.dataset.iconRetryFor === iconName ? el.dataset.iconRetryStage : undefined;
  if (stage === 'settled') return; // the questionmark itself failed — nothing left
  el.dataset.iconRetryFor = iconName;

  const settle = () => {
    el.dataset.iconRetryStage = 'fallback';
    setIconSrc(el, fallbackUrl);
  };
  if (stage === 'fallback') {
    // Either the questionmark we applied has now failed, or React re-rendered
    // this element back to a URL for the same icon that still fails (slot A → B
    // → A). Tell them apart by what is actually on the element, so the second
    // case still gets a questionmark instead of a broken-image glyph.
    if (iconSrc(el) === fallbackUrl) el.dataset.iconRetryStage = 'settled';
    else settle();
    return;
  }
  if (stage === 'retried') {
    settle(); // the FileDataID URL failed too
    return;
  }
  el.dataset.iconRetryStage = 'retried';
  void loadIconFileIds().then(() => {
    // The element may have been reused for a different icon while the map was
    // in flight; writing now would clobber an image that loaded perfectly well.
    if ((el.dataset.icon?.toLowerCase() ?? '') !== iconName) return;
    const mapped = iconName ? iconFileIds[iconName] : undefined;
    if (!mapped) {
      settle();
      return;
    }
    // The map may already have been applied at render time, in which case the
    // retry URL is the one that just failed; go straight to the questionmark.
    const next = getIconUrl(iconName);
    if (next === iconSrc(el)) settle();
    else setIconSrc(el, next);
  });
}

/** Everything an icon `<img>` needs: URL, the name the retry reads back, and the
 *  retry handler. Spread it — `<img {...iconProps(item.icon)} alt="" />` — so a
 *  new icon site can't half-adopt the mechanism and silently lose its retry. */
export function iconProps(iconName: string | undefined | null) {
  const name = iconName || FALLBACK_ICON;
  return { src: getIconUrl(name), 'data-icon': name, onError: onIconError };
}

/** `iconProps` for SVG `<image>`, which uses `href` rather than `src`. */
export function iconHrefProps(iconName: string | undefined | null) {
  const name = iconName || FALLBACK_ICON;
  return { href: getIconUrl(name), 'data-icon': name, onError: onIconError };
}

const WOWHEAD_DOMAINS: Record<string, string> = {
  en_US: 'www.wowhead.com',
  de_DE: 'de.wowhead.com',
  es_ES: 'es.wowhead.com',
  fr_FR: 'fr.wowhead.com',
  it_IT: 'it.wowhead.com',
  pt_BR: 'pt.wowhead.com',
  ru_RU: 'ru.wowhead.com',
  zh_CN: 'cn.wowhead.com',
};

/** Wowhead host for a locale (e.g. `cn.wowhead.com`); falls back to the English site. */
export function wowheadHost(locale?: string): string {
  return (locale && WOWHEAD_DOMAINS[locale]) || 'www.wowhead.com';
}

export function getWowheadUrl(itemId: number, locale?: string): string {
  return `https://${wowheadHost(locale)}/item=${itemId}`;
}

/** Normalize the two gem-id shapes (legacy `gem_id`, full `gem_ids` array) into one
 *  filtered list. Use whenever rendering or querying Wowhead with a slot's gems. */
export function toGemIdList(opts: { gem_id?: number; gem_ids?: number[] }): number[] {
  const raw = opts.gem_ids?.length ? opts.gem_ids : opts.gem_id ? [opts.gem_id] : [];
  return raw.filter((g) => g > 0);
}

export interface WowheadItem {
  bonus_ids?: number[];
  ilevel?: number;
  enchant_id?: number;
  gem_id?: number;
  gem_ids?: number[];
  crafted_stats?: number[];
  /** Catalysed pieces keep the source item's secondaries; `original-item` is
   *  Wowhead's equivalent of simc's `redirected_base_stats`. Only set on a
   *  catalyst variant — `source_item_id` means something else on Void Forged rows. */
  is_catalyst?: boolean;
  source_item_id?: number;
  /** Embellishment applied by the sim; its bonus ids merge into `bonus=`. */
  embellishment?: { bonus_ids?: number[] };
}

/** Wowhead tooltip params for an item. The single builder for these — adding a
 *  new param here reaches every tooltip in the app. */
export function getWowheadData(item: WowheadItem): string {
  const parts: string[] = [];
  const gemIds = toGemIdList(item);
  const bonusIds = [...(item.bonus_ids ?? []), ...(item.embellishment?.bonus_ids ?? [])];
  if (bonusIds.length) parts.push(`bonus=${bonusIds.join(':')}`);
  if (item.crafted_stats?.length) parts.push(`crafted-stats=${item.crafted_stats.join(':')}`);
  if (item.is_catalyst && item.source_item_id) {
    parts.push(`original-item=${item.source_item_id}`);
  }
  if (item.ilevel && item.ilevel > 0) parts.push(`ilvl=${item.ilevel}`);
  if (item.enchant_id && item.enchant_id > 0) parts.push(`ench=${item.enchant_id}`);
  if (gemIds.length > 0) parts.push(`gems=${gemIds.join(':')}`);
  return parts.join('&');
}
