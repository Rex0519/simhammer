'use client';
/* eslint-disable @next/next/no-img-element */

import { useEffect, useRef, useState } from 'react';
import { API_URL } from '../../lib/api';
import { useLanguage } from '../../lib/i18n';
import { iconProps } from '../../lib/useItemInfo';
import {
  storeUpgradeCurrencies,
  type UpgradeCurrencyMeta as CurrencyMeta,
} from '../../lib/upgradeCurrencies';

/**
 * Editable crest budget for "Sim Highest Upgrade" (#144). Currencies and their
 * owned amounts come from the Crest Upgrades prep endpoint — the same
 * `# upgrade_currencies` line the addon export carries — so there is no new
 * endpoint here. An export without that line leaves the budget empty, and the
 * caller then sends no `upgrade_budget` at all (unbounded max-upgrade).
 */
export default function UpgradeBudgetPanel({
  simcInput,
  budget,
  onBudgetChange,
}: {
  simcInput: string;
  budget: Record<string, number>;
  onBudgetChange: (budget: Record<string, number>) => void;
}) {
  const { t } = useLanguage();
  const [currencies, setCurrencies] = useState<Record<string, CurrencyMeta> | null>(null);
  const [loading, setLoading] = useState(false);
  // Raw text per currency while the field is being edited, so clearing it does
  // not snap to "0" and block retyping. Dropped on blur, when the coerced
  // number in `budget` takes over again.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Prefill must not fight the user: once they have edited an amount for this
  // export, later re-fetches keep their number.
  const prefilledForRef = useRef<string | null>(null);

  useEffect(() => {
    const trimmed = simcInput.trim();
    if (trimmed.length < 10) {
      setCurrencies(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/upgrade-compare/prepare`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ simc_input: trimmed }),
        });
        if (cancelled) return;
        if (!res.ok) {
          setCurrencies({});
          return;
        }
        const result: { currencies?: Record<string, CurrencyMeta> } = await res.json();
        if (cancelled) return;
        setCurrencies(result.currencies ?? {});
        // The results page labels its spend badges from this cache (#144).
        storeUpgradeCurrencies(result.currencies ?? {});
      } catch {
        if (!cancelled) setCurrencies({});
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [simcInput]);

  useEffect(() => {
    if (currencies === null) return;
    const key = simcInput.trim();
    if (prefilledForRef.current === key) return;
    prefilledForRef.current = key;

    const prefilled: Record<string, number> = {};
    for (const [cid, meta] of Object.entries(currencies)) {
      prefilled[cid] = budget[cid] ?? meta.amount;
    }
    onBudgetChange(prefilled);
    // Runs once per export: `budget` and `onBudgetChange` change on every edit,
    // and re-running on those would overwrite what the user just typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currencies, simcInput]);

  if (currencies === null) {
    return null;
  }

  const rows = Object.values(currencies)
    .filter((c) => c.name)
    .sort((a, b) => a.id - b.id);

  return (
    <div className="rounded-lg border border-outline-variant/15 bg-surface-container px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[12px] font-medium uppercase tracking-widest text-muted">
          {t('topGear.budgetTitle')}
        </span>
        <span className="text-[12px] text-on-surface-variant/70">{t('topGear.budgetHelp')}</span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-[13px] text-on-surface-variant">
          {loading ? ' ' : t('topGear.budgetUnavailable')}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {rows.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-1.5 rounded-md bg-surface-container-high px-2 py-1"
            >
              <img {...iconProps(c.icon)} alt="" className="h-4 w-4 shrink-0 rounded-sm" />
              <span className="text-[13px] text-on-surface-variant">{c.name}</span>
              <input
                type="number"
                min={0}
                aria-label={c.name}
                value={drafts[String(c.id)] ?? String(budget[String(c.id)] ?? 0)}
                onChange={(event) => {
                  const raw = event.target.value;
                  setDrafts((prev) => ({ ...prev, [String(c.id)]: raw }));
                  const value = parseInt(raw, 10);
                  onBudgetChange({
                    ...budget,
                    [String(c.id)]: Number.isNaN(value) || value < 0 ? 0 : value,
                  });
                }}
                onBlur={() => {
                  setDrafts((prev) => {
                    const next = { ...prev };
                    delete next[String(c.id)];
                    return next;
                  });
                }}
                className="w-16 rounded-md border border-outline-variant/30 bg-surface-container px-1 py-0.5 text-center text-[13px] font-bold tabular-nums text-on-surface outline-none focus:border-gold/40"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
