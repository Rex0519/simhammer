use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Conservative O(axes) upper-bound on the profileset count (no enumeration).
/// Filters (unique-equipped, vault, weapon, catalyst, item-limit, baseline) only
/// reduce the real count, so it's safe as a "needs Triage?" gate.
pub fn estimate_top_gear_combo_count(
    items_by_slot: &HashMap<String, Vec<Value>>,
    selected_items: &HashMap<String, Vec<String>>,
    enchant_selections: &HashMap<String, Vec<u64>>,
    gem_options: &[u64],
    socketed_item_ids: &HashSet<u64>,
    talent_builds_count: usize,
) -> u64 {
    let gear_axis = gear_axis_size(items_by_slot, selected_items);
    let enchant_axis = enchant_axis_size(enchant_selections);
    let gem_axis = gem_axis_size_upper_bound(gem_options, socketed_item_ids, items_by_slot);
    let talents = talent_builds_count.max(1) as u64;

    // Spec §1: total = gear × (enchant+1) × (gem+1) × talent
    gear_axis
        .saturating_mul(enchant_axis.saturating_add(1))
        .saturating_mul(gem_axis.saturating_add(1))
        .saturating_mul(talents)
}

fn gear_axis_size(
    items_by_slot: &HashMap<String, Vec<Value>>,
    selected_items: &HashMap<String, Vec<String>>,
) -> u64 {
    // For each slot in selected_items: number of selected alternatives + 1 (equipped).
    // For each slot NOT in selected_items: 1 (equipped only).
    // With an upgrade budget (#144) `build_slot_candidates` additionally carries
    // one upgrade variant per base candidate — the equipped item's included —
    // so a budgeted slot is up to twice as wide and varies even with nothing
    // selected.
    let mut prod: u64 = 1;
    for (slot, items) in items_by_slot {
        let selected = selected_items.get(slot).map(|v| v.len()).unwrap_or(0);
        let base = selected as u64 + 1;
        let variants = items
            .iter()
            .filter(|it| {
                it.get("upgraded")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            })
            .count() as u64;
        // At most one variant per base candidate can be a candidate itself.
        let axis = if variants == 0 && selected == 0 {
            1
        } else {
            base.saturating_add(variants.min(base))
        };
        prod = prod.saturating_mul(axis);
    }
    prod
}

fn enchant_axis_size(enchant_selections: &HashMap<String, Vec<u64>>) -> u64 {
    // Product over slots, each axis is options.len() + 1 for equipped baseline.
    let mut prod: u64 = 1;
    for opts in enchant_selections.values() {
        if !opts.is_empty() {
            prod = prod.saturating_mul(opts.len() as u64 + 1);
        }
    }
    // -1 because the all-equipped baseline is subtracted elsewhere.
    prod.saturating_sub(1)
}

