import { useCallback, useMemo, useRef, useState } from 'react';
import { useLanguage } from '../../lib/i18n';
import { usePopupDismissal } from './usePopupDismissal';
import type { PoolSource } from './lootSources';

interface SourceFilterProps {
  sources: PoolSource[];
  excludedSources: Set<string>;
  toggleSource: (keys: string[]) => void;
}

/** Which bosses a bonus roll run covers. Switching one off takes its drops out
 *  of the table and out of the sim — the point being a shorter run when you
 *  already know a boss has nothing for you. */
export default function SourceFilter({
  sources,
  excludedSources,
  toggleSource,
}: SourceFilterProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDetailsElement | null>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const close = useCallback(() => setOpen(false), []);
  usePopupDismissal(open, close, containerRef, undefined, triggerRef);

  const bossCount = useMemo(
    () => sources.reduce((total, source) => total + source.bosses.length, 0),
    [sources]
  );
  const hiddenCount = useMemo(
    () =>
      sources.reduce(
        (total, source) =>
          total + source.bosses.filter((boss) => excludedSources.has(boss.key)).length,
        0
      ),
    [sources, excludedSources]
  );
  const activeCount = bossCount - hiddenCount;
  const summary =
    hiddenCount === 0
      ? t('dropFinder.allBosses')
      : activeCount === 0
        ? t('dropFinder.noBosses')
        : t('dropFinder.bossesMany', { activeCount });

  if (bossCount <= 1) return null;
  const narrowed = hiddenCount > 0;
  return (
    <details
      ref={containerRef}
      className="relative"
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary
        ref={triggerRef}
        aria-expanded={open}
        className={`flex cursor-pointer list-none items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-150 [&::-webkit-details-marker]:hidden ${
          open || narrowed
            ? 'border-gold/40 bg-gold/[0.08] text-gold'
            : 'border-transparent bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface'
        }`}
      >
        <span className="font-semibold">{t('dropFinder.bosses')}</span>
        <span className={open || narrowed ? 'text-gold/90' : ''}>{summary}</span>
        {narrowed && (
          <span className="rounded-full border border-gold/20 bg-black/10 px-1.5 py-0.5 text-[10px] font-bold text-gold">
            {t('dropFinder.hiddenCount', { count: hiddenCount })}
          </span>
        )}
        <svg
          className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 4.5L6 8l3.5-3.5" />
        </svg>
      </summary>
      <div className="absolute right-0 top-full z-20 mt-2 max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-outline-variant/15 bg-surface-container p-3 shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-outline-variant/10 pb-2">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-on-surface-variant/60">
              {t('dropFinder.sourceFilter')}
            </p>
            <p className="mt-1 text-xs text-on-surface-variant">
              {t('dropFinder.sourceFilterDesc')}
            </p>
          </div>
          {narrowed && (
            <button
              type="button"
              onClick={() =>
                toggleSource(
                  sources.flatMap((source) =>
                    source.bosses
                      .filter((boss) => excludedSources.has(boss.key))
                      .map((boss) => boss.key)
                  )
                )
              }
              className="rounded-lg border border-outline-variant/20 bg-surface-container-high px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-on-surface-variant transition-colors hover:border-outline-variant/35 hover:text-on-surface"
            >
              {t('common.reset')}
            </button>
          )}
        </div>
        <div className="mt-3 space-y-3">
          {sources.map((source) => {
            const keys = source.bosses.map((boss) => boss.key);
            const offCount = keys.filter((key) => excludedSources.has(key)).length;
            const allOff = offCount === keys.length;
            // A dungeon's drops are listed against the dungeon itself, so its one
            // "boss" repeats the header. Show the header alone rather than the
            // same name twice.
            const selfTitled = source.bosses.length === 1 && source.bosses[0].name === source.name;
            return (
              <div key={source.key}>
                <button
                  type="button"
                  onClick={() => toggleSource(keys)}
                  aria-pressed={!allOff}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-bold uppercase tracking-[0.14em] transition-colors ${
                    allOff
                      ? 'bg-surface-container-high text-on-surface-variant/45 hover:text-on-surface-variant/70'
                      : 'bg-gold/[0.08] text-on-surface hover:bg-gold/[0.12]'
                  }`}
                >
                  <span className={allOff ? 'line-through' : ''}>{source.name}</span>
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                      allOff
                        ? 'bg-outline-variant/30'
                        : offCount > 0
                          ? 'bg-gold/40 ring-1 ring-gold'
                          : 'bg-gold'
                    }`}
                  />
                </button>
                <div className="mt-1 space-y-1 pl-3">
                  {(selfTitled ? [] : source.bosses).map((boss) => {
                    const isOn = !excludedSources.has(boss.key);
                    return (
                      <button
                        key={boss.key}
                        type="button"
                        onClick={() => toggleSource([boss.key])}
                        aria-pressed={isOn}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                          isOn
                            ? 'border-gold/20 bg-gold/[0.05] text-on-surface hover:border-gold/35'
                            : 'border-outline-variant/10 bg-surface-container-high text-on-surface-variant/45 hover:text-on-surface-variant/70'
                        }`}
                      >
                        <span className={isOn ? '' : 'line-through'}>{boss.name}</span>
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${isOn ? 'bg-gold' : 'bg-outline-variant/30'}`}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </details>
  );
}
