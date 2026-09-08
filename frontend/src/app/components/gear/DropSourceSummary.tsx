'use client';

import { useState, type KeyboardEvent } from 'react';
import { useLanguage } from '../../lib/i18n';
import {
  localizedEncounterName,
  localizedInstanceName,
  useLocalizedNames,
} from '../../lib/localizedNames';
import { localizedItemName, useItemNames } from '../../lib/useItemInfo';
import type { DropInstanceEntry, DropSourceEntry, DropSourceSummary } from './topGearResultsTypes';

type View = 'sources' | 'instances';

/** "Where to go next": the Raidbots-style ranked loot sources of a Drop Finder
 *  run. Expected value, best drop and the chance a successful roll is an
 *  upgrade all come from the backend; this only lays them out. */
export default function DropSourceSummaryTable({
  summary,
  baseDps,
  onSelectSource,
}: {
  summary: DropSourceSummary;
  baseDps: number;
  onSelectSource?: () => void;
}) {
  const { t, locale } = useLanguage();
  useLocalizedNames();
  useItemNames();
  const [view, setView] = useState<View>('sources');

  const hasInstances = summary.instances.length > 0;
  const rows: (DropSourceEntry | DropInstanceEntry)[] =
    view === 'instances' && hasInstances ? summary.instances : summary.sources;
  if (rows.length === 0) return null;

  const maxExpected = Math.max(...rows.map((row) => row.expected), 0);
  const pct = (value: number) => (baseDps > 0 ? (value / baseDps) * 100 : 0);

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-widest text-muted">
          {t('dropFinder.summaryTitle')}
        </p>
        {hasInstances && (
          <div className="flex gap-1">
            {(
              [
                ['sources', t('gear.byBoss')],
                ['instances', t('loot.byInstance')],
              ] as [View, string][]
            ).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setView(mode)}
                className={`rounded px-2.5 py-1 text-[13px] font-medium transition-all ${
                  view === mode
                    ? 'bg-white text-black'
                    : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mb-2 grid grid-cols-[2rem_minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.6fr)_5rem] gap-3 px-3 text-[11px] uppercase tracking-wider text-on-surface-variant/50">
        <span>{t('dropFinder.summaryPriority')}</span>
        <span>{t('dropFinder.summarySource')}</span>
        <span>{t('dropFinder.summaryExpected')}</span>
        <span>{t('dropFinder.summaryBest')}</span>
        <span className="text-right">{t('dropFinder.summaryChance')}</span>
      </div>

      <div className="space-y-1">
        {rows.map((row) => {
          const isSource = 'encounter' in row;
          // `key` is the encounter id when the backend knew one, else the boss
          // name — only an all-digits key is an id.
          const encounterId = isSource && /^\d+$/.test(row.key) ? Number(row.key) : undefined;
          const label = isSource
            ? localizedEncounterName(encounterId, row.encounter, locale, row.instance_id)
            : localizedInstanceName(row.instance_id, row.instance_name, locale);
          const sub = isSource
            ? localizedInstanceName(row.instance_id, row.instance_name, locale)
            : '';
          const bestItem = isSource ? row.best_item : null;
          // The row click regroups the result table by boss, which only makes
          // sense from the boss view — the instance rows stay non-interactive.
          const onRowClick = isSource ? onSelectSource : undefined;
          return (
            // A row wraps block-level content, so it cannot be a <button>.
            // Interactive rows get the button role and keyboard handling; the
            // inert instance rows stay out of the tab order entirely.
            <div
              key={isSource ? row.key : row.instance_name}
              {...(onRowClick
                ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    onClick: onRowClick,
                    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      onRowClick();
                    },
                  }
                : {})}
              className={`relative block w-full overflow-hidden rounded-lg text-left transition-colors ${
                onRowClick ? 'cursor-pointer hover:bg-white/[0.04]' : 'cursor-default'
              }`}
            >
              <div
                className="absolute inset-y-0 left-0 bg-white/[0.02]"
                style={{ width: `${maxExpected > 0 ? (row.expected / maxExpected) * 100 : 0}%` }}
              />
              <div className="relative grid grid-cols-[2rem_minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.6fr)_5rem] items-center gap-3 px-3 py-2">
                <span className="font-mono text-[12px] tabular-nums text-on-surface-variant/50">
                  {row.priority}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-on-surface">{label}</p>
                  <p className="truncate font-mono text-[11px] text-muted">
                    {sub ? `${sub} · ` : ''}
                    {t('dropFinder.summaryItems', { count: row.items })}
                  </p>
                </div>
                <div className="min-w-0">
                  <span
                    className={`font-mono text-[13px] font-bold tabular-nums ${
                      row.expected > 0 ? 'text-emerald-400' : 'text-muted'
                    }`}
                  >
                    {row.expected > 0 ? `+${Math.round(row.expected).toLocaleString()}` : '--'}
                  </span>
                  {row.expected > 0 && (
                    <span className="ml-1.5 font-mono text-[11px] text-muted">
                      {pct(row.expected).toFixed(2)}%
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  {bestItem && row.best > 0 ? (
                    <>
                      <p className="truncate text-[12px] text-on-surface-variant">
                        {localizedItemName(bestItem.item_id, bestItem.name, locale)}
                      </p>
                      <span className="font-mono text-[11px] font-bold tabular-nums text-emerald-400">
                        +{Math.round(row.best).toLocaleString()}
                      </span>
                    </>
                  ) : (
                    <span
                      className={`font-mono text-[13px] font-bold tabular-nums ${
                        row.best > 0 ? 'text-emerald-400' : 'text-muted'
                      }`}
                    >
                      {row.best > 0 ? `+${Math.round(row.best).toLocaleString()}` : '--'}
                    </span>
                  )}
                </div>
                <span className="text-right font-mono text-[13px] tabular-nums text-on-surface-variant">
                  {Math.round(row.upgrade_chance * 100)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-muted">{t('dropFinder.summaryHint')}</p>
    </div>
  );
}
