'use client';

import { useRouter } from 'next/navigation';
import { memo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { simRow } from '../../lib/api';
import { SLOT_LABELS, specDisplayName } from '../../lib/types';
import {
  QUALITY_COLORS,
  getWowheadData,
  getWowheadUrl,
  localizedEnchantName,
  localizedGemName,
  localizedItemName,
  useItemNames,
  iconProps,
} from '../../lib/useItemInfo';
import type { EnchantInfo, GemInfo, ItemInfo } from '../../lib/useItemInfo';
import { useLanguage } from '../../lib/i18n';
import type { ResultItem, TopGearResult } from './topGearResultsTypes';
import { appliedGems, gemBadgeClass } from './topGearResultsUtils';

/** Numeric combo id from a "Combo N" name; null for other shapes (e.g. "Currently Equipped"). */
function comboIdFromName(name: string): number | null {
  const match = name.match(/^Combo (\d+)$/);
  return match ? Number(match[1]) : null;
}

/** Dot tone for precision (95% CI half-width as % of mean = how trustworthy the DPS is,
 * not what was targeted). Greener = tighter: ≤0.5 green, ≤1 emerald, ≤2 yellow, ≤4 orange, else red. */
function precisionDotTone(pct: number): string {
  if (pct <= 0.5) return 'bg-emerald-400';
  if (pct <= 1.0) return 'bg-emerald-500';
  if (pct <= 2.0) return 'bg-yellow-400';
  if (pct <= 4.0) return 'bg-orange-400';
  return 'bg-red-500';
}

/** Short band name shown as the precision tooltip header (mirrors the dot tone). */
function precisionBandLabel(
  pct: number,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  if (pct <= 0.5) return t('gear.precisionFinal');
  if (pct <= 1.0) return t('gear.precisionRefine');
  if (pct <= 2.0) return t('gear.precisionCoarse');
  if (pct <= 4.0) return t('gear.precisionProbe');
  return t('gear.precisionPrune');
}

/** Precision dot with hover card. Card is portal-rendered at a fixed position so it escapes
 * the row's `overflow-hidden` (DPS bar clip); a plain CSS popover would be cropped at the edge. */
function PrecisionDot({ pct, targetError }: { pct: number; targetError?: number }) {
  const { t } = useLanguage();
  const ref = useRef<HTMLSpanElement>(null);
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setTip({ top: r.top, left: r.right });
  };

  return (
    <span
      ref={ref}
      onMouseEnter={show}
      onMouseLeave={() => setTip(null)}
      className="flex items-center"
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${precisionDotTone(pct)}`}
        aria-label={t('gear.precisionAccuracy', { pct: pct.toFixed(2) })}
      />
      {tip &&
        createPortal(
          <div
            role="tooltip"
            style={{ position: 'fixed', top: tip.top - 8, left: tip.left }}
            className="pointer-events-none z-[60] -translate-x-full -translate-y-full rounded-lg border border-outline-variant/20 bg-surface-container-highest px-3 py-2 shadow-xl"
          >
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${precisionDotTone(pct)}`} />
              <span className="whitespace-nowrap text-[11px] font-semibold text-on-surface">
                {precisionBandLabel(pct, t)}
              </span>
            </div>
            <div className="mt-1 whitespace-nowrap font-mono text-[11px] tabular-nums leading-tight text-on-surface-variant">
              ±{pct.toFixed(2)}% <span className="text-on-surface-variant/50">· 95% CI</span>
            </div>
            {targetError != null && (
              <div className="whitespace-nowrap font-mono text-[11px] tabular-nums leading-tight text-on-surface-variant/60">
                target {targetError.toFixed(2)}%
              </div>
            )}
          </div>,
          document.body
        )}
    </span>
  );
}

/** One simmed combination: what it changes, what it is worth, and the controls to
 *  compare or re-sim it. Shared by the ranked list and the per-source panels in the
 *  encounter summary, so a row reads the same wherever it is shown. */
