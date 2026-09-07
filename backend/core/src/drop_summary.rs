//! Per-source summary of a Drop Finder result ("which boss to prioritise").
//!
//! Reproduces the Raidbots definition: Expected Value is the average DPS gain
//! across the items a source drops (items that are not upgrades count as 0),
//! Best Drop is the largest gain, and Priority groups sources whose Expected
//! Values are within 0.2% DPS of each other, ranks those by the chance that a
//! successful loot roll is an upgrade, and breaks ties with Best Drop.
//!
//! Computed on read from the stored gear-comparison result, so old jobs get it
//! without a schema migration.

use serde_json::{json, Value};
use std::collections::BTreeMap;

/// One droppable item, after deduping the result rows that carry it (a ring
/// simmed in finger1 and finger2 produces two rows for the same drop).
struct Drop {
    item_id: u64,
    ilevel: u64,
    name: String,
    encounter_key: String,
    encounter: String,
    instance_name: String,
    delta: f64,
}

/// A loot source (one boss, or one whole instance) with its drops.
struct Group {
    key: String,
    label: String,
    instance_name: String,
    drops: Vec<usize>,
}

/// One ranked row of the summary.
struct Metrics {
    key: String,
    label: String,
    instance_name: String,
    items: usize,
    upgrades: usize,
    expected: f64,
    best: f64,
    upgrade_chance: f64,
    best_drop: usize,
}

/// Builds `{sources, instances}` for a stored gear-comparison result, or `None`
/// when the result carries no drop-source information (Top Gear, Upgrade
/// Compare, or any run whose items have no encounter).
pub fn summarize(result: &Value) -> Option<Value> {
    let base_dps = result
        .get("base_dps")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let rows = result.get("results")?.as_array()?;

    // Dedupe by (item_id, ilevel, encounter, source_item_id) keeping the best
    // delta: one drop can be simmed into several slots.
    let mut deduped: BTreeMap<String, Drop> = BTreeMap::new();
    for row in rows {
        let row_name = row.get("name").and_then(|v| v.as_str()).unwrap_or("");
        // The parser appends the equipped gear as a normal row; it is no drop.
        if row_name.starts_with("Currently Equipped") {
            continue;
        }
        let delta = row.get("delta").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let Some(items) = row.get("items").and_then(|v| v.as_array()) else {
            continue;
        };
        for item in items {
            let encounter = item.get("encounter").and_then(|v| v.as_str()).unwrap_or("");
            if encounter.is_empty() {
                continue;
            }
            let item_id = item.get("item_id").and_then(|v| v.as_u64()).unwrap_or(0);
            let ilevel = item.get("ilevel").and_then(|v| v.as_u64()).unwrap_or(0);
            let source_item_id = item
                .get("source_item_id")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            // Encounter ids only ride along on drops that came from the drops
            // API; older jobs group by boss name.
            let encounter_key = item
                .get("encounter_id")
                .and_then(|v| v.as_u64())
                .map(|id| id.to_string())
                .unwrap_or_else(|| encounter.to_string());
            let key = format!("{item_id}_{ilevel}_{encounter_key}_{source_item_id}");
            let entry = deduped.entry(key).or_insert_with(|| Drop {
                item_id,
                ilevel,
                name: item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                encounter_key,
                encounter: encounter.to_string(),
                instance_name: item
                    .get("instance_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                delta,
            });
            if delta > entry.delta {
                entry.delta = delta;
            }
        }
    }
    if deduped.is_empty() {
        return None;
    }

    let drops: Vec<Drop> = deduped.into_values().collect();

    let mut by_source: BTreeMap<String, Group> = BTreeMap::new();
    let mut by_instance: BTreeMap<String, Group> = BTreeMap::new();
    for (idx, drop) in drops.iter().enumerate() {
        by_source
            .entry(drop.encounter_key.clone())
            .or_insert_with(|| Group {
                key: drop.encounter_key.clone(),
                label: drop.encounter.clone(),
                instance_name: drop.instance_name.clone(),
                drops: Vec::new(),
            })
            .drops
            .push(idx);
        // Drops without an instance (crafted, world) stay out of that rollup.
        if !drop.instance_name.is_empty() {
            by_instance
                .entry(drop.instance_name.clone())
                .or_insert_with(|| Group {
                    key: drop.instance_name.clone(),
                    label: drop.instance_name.clone(),
                    instance_name: drop.instance_name.clone(),
                    drops: Vec::new(),
                })
                .drops
                .push(idx);
        }
    }

    let sources: Vec<Value> = rank(by_source.into_values().collect(), &drops, base_dps)
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            let best = &drops[m.best_drop];
            let mut row = metrics_json(&m, i + 1);
            row["key"] = json!(m.key);
            row["encounter"] = json!(m.label);
            row["instance_name"] = json!(m.instance_name);
            row["best_item"] = json!({
                "name": best.name,
                "item_id": best.item_id,
                "ilevel": best.ilevel,
                "delta": round1(best.delta),
            });
            row
        })
        .collect();
    let instances: Vec<Value> = rank(by_instance.into_values().collect(), &drops, base_dps)
        .into_iter()
        .enumerate()
        .map(|(i, m)| {
            let mut row = metrics_json(&m, i + 1);
            row["instance_name"] = json!(m.instance_name);
            row
        })
        .collect();

    Some(json!({ "sources": sources, "instances": instances }))
}

