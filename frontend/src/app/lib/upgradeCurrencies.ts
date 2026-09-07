export interface UpgradeCurrencyMeta {
  id: number;
  amount: number;
  name: string;
  icon: string;
}

const STORAGE_KEY = 'simhammer_upgrade_currencies';

let cached: Record<string, UpgradeCurrencyMeta> | null = null;

/**
 * Currency name/icon cache for the budgeted upgrade spend badges (#144).
 * The results page has no simc input of its own, so it cannot re-query
 * `POST /api/upgrade-compare/prepare` the way `UpgradeBudgetPanel` does;
 * the panel stashes what it fetched and the rankings read it back.
 * Missing (a result opened in a fresh session) just means no name or icon.
 */
export function storeUpgradeCurrencies(currencies: Record<string, UpgradeCurrencyMeta>): void {
  cached = currencies;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(currencies));
  } catch {}
}

/** Memoized: every ranking row asks for this, and it only changes when the
 * budget panel re-fetches (which happens on the Top Gear screen, not here). */
export function getUpgradeCurrencies(): Record<string, UpgradeCurrencyMeta> {
  if (cached) return cached;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    cached = raw ? JSON.parse(raw) : {};
  } catch {
    cached = {};
  }
  return cached ?? {};
}
