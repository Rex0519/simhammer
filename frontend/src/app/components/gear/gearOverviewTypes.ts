export interface GearItem {
  slot: string;
  item_id: number;
  ilevel: number;
  name: string;
  bonus_ids?: number[];
  crafted_stats?: number[];
  embellishment?: { id: number; name: string; bonus_ids: number[] };
  is_catalyst?: boolean;
  source_item_id?: number;
  enchant_id?: number;
  gem_id?: number;
  /** All gem IDs (one per socket); necks/crafted items hold 2+ but `gem_id` only carries the first, so prefer `gem_ids` when present. */
  gem_ids?: number[];
  /** Set when the combo assumes this item gained a socket ("add up to N sockets"). */
  socket_added?: boolean;
  is_kept?: boolean;
  upgrade_levels?: number;
  /** Set on a budgeted upgrade variant (#144). */
  upgraded?: boolean;
  /** Crest cost of that upgrade, by currency id. */
  upgrade_cost?: Record<string, number>;
  origin?: string;
}

export const GEAR_ORDER_LEFT = ['head', 'neck', 'shoulder', 'back', 'chest', 'wrist'];
export const GEAR_ORDER_RIGHT = [
  'hands',
  'waist',
  'legs',
  'feet',
  'finger1',
  'finger2',
  'trinket1',
  'trinket2',
];
export const GEAR_ORDER_BOTTOM = ['main_hand', 'off_hand'];
