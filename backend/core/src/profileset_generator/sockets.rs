//! Socket-added gear candidates for Top Gear's "add up to N sockets" option.
//!
//! Mirrors the frontend's per-item "Add Socket" (`TopGearItemSelector.tsx`):
//! an unsocketed item in a socketable slot gets a copy carrying bonus
//! [`SOCKET_BONUS_ID`]. How many of those copies may be worn at once is
//! enforced later by `constraints::validate_socket_budget`.

use serde_json::{json, Value};
use std::collections::HashMap;

/// Bonus ID that grants one gem socket (same id the frontend appends).
pub(super) const SOCKET_BONUS_ID: u64 = 13668;

/// uid suffix marking a socket-added copy. `selection` strips it to inherit the
/// source item's selection state.
pub(super) const SOCKET_UID_SUFFIX: &str = ":socket";

/// Slots that may gain a socket — same rule as the frontend `canAddSocket`.
const SOCKETABLE_SLOTS: [&str; 6] = ["head", "neck", "wrist", "waist", "finger1", "finger2"];

/// Widen `items_by_slot` with a socket-added copy of every unsocketed item in a
/// socketable slot. Callers apply this only when the request asks for sockets
/// (`socket_budget > 0`), after the upgrade / copy-enchant transforms.
pub(crate) fn add_socket_candidates(
    items_by_slot: &HashMap<String, Vec<Value>>,
) -> HashMap<String, Vec<Value>> {
    let mut result = HashMap::with_capacity(items_by_slot.len());
    for (slot, slot_items) in items_by_slot {
        let mut items = slot_items.clone();
        if SOCKETABLE_SLOTS.contains(&slot.as_str()) {
            items.extend(slot_items.iter().filter_map(socket_added_copy));
        }
        result.insert(slot.clone(), items);
    }
    result
}

/// One socket-added copy of `item`, or `None` when it already has a socket.
fn socket_added_copy(item: &Value) -> Option<Value> {
    if item.get("sockets").and_then(|v| v.as_u64()).unwrap_or(0) > 0 {
        return None;
    }
    let mut bonus_ids: Vec<u64> = item
        .get("bonus_ids")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|b| b.as_u64()).collect())
        .unwrap_or_default();
    bonus_ids.push(SOCKET_BONUS_ID);

    let mut copy = item.clone();
    copy["uid"] = json!(format!(
        "{}{}",
        super::selection::make_item_uid(item),
        SOCKET_UID_SUFFIX
    ));
    copy["bonus_ids"] = json!(bonus_ids);
    if let Some(simc) = item.get("simc_string").and_then(|s| s.as_str()) {
        copy["simc_string"] = json!(append_socket_bonus(simc));
    }
    copy["sockets"] = json!(1);
    copy["gem_id"] = json!(0);
    // The copy is a variant of the equipped item, never the equipped state
    // itself — otherwise it would be mistaken for the baseline gear set.
    copy["is_equipped"] = json!(false);
    copy["socket_added"] = json!(true);
    Some(copy)
}

/// Append the socket bonus to a simc line's `bonus_id=` group, keeping the
/// separator the line already uses; adds the group when the line has none.
fn append_socket_bonus(simc: &str) -> String {
    let Some(start) = simc.find("bonus_id=") else {
        return format!("{},bonus_id={}", simc, SOCKET_BONUS_ID);
    };
    let value_start = start + "bonus_id=".len();
    let value_end = simc[value_start..]
        .find(',')
        .map(|i| value_start + i)
        .unwrap_or(simc.len());
    let sep = if simc[value_start..value_end].contains('/') {
        "/"
    } else {
        ":"
    };
    format!(
        "{}{}{}{}",
        &simc[..value_end],
        sep,
        SOCKET_BONUS_ID,
        &simc[value_end..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestItem;

    fn items(slot: &str, item: Value) -> HashMap<String, Vec<Value>> {
        HashMap::from([(slot.to_string(), vec![item])])
    }

    #[test]
    fn eligible_unsocketed_item_gains_a_socket_added_copy() {
        // regression: the "add up to N sockets" option must offer bonus 13668 copies
        let head = TestItem::new(100)
            .slot("head")
            .bonus_ids(vec![1000])
            .simc_string(",id=100,bonus_id=1000")
            .build();
        let out = add_socket_candidates(&items("head", head));

        let head_items = &out["head"];
        assert_eq!(head_items.len(), 2, "expected the original plus one copy");
        let copy = &head_items[1];
        assert_eq!(copy["bonus_ids"], json!([1000, SOCKET_BONUS_ID]));
        assert_eq!(copy["simc_string"], ",id=100,bonus_id=1000:13668");
        assert_eq!(copy["sockets"], 1);
        assert_eq!(copy["gem_id"], 0);
        assert_eq!(copy["socket_added"], true);
        assert_eq!(copy["is_equipped"], false);
        assert!(
            copy["uid"].as_str().unwrap().ends_with(SOCKET_UID_SUFFIX),
            "copy uid must be suffixed so selection can find its source: {}",
            copy["uid"]
        );
    }

    #[test]
    fn ineligible_slot_is_untouched() {
        // regression: only the slots the frontend's canAddSocket allows may gain sockets
        let chest = TestItem::new(200).slot("chest").build();
        let out = add_socket_candidates(&items("chest", chest));
        assert_eq!(out["chest"].len(), 1);
    }

    #[test]
    fn already_socketed_item_is_untouched() {
        // regression: an item that already has a socket must not gain a second one
        let head = TestItem::new(100).slot("head").sockets(1).build();
        let out = add_socket_candidates(&items("head", head));
        assert_eq!(out["head"].len(), 1);
    }

    #[test]
    fn simc_line_without_bonus_ids_gains_the_group() {
        // regression: manually added items carry no bonus_id= group to extend
        let head = TestItem::new(100)
            .slot("head")
            .simc_string(",id=100")
            .build();
        let out = add_socket_candidates(&items("head", head));
        assert_eq!(out["head"][1]["simc_string"], ",id=100,bonus_id=13668");
    }
}