export const ResultRow = memo(function ResultRow({
  result,
  rank,
  maxDps,
  baseDps,
  targetError,
  isBest,
  isSelected,
  onSelect,
  isCompareTarget,
  onCompare,
  itemInfoMap,
  enchantInfoMap,
  gemInfoMap,
  sourceJobId,
}: {
  result: TopGearResult;
  rank?: number;
  maxDps: number;
  baseDps: number;
  targetError?: number;
  isBest: boolean;
  isSelected?: boolean;
  onSelect?: (name: string) => void;
  isCompareTarget?: boolean;
  onCompare?: (name: string) => void;
  itemInfoMap: Record<number, ItemInfo>;
  enchantInfoMap: Record<number, EnchantInfo>;
  gemInfoMap: Record<number, GemInfo>;
  /** When present, "Combo N" rows show a "Sim" button re-running the combo as a Quick Sim. */
  sourceJobId?: string;
}) {
  const { t } = useLanguage();
  const router = useRouter();
  const [verifying, setVerifying] = useState(false);
  const barWidth = maxDps > 0 ? (result.dps / maxDps) * 100 : 0;
  const comboId = comboIdFromName(result.name);
  const showVerifyButton = !!sourceJobId && comboId !== null;

  const changedItems = result.items.filter(
    (item) => !item.is_kept && item.item_id > 0 && !item.type
  );
  const enchantGemItems = result.items.filter(
    (item) => item.type === 'enchant' || item.type === 'gem'
  );
  const isEquipped =
    (result.items.length === 0 || result.name.startsWith('Currently Equipped')) &&
    enchantGemItems.length === 0;
  const hasTalentBuild = !!result.talent_build;
  const hasFolioBuild = !!result.folio_build;
  const changedSlots = new Set(changedItems.map((item) => item.slot));
  const showBothRings = changedSlots.has('finger1') || changedSlots.has('finger2');
  const showBothTrinkets = changedSlots.has('trinket1') || changedSlots.has('trinket2');

  const talentBadge = (
    <>
      {hasTalentBuild && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded bg-purple-500/10 px-1.5 py-px text-[11px] font-medium">
          {result.talent_spec && (
            <span className="text-purple-300">{specDisplayName(result.talent_spec)}</span>
          )}
          <span className="text-purple-400/70">{result.talent_build}</span>
        </span>
      )}
      {hasFolioBuild && (
        <span className="inline-flex shrink-0 items-center rounded bg-sky-500/10 px-1.5 py-px text-[11px] font-medium text-sky-300/80">
          {result.folio_build}
        </span>
      )}
    </>
  );

  const displayItems = result.items.filter((item) => {
    if (item.type) return false;
    if (!item.is_kept) return item.item_id > 0;
    if (showBothRings && (item.slot === 'finger1' || item.slot === 'finger2')) return true;
    if (showBothTrinkets && (item.slot === 'trinket1' || item.slot === 'trinket2')) return true;
    return false;
  });

  return (
    <div
      onClick={() => onSelect?.(result.name)}
      className={`relative cursor-pointer overflow-hidden rounded-lg transition-colors [contain-intrinsic-size:auto_37px] [content-visibility:auto] hover:bg-white/[0.04] ${
        isSelected && !isBest
          ? 'bg-emerald-500/[0.04] ring-1 ring-emerald-500/50'
          : isBest
            ? `ring-1 ring-gold/30 ${isSelected ? 'bg-gold/[0.05]' : 'bg-transparent'}`
            : isCompareTarget
              ? 'bg-sky-500/[0.04] ring-1 ring-sky-500/50'
              : isEquipped
                ? 'ring-1 ring-white/5'
                : ''
      }`}
    >
      <div
        className="absolute inset-y-0 left-0 bg-white/[0.02]"
        style={{ width: `${barWidth}%` }}
      />
      <div className="relative flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {rank != null && (
            <span className="w-5 shrink-0 text-right font-mono text-[12px] tabular-nums text-on-surface-variant/50">
              {rank}
            </span>
          )}

          {(() => {
            const hasChangedItems = changedItems.length > 0 || enchantGemItems.length > 0;

            if (isEquipped) {
              return (
                <div className="flex items-center gap-2">
                  <span className="text-[14px] text-muted">{t('gear.currentlyEquipped')}</span>
                  {talentBadge}
                </div>
              );
            }

            if (!hasChangedItems && (hasTalentBuild || hasFolioBuild)) {
              return talentBadge;
            }

            return (
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                {displayItems.map((item, index) => (
                  <ItemTag
                    key={index}
                    item={item}
                    info={item.item_id > 0 ? itemInfoMap[item.item_id] : undefined}
                    enchant={item.enchant_id ? enchantInfoMap[item.enchant_id] : undefined}
                    sourceInfo={item.source_item_id ? itemInfoMap[item.source_item_id] : undefined}
                    gems={appliedGems(item, gemInfoMap)}
                  />
                ))}
                {enchantGemItems.map((item, index) => (
                  <span
                    key={`eg-${index}`}
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[13px] font-medium ${
                      item.type === 'enchant'
                        ? 'bg-emerald-500/10 text-emerald-300'
                        : gemBadgeClass(item.name)
                    }`}
                  >
                    {item.name || (item.type === 'gem' ? 'Gem' : 'Enchant')}
                  </span>
                ))}
                {talentBadge}
              </div>
            );
          })()}

          {isBest && (
            <span className="shrink-0 rounded bg-gold/10 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-gold">
              {t('gear.best')}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
          <span
            className={`flex items-center gap-1.5 font-headline font-mono text-[15px] tabular-nums ${
              result.delta > 0
                ? 'text-emerald-400'
                : result.delta < 0
                  ? 'text-red-400'
                  : 'text-muted'
            }`}
          >
            <span>
              {result.delta > 0
                ? `+${Math.round(result.delta).toLocaleString()}`
                : result.delta < 0
                  ? Math.round(result.delta).toLocaleString()
                  : '--'}
            </span>
            {result.delta !== 0 && baseDps > 0 && (
              <span className="text-xs opacity-70">
                ({result.delta > 0 ? '+' : ''}
                {((result.delta / baseDps) * 100).toFixed(1)}%)
              </span>
            )}
          </span>
          <span className="flex w-20 items-center justify-end gap-1.5">
            <span className="font-mono text-sm tabular-nums text-on-surface">
              {Math.round(result.dps).toLocaleString()}
            </span>
            {result.precision_pct != null && (
              <PrecisionDot pct={result.precision_pct} targetError={targetError} />
            )}
          </span>
          {onCompare && !isEquipped && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCompare(result.name);
              }}
              title={t('gear.compareRowTitle')}
              className={`rounded border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
                isCompareTarget
                  ? 'border-sky-500/40 bg-sky-500/15 text-sky-300'
                  : 'border-outline-variant/20 bg-surface-container-high/60 text-on-surface-variant hover:bg-sky-500/10 hover:text-sky-300'
              }`}
            >
              {t('gear.compareVs')}
            </button>
          )}
          {showVerifyButton && (
            <button
              onClick={async (e) => {
                e.stopPropagation();
                if (!sourceJobId || comboId == null || verifying) return;
                setVerifying(true);
                try {
                  const newId = await simRow(sourceJobId, comboId);
                  router.push(`/sim/${newId}`);
                } catch {
                  setVerifying(false);
                }
              }}
              disabled={verifying}
              title={t('gear.verifyRowTitle')}
              className="rounded border border-outline-variant/20 bg-surface-container-high/60 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-on-surface-variant transition-colors hover:bg-primary-container/30 hover:text-primary disabled:opacity-50"
            >
              {verifying ? '…' : 'Sim'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

function ItemTag({
  item,
  info,
  enchant,
  sourceInfo,
  gems,
}: {
  item: ResultItem;
  info?: ItemInfo;
  enchant?: EnchantInfo;
  /** The drop a catalyst row converts, so the CAT pill can name where it came from. */
  sourceInfo?: ItemInfo;
  /** Gems the drop is simmed with, one per socket. */
  gems?: GemInfo[];
}) {
  const { t, locale } = useLanguage();
  useItemNames();

  const qualityColor = info ? QUALITY_COLORS[info.quality] || '#fff' : '#fff';
  const name = localizedItemName(
    item.item_id,
    info?.name || item.name || `Item ${item.item_id}`,
    locale
  );
  const icon = info?.icon || 'inv_misc_questionmark';
  const wowheadData = item.item_id > 0 ? getWowheadData(item) : undefined;
  const slotName = SLOT_LABELS[item.slot] || item.slot;
  // A Void Forged row points `source_item_id` at itself, so only a catalyst has
  // an origin worth naming.
  const sourceName =
    item.is_catalyst && item.source_item_id
      ? localizedItemName(item.source_item_id, sourceInfo?.name || '', locale)
      : '';

  return (
    <div
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${
        item.is_kept ? 'opacity-40' : 'bg-white/[0.04]'
      }`}
    >
      <a
        href={item.item_id > 0 ? getWowheadUrl(item.item_id, locale) : undefined}
        data-wowhead={wowheadData}
        className="block h-4 w-4 shrink-0 overflow-hidden rounded-sm"
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.preventDefault()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          {...iconProps(icon)}
          alt=""
          width={16}
          height={16}
          className="h-full w-full"
          loading="lazy"
        />
      </a>
      <a
        href={item.item_id > 0 ? getWowheadUrl(item.item_id, locale) : undefined}
        data-wowhead={wowheadData}
        className="max-w-[240px] truncate text-[13px] font-medium no-underline"
        style={{ color: qualityColor }}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
        }}
      >
        {name}
      </a>
      <span className="text-[11px] text-muted">({slotName})</span>
      {item.is_void_forge && (
        <span className="shrink-0 rounded bg-purple-500/15 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-purple-300">
          {t('loot.voidforged')}
        </span>
      )}
      {item.is_catalyst && (
        <span
          title={sourceName ? t('gear.catalystFrom', { name: sourceName }) : undefined}
          className="inline-flex shrink-0 items-center gap-1 rounded bg-sky-500/15 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-sky-300"
        >
          {t('loot.catalyst')}
          {sourceName && (
            <span className="max-w-[170px] truncate font-medium normal-case tracking-normal text-sky-300/70">
              {sourceName}
            </span>
          )}
        </span>
      )}
      {gems?.map((gem, index) => (
        <span
          key={`${gem.gem_id}-${index}`}
          title={localizedGemName(gem, locale)}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-sm ring-1 ring-white/15"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            {...iconProps(gem.icon)}
            alt=""
            width={16}
            height={16}
            className="h-full w-full"
            loading="lazy"
          />
        </span>
      ))}
      {item.upgrade_levels ? (
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
          +{item.upgrade_levels}
        </span>
      ) : item.origin === 'vault' ? (
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-amber-400">
          V
        </span>
      ) : item.origin === 'loot' ? (
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-sky-400">
          L
        </span>
      ) : null}
      {enchant?.name && (
        <span
          className="max-w-[140px] truncate text-[11px] text-emerald-400/70"
          title={localizedEnchantName(enchant, locale)}
        >
          {localizedEnchantName(enchant, locale)}
        </span>
      )}
      {item.embellishment && (
        <span
          className="max-w-[140px] truncate text-[11px] text-purple-400/80"
          title={item.embellishment.name}
        >
          {item.embellishment.name}
        </span>
      )}
    </div>
  );
}
