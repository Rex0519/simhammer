import type { ReactNode } from 'react';
import type { GearItem } from './gearOverviewTypes';

export interface ResultItem extends GearItem {
  encounter?: string;
  type?: 'enchant' | 'gem';
}

export interface TopGearResult {
  name: string;
  items: ResultItem[];
  dps: number;
  talent_build?: string;
  talent_spec?: string;
  delta: number;
  /** 95% CI half-width as % of mean DPS; combos pruned at rougher stages carry that stage's looser precision. */
  precision_pct?: number;
}

/** Metrics shared by the boss rows and the instance rollup of `source_summary`. */
export interface DropSourceMetrics {
  /** Deduped droppable items simmed for this source. */
  items: number;
  upgrades: number;
  /** Average DPS gain over the source's items; non-upgrades count as 0. */
  expected: number;
  best: number;
  /** upgrades / items, 0..1. */
  upgrade_chance: number;
  /** 1-based Raidbots priority (tier by expected, then upgrade chance, then best). */
  priority: number;
}

export interface DropSourceEntry extends DropSourceMetrics {
  /** encounter_id when known, else the boss name. */
  key: string;
  encounter: string;
  instance_name: string;
  best_item: { name: string; item_id: number; ilevel: number; delta: number };
}

export interface DropInstanceEntry extends DropSourceMetrics {
  instance_name: string;
}

/** Per-source aggregation the backend attaches to Drop Finder results on read. */
export interface DropSourceSummary {
  sources: DropSourceEntry[];
  instances: DropInstanceEntry[];
}

export interface TopGearResultsProps {
  playerName: string;
  playerClass: string;
  playerRealm?: string;
  playerRegion?: string;
  baseDps: number;
  results: TopGearResult[];
  equippedGear?: Record<string, ResultItem>;
  fightLength?: number;
  desiredTargets?: number;
  iterations?: number;
  targetError?: number;
  elapsedTime?: number;
  backLink?: ReactNode;
  /** Per-source summary (Drop Finder only); renders the "where to go next" table. */
  sourceSummary?: DropSourceSummary;
  /** Source job id — enables the per-row "Sim" verify button. Omit on historical/imported views where re-running isn't applicable. */
  sourceJobId?: string;
}

export type GroupMode = 'rank' | 'encounter' | 'slot';