/// Computes each group's metrics, then assigns Raidbots priority: order by
/// expected value, walk that order into tiers 0.2% of base DPS wide, and inside
/// a tier prefer the source most likely to actually drop an upgrade.
fn rank(groups: Vec<Group>, drops: &[Drop], base_dps: f64) -> Vec<Metrics> {
    let mut metrics: Vec<Metrics> = groups
        .into_iter()
        .filter(|g| !g.drops.is_empty())
        .map(|g| {
            let items = g.drops.len();
            let upgrades = g.drops.iter().filter(|&&i| drops[i].delta > 0.0).count();
            // Items that are worse than the equipped piece count as 0.
            let total: f64 = g.drops.iter().map(|&i| drops[i].delta.max(0.0)).sum();
            let best_drop = *g
                .drops
                .iter()
                .max_by(|&&a, &&b| cmp(drops[a].delta, drops[b].delta))
                .expect("group has drops");
            Metrics {
                key: g.key,
                label: g.label,
                instance_name: g.instance_name,
                items,
                upgrades,
                expected: round1(total / items as f64),
                best: round1(drops[best_drop].delta.max(0.0)),
                upgrade_chance: round4(upgrades as f64 / items as f64),
                best_drop,
            }
        })
        .collect();

    metrics.sort_by(|a, b| cmp(b.expected, a.expected));

    let tier_width = base_dps * 0.002;
    let mut start = 0;
    while start < metrics.len() {
        let leader = metrics[start].expected;
        let mut end = start;
        while end < metrics.len() && leader - metrics[end].expected <= tier_width {
            end += 1;
        }
        metrics[start..end]
            .sort_by(|a, b| cmp(b.upgrade_chance, a.upgrade_chance).then(cmp(b.best, a.best)));
        start = end;
    }

    metrics
}

fn metrics_json(m: &Metrics, priority: usize) -> Value {
    json!({
        "priority": priority,
        "items": m.items,
        "upgrades": m.upgrades,
        "expected": m.expected,
        "best": m.best,
        "upgrade_chance": m.upgrade_chance,
    })
}