fn gem_axis_size_upper_bound(
    gem_options: &[u64],
    socketed_item_ids: &HashSet<u64>,
    items_by_slot: &HashMap<String, Vec<Value>>,
) -> u64 {
    if gem_options.is_empty() {
        return 0;
    }
    // Upper bound: count slots that contain at least one item which CAN have sockets.
    let mut socketed_slots: u64 = 0;
    for items in items_by_slot.values() {
        let any_socketed = items.iter().any(|it| {
            it.get("item_id")
                .and_then(|v| v.as_u64())
                .map(|id| socketed_item_ids.contains(&id))
                .unwrap_or(false)
        });
        if any_socketed {
            socketed_slots += 1;
        }
    }
    if socketed_slots == 0 {
        return 0;
    }
    // gem_options^socketed_slots is the cartesian upper bound.
    let mut prod: u64 = 1;
    let g = gem_options.len() as u64;
    for _ in 0..socketed_slots {
        prod = prod.saturating_mul(g);
        if prod == u64::MAX {
            break;
        }
    }
    prod
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_item(item_id: u64) -> Value {
        json!({ "item_id": item_id, "simc_string": format!(",id={}", item_id) })
    }

    #[test]
    fn no_alternatives_gives_count_one() {
        let mut items = HashMap::new();
        items.insert("head".to_string(), vec![make_item(1)]);
        let selected = HashMap::new();
        let count = estimate_top_gear_combo_count(
            &items,
            &selected,
            &HashMap::new(),
            &[],
            &HashSet::new(),
            1,
        );
        assert_eq!(count, 1);
    }

    #[test]
    fn gear_only_axis() {
        // 2 selectable alternatives in head -> axis 3 (2 selected + 1 equipped)
        let mut items = HashMap::new();
        items.insert(
            "head".to_string(),
            vec![make_item(1), make_item(2), make_item(3)],
        );
        let mut selected = HashMap::new();
        selected.insert("head".to_string(), vec!["2".to_string(), "3".to_string()]);
        let count = estimate_top_gear_combo_count(
            &items,
            &selected,
            &HashMap::new(),
            &[],
            &HashSet::new(),
            1,
        );
        assert_eq!(count, 3);
    }

    #[test]
    fn talent_axis_multiplies() {
        let mut items = HashMap::new();
        items.insert("head".to_string(), vec![make_item(1), make_item(2)]);
        let mut selected = HashMap::new();
        selected.insert("head".to_string(), vec!["2".to_string()]);
        let count = estimate_top_gear_combo_count(
            &items,
            &selected,
            &HashMap::new(),
            &[],
            &HashSet::new(),
            3,
        );
        assert_eq!(count, 2 * 3);
    }

    fn make_variant(item_id: u64, ilvl: u64) -> Value {
        json!({
            "item_id": item_id,
            "simc_string": format!(",id={}", item_id),
            "upgraded": true,
            "upgrade_cost": { "3444": 20 },
            "uid": format!("{item_id}::bags:head:up{ilvl}"),
        })
    }

    /// Guards #144: with a budget, `build_slot_candidates` force-includes the
    /// equipped item's upgrade variant, so a slot varies (axis 2) even with
    /// nothing selected. Reporting 1 makes the `MAX_COMBINATIONS` pre-gate blind.
    #[test]
    fn budgeted_slot_varies_without_any_selection() {
        let mut items = HashMap::new();
        items.insert("head".to_string(), vec![make_item(1), make_variant(1, 302)]);
        let count = estimate_top_gear_combo_count(
            &items,
            &HashMap::new(),
            &HashMap::new(),
            &[],
            &HashSet::new(),
            1,
        );
        assert_eq!(
            count, 2,
            "equipped + its affordable upgrade is a 2-wide axis"
        );
    }

    /// Guards #144: the estimate is a pre-gate, so it must stay an *upper*
    /// bound on what the iterator actually emits for a budgeted request.
    #[test]
    fn budgeted_estimate_is_not_below_the_exact_iterator_count() {
        use crate::test_support::{ensure_game_data_loaded, TestItem};
        ensure_game_data_loaded();

        // uid shape mirrors `selection::make_item_uid`: id:bonuses:origin:slot.
        let uid = |item: &Value| {
            format!(
                "{}::{}:{}",
                item["item_id"].as_u64().unwrap(),
                item["origin"].as_str().unwrap(),
                item["slot"].as_str().unwrap()
            )
        };
        let variant = |base: &Value, ilvl: u64| {
            let mut v = base.clone();
            v["uid"] = json!(format!("{}:up{}", uid(base), ilvl));
            v["is_equipped"] = json!(false);
            v["upgraded"] = json!(true);
            v["upgrade_cost"] = json!({ "3444": 20 });
            v
        };

        let mut items: HashMap<String, Vec<Value>> = HashMap::new();
        let mut selected: HashMap<String, Vec<String>> = HashMap::new();
        for (slot, base_id, alt_id) in [("head", 101u64, 102u64), ("chest", 201, 202)] {
            let equipped = TestItem::new(base_id).slot(slot).equipped().build();
            let alt = TestItem::new(alt_id).slot(slot).build();
            selected.insert(slot.to_string(), vec![uid(&alt)]);
            items.insert(
                slot.to_string(),
                vec![
                    equipped.clone(),
                    variant(&equipped, 302),
                    alt.clone(),
                    variant(&alt, 302),
                ],
            );
        }

        let budget: HashMap<u64, u64> = [(3444u64, 10_000u64)].into_iter().collect();
        let exact = crate::profileset_generator::count_top_gear_combos_with_talents(
            "",
            &items,
            &selected,
            Some(1_000_000),
            &[],
            None,
            &crate::profileset_generator::GemEnchantOptions::default(),
            Some(&budget),
        )
        .expect("count must not trip the pre-gate at this limit");

        let est = estimate_top_gear_combo_count(
            &items,
            &selected,
            &HashMap::new(),
            &[],
            &HashSet::new(),
            1,
        );
        assert!(
            est >= exact as u64,
            "estimate must bound the iterator (est={est}, exact={exact})"
        );
    }

    /// Guards #144: an over-limit budgeted request must be rejected by the
    /// analytic pre-gate instead of walking the whole space.
    #[test]
    fn pre_gate_rejects_over_limit_budgeted_request() {
        use crate::test_support::TestItem;

        let mut items: HashMap<String, Vec<Value>> = HashMap::new();
        for (i, slot) in crate::types::class_data::GEAR_SLOTS.iter().enumerate() {
            let id = 1000 + i as u64;
            let mut equipped = TestItem::new(id).slot(slot).equipped().build();
            equipped["uid"] = json!(format!("{id}::equipped:{slot}"));
            let mut up = equipped.clone();
            up["uid"] = json!(format!("{id}::equipped:{slot}:up302"));
            up["is_equipped"] = json!(false);
            up["upgraded"] = json!(true);
            up["upgrade_cost"] = json!({ "3444": 20 });
            items.insert(slot.to_string(), vec![equipped, up]);
        }

        let budget: HashMap<u64, u64> = [(3444u64, 10_000u64)].into_iter().collect();
        let res = crate::profileset_generator::count_top_gear_combos_with_talents(
            "",
            &items,
            &HashMap::new(),
            Some(1000),
            &[],
            None,
            &crate::profileset_generator::GemEnchantOptions::default(),
            Some(&budget),
        );
        assert!(
            res.is_err(),
            "2^16 budgeted combos must trip the 1000-combo pre-gate, got {res:?}"
        );
    }

    #[test]
    fn does_not_overflow_on_huge_input() {
        // 30 slots, each with 10 alternatives, plus 10 gems on 10 socketed slots.
        let mut items = HashMap::new();
        let mut selected = HashMap::new();
        for i in 0..30 {
            let slot = format!("slot_{i}");
            items.insert(slot.clone(), (0..10).map(make_item).collect());
            selected.insert(slot, (1..10).map(|n| n.to_string()).collect());
        }
        let count = estimate_top_gear_combo_count(
            &items,
            &selected,
            &HashMap::new(),
            &[],
            &HashSet::new(),
            1,
        );
        // 10^30 is way beyond u64::MAX; estimator must saturate, not panic.
        assert_eq!(count, u64::MAX);
    }
}
