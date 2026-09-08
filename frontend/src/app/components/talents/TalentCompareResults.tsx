'use client';
/* eslint-disable @next/next/no-img-element */

import { useMemo, useState } from 'react';
import { useLanguage } from '../../lib/i18n';
import { localizedSpecName, useLocalizedNames } from '../../lib/localizedNames';
import { decodeHeader } from '../../lib/talentDecode';
import { diffTalentStrings, type TalentDiffEntry } from '../../lib/talentDiff';
import { useTalentTree } from '../../lib/useTalentTree';
import { loadoutDisplayName } from '../../lib/types';
import { iconProps, localizedSpellName, useItemNames, wowheadHost } from '../../lib/useItemInfo';
import type { TopGearResult } from '../gear/topGearResultsTypes';

interface TalentCompareResultsProps {
  baseDps: number;
  results: TopGearResult[];
}

/** The talent export string the handler stamped onto this row's combo metadata. */
function rowTalentString(row: TopGearResult): string {
  return row.items?.find((it) => it.talent_string)?.talent_string ?? '';
}

function specIdOf(talentString: string): number | null {
  if (!talentString) return null;
  try {
    return decodeHeader(talentString).specId;
  } catch {
    return null;
  }
}

/** Same tone scale as the Top Gear rankings dot: greener = tighter CI. */
function precisionDotTone(pct: number): string {
  if (pct <= 0.5) return 'bg-emerald-400';
  if (pct <= 1.0) return 'bg-emerald-500';
  if (pct <= 2.0) return 'bg-yellow-400';
  if (pct <= 4.0) return 'bg-orange-400';
  return 'bg-red-500';
}

function CopyTalentButton({ talentString }: { talentString: string }) {
  const { t } = useLanguage();
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(talentString).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title={t('talentCompare.copyString')}
      className={`rounded border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
        copied
          ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
          : 'border-outline-variant/20 bg-surface-container-high/60 text-on-surface-variant hover:bg-gold/10 hover:text-gold'
      }`}
    >
      {copied ? t('talentCompare.copied') : t('talentCompare.copyString')}
    </button>
  );
}