fn cmp(a: f64, b: f64) -> std::cmp::Ordering {
    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn round4(v: f64) -> f64 {
    (v * 10000.0).round() / 10000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(item_id: u64, encounter_id: u64, encounter: &str) -> Value {
        json!({
            "item_id": item_id,
            "ilevel": 720,
            "name": format!("Item {}", item_id),
            "slot": "head",
            "encounter": encounter,
            "encounter_id": encounter_id,
        })
    }

    fn row(name: &str, delta: f64, items: Vec<Value>) -> Value {
        json!({
            "name": name,
            "items": items,
            "dps": 100000.0 + delta,
            "delta": delta,
        })
    }

    fn result(rows: Vec<Value>) -> Value {
        json!({
            "type": "droptimizer",
            "result_kind": "gear_comparison",
            "base_dps": 100000.0,
            "results": rows,
        })
    }

    fn source<'a>(summary: &'a Value, encounter: &str) -> &'a Value {
        summary["sources"]
            .as_array()
            .expect("sources array")
            .iter()
            .find(|s| s["encounter"] == encounter)
            .unwrap_or_else(|| panic!("no source for {encounter}"))
    }

    // Raidbots' own worked example: a boss with one huge drop and a boss whose
    // whole table is a modest upgrade have the same Expected Value, and the
    // reliable one must rank first.
    #[test]
    fn raidbots_worked_example_ranks_reliable_boss_first() {
        let a = [1000.0, -5.0, -5.0, -5.0];
        let b = [250.0, 250.0, 250.0, 250.0];
        let mut rows = Vec::new();
        for (i, delta) in a.iter().enumerate() {
            rows.push(row(
                &format!("Combo A{i}"),
                *delta,
                vec![item(100 + i as u64, 1, "Boss A")],
            ));
        }
        for (i, delta) in b.iter().enumerate() {
            rows.push(row(
                &format!("Combo B{i}"),
                *delta,
                vec![item(200 + i as u64, 2, "Boss B")],
            ));
        }

        let summary = summarize(&result(rows)).expect("summary");
        let a = source(&summary, "Boss A");
        let b = source(&summary, "Boss B");
        assert_eq!(a["expected"], 250.0);
        assert_eq!(b["expected"], 250.0);
        assert_eq!(a["upgrade_chance"], 0.25);
        assert_eq!(b["upgrade_chance"], 1.0);
        assert_eq!(b["priority"], 1);
        assert_eq!(a["priority"], 2);
        assert_eq!(a["best"], 1000.0);
        assert_eq!(a["best_item"]["item_id"], 100);
        assert_eq!(a["items"], 4);
        assert_eq!(a["upgrades"], 1);
    }

    // A ring is simmed in both finger slots, producing two result rows for one
    // droppable item — the loot table must still count it once.
    #[test]
    fn ring_in_both_fingers_counts_once() {
        let mut finger1 = item(500, 7, "Boss");
        finger1["slot"] = json!("finger1");
        let mut finger2 = item(500, 7, "Boss");
        finger2["slot"] = json!("finger2");

        let summary = summarize(&result(vec![
            row("Combo 2", 100.0, vec![finger1]),
            row("Combo 3", 80.0, vec![finger2]),
        ]))
        .expect("summary");

        let boss = source(&summary, "Boss");
        assert_eq!(boss["items"], 1);
        assert_eq!(boss["expected"], 100.0);
        assert_eq!(boss["best"], 100.0);
    }

    // The parser appends a baseline row carrying the equipped gear; it is not a
    // drop and must not show up as a source.
    #[test]
    fn baseline_row_is_ignored() {
        let summary = summarize(&result(vec![
            row(
                "Currently Equipped",
                0.0,
                vec![item(900, 9, "Baseline Boss")],
            ),
            row("Combo 2", 100.0, vec![item(901, 1, "Real Boss")]),
        ]))
        .expect("summary");

        let sources = summary["sources"].as_array().expect("sources array");
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0]["encounter"], "Real Boss");
    }

    // Priority tiers are 0.2% of base DPS wide: inside a tier the reliable
    // source wins, across tiers Expected Value wins.
    #[test]
    fn tier_boundary_uses_0_2_percent_of_base_dps() {
        // Near: EV 1000 (1 of 2 items) vs EV 850 (2 of 2 items) — 150 < 200.
        let near = summarize(&result(vec![
            row("Combo 2", 2000.0, vec![item(1, 1, "Spiky")]),
            row("Combo 3", -10.0, vec![item(2, 1, "Spiky")]),
            row("Combo 4", 900.0, vec![item(3, 2, "Steady")]),
            row("Combo 5", 800.0, vec![item(4, 2, "Steady")]),
        ]))
        .expect("summary");
        assert_eq!(source(&near, "Spiky")["expected"], 1000.0);
        assert_eq!(source(&near, "Steady")["expected"], 850.0);
        assert_eq!(source(&near, "Steady")["priority"], 1);
        assert_eq!(source(&near, "Spiky")["priority"], 2);

        // Far: EV 1000 vs EV 700 — 300 > 200, so Expected Value orders them.
        let far = summarize(&result(vec![
            row("Combo 2", 2000.0, vec![item(1, 1, "Spiky")]),
            row("Combo 3", -10.0, vec![item(2, 1, "Spiky")]),
            row("Combo 4", 700.0, vec![item(3, 2, "Steady")]),
            row("Combo 5", 700.0, vec![item(4, 2, "Steady")]),
        ]))
        .expect("summary");
        assert_eq!(source(&far, "Steady")["expected"], 700.0);
        assert_eq!(source(&far, "Spiky")["priority"], 1);
        assert_eq!(source(&far, "Steady")["priority"], 2);
    }

    // Non-drop gear-comparison results (Top Gear, Upgrade Compare) have no
    // encounter on their items and must not grow a summary.
    #[test]
    fn returns_none_without_encounter_data() {
        let plain = json!({
            "item_id": 42,
            "ilevel": 720,
            "name": "Item 42",
            "slot": "head",
        });
        assert!(summarize(&result(vec![row("Combo 2", 100.0, vec![plain])])).is_none());
        assert!(summarize(&json!({"base_dps": 100000.0})).is_none());
    }

    // Bosses roll up into the instance they belong to; drops without an
    // instance (crafted, world) stay out of that view.
    #[test]
    fn instances_roll_up_named_instances_only() {
        let mut a = item(1, 1, "Boss A");
        a["instance_name"] = json!("Sporefall");
        let mut b = item(2, 2, "Boss B");
        b["instance_name"] = json!("Sporefall");
        let homeless = item(3, 3, "World Boss");

        let summary = summarize(&result(vec![
            row("Combo 2", 300.0, vec![a]),
            row("Combo 3", 100.0, vec![b]),
            row("Combo 4", 500.0, vec![homeless]),
        ]))
        .expect("summary");

        let instances = summary["instances"].as_array().expect("instances array");
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0]["instance_name"], "Sporefall");
        assert_eq!(instances[0]["items"], 2);
        assert_eq!(instances[0]["expected"], 200.0);
        assert_eq!(instances[0]["best"], 300.0);
        assert_eq!(instances[0]["priority"], 1);
    }
}