function DiffColumn({ title, entries }: { title: string; entries: TalentDiffEntry[] }) {
  const { locale } = useLanguage();
  useItemNames();
  // `wowheadHost` maps the locale to a real Wowhead domain; splitting the locale
  // ourselves produced dead hosts for the ones that don't match (zh_CN -> zh).
  const host = wowheadHost(locale);

  if (entries.length === 0) return null;

  return (
    <div>
      <p className="mb-1.5 text-[12px] font-medium uppercase tracking-wider text-muted">
        {title} ({entries.length})
      </p>
      <ul className="space-y-1">
        {entries.map((e) => {
          const name = localizedSpellName(e.spellId ?? 0, e.name, locale);
          return (
            <li key={e.nodeId} className="flex items-center gap-2">
              <img {...iconProps(e.icon)} alt="" className="h-5 w-5 shrink-0 rounded" />
              {e.spellId ? (
                <a
                  href={`https://${host}/spell=${e.spellId}`}
                  data-wowhead={`spell=${e.spellId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate text-[13px] text-on-surface-variant hover:text-gold"
                >
                  {name}
                </a>
              ) : (
                <span className="truncate text-[13px] text-on-surface-variant">{name}</span>
              )}
              {e.from && e.to && (
                <span className="shrink-0 text-[11px] tabular-nums text-on-surface-variant/50">
                  {e.from} → {e.to}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function TalentCompareResults({ baseDps, results }: TalentCompareResultsProps) {
  const { t, locale } = useLanguage();
  useLocalizedNames();

  // Baseline first (the row the backend named "Currently Equipped (<build>)"),
  // then the remaining rows in the DPS order the parser already sorted them into.
  const rows = useMemo(() => {
    const baselineIdx = results.findIndex((r) => r.name.startsWith('Currently Equipped'));
    if (baselineIdx < 0) return results;
    return [results[baselineIdx], ...results.filter((_, i) => i !== baselineIdx)];
  }, [results]);

  const baseline = rows[0];
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = rows.find((r) => r.name === selectedName) ?? rows[1] ?? null;

  const baselineString = baseline ? rowTalentString(baseline) : '';
  const selectedString = selected ? rowTalentString(selected) : '';
  const baselineSpecId = specIdOf(baselineString);
  const selectedSpecId = specIdOf(selectedString);

  const tree = useTalentTree(baselineSpecId);
  const crossSpec =
    baselineSpecId != null && selectedSpecId != null && baselineSpecId !== selectedSpecId;
  const diff = useMemo(
    () => (tree && !crossSpec ? diffTalentStrings(baselineString, selectedString, tree) : null),
    [tree, crossSpec, baselineString, selectedString]
  );
  const diffIsEmpty =
    diff != null && diff.added.length + diff.removed.length + diff.changed.length === 0;

  if (rows.length === 0) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Ranked builds */}
      <div className="card overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-outline-variant/10 text-[11px] uppercase tracking-wider text-muted">
              <th className="px-4 py-2 font-medium">{t('talentCompare.build')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('talentCompare.dps')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('talentCompare.delta')}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isSelected = selected?.name === row.name;
              const isBaseline = row === baseline;
              const deltaPct = baseDps > 0 ? (row.delta / baseDps) * 100 : 0;
              const talentString = rowTalentString(row);
              return (
                <tr
                  key={row.name}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedName(row.name)}
                  onKeyDown={(event) => {
                    // Only the row itself: the copy button inside it handles its
                    // own Enter/Space.
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setSelectedName(row.name);
                  }}
                  className={`cursor-pointer border-b border-outline-variant/5 transition-colors last:border-0 ${
                    isSelected ? 'bg-gold/[0.06]' : 'hover:bg-surface-container-high/50'
                  }`}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {row.precision_pct != null && (
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${precisionDotTone(row.precision_pct)}`}
                          title={t('gear.precisionAccuracy', {
                            pct: row.precision_pct.toFixed(2),
                          })}
                        />
                      )}
                      <span className="truncate text-[14px] font-medium text-on-surface">
                        {loadoutDisplayName(row.talent_build || row.name, t)}
                      </span>
                      {row.talent_spec && (
                        <span className="shrink-0 rounded bg-primary-container/20 px-1.5 py-px text-[10px] font-bold uppercase tracking-widest text-primary">
                          {localizedSpecName(row.talent_spec, locale)}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right font-headline text-[15px] font-bold tabular-nums text-on-surface">
                    {Math.round(row.dps).toLocaleString()}
                  </td>
                  <td
                    className={`px-4 py-2.5 text-right text-[13px] tabular-nums ${
                      isBaseline
                        ? 'text-on-surface-variant/40'
                        : row.delta >= 0
                          ? 'text-emerald-400'
                          : 'text-red-400'
                    }`}
                  >
                    {isBaseline
                      ? '—'
                      : `${row.delta >= 0 ? '+' : ''}${Math.round(row.delta).toLocaleString()} (${
                          deltaPct >= 0 ? '+' : ''
                        }${deltaPct.toFixed(2)}%)`}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {talentString && <CopyTalentButton talentString={talentString} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Talent diff vs the baseline build */}
      <div className="card space-y-3 p-4">
        <p className="text-[12px] font-medium uppercase tracking-wider text-muted">
          {t('talentCompare.diffTitle', {
            name: loadoutDisplayName(baseline?.talent_build || baseline?.name || '', t),
          })}
        </p>
        {crossSpec ? (
          <p className="text-[13px] text-on-surface-variant">{t('talentCompare.crossSpec')}</p>
        ) : diff == null ? (
          // No diff has two causes: nothing to decode, or the tree is still on
          // its way. Only the first is the user's problem.
          baselineSpecId == null ? (
            <p className="text-[13px] text-on-surface-variant">
              {t('talentCompare.noTalentString')}
            </p>
          ) : (
            <p className="text-[13px] text-on-surface-variant">{t('common.loading')}</p>
          )
        ) : diffIsEmpty ? (
          <p className="text-[13px] text-on-surface-variant">{t('talentCompare.noDiff')}</p>
        ) : (
          <>
            <DiffColumn title={t('talentCompare.added')} entries={diff.added} />
            <DiffColumn title={t('talentCompare.removed')} entries={diff.removed} />
            <DiffColumn title={t('talentCompare.changed')} entries={diff.changed} />
          </>
        )}
      </div>
    </div>
  );
}
