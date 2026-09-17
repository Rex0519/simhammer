//! Shared request-preprocessing + serialization helpers for the sim-create and
//! combo-count handlers. Extracted to kill the verbatim duplication the
//! architecture audit (#8) flagged across 5+ handler files.

use actix_web::HttpResponse;
use serde_json::{json, Value};
use std::collections::HashSet;

use super::simc_input::{apply_omnium_override, apply_spec_override, apply_talent_override};
use crate::types::class_data;

/// Apply the standard talent-override → spec-override → omnium-override →
/// talent-normalize chain that every sim handler runs before parsing the simc
/// input. Single source of truth so the ordering can't drift between handlers.
pub(super) fn preprocess_simc_input(
    simc_input: &str,
    talents: &str,
    spec_override: &str,
    omnium: &str,
) -> String {
    let with_overrides = apply_omnium_override(
        &apply_spec_override(&apply_talent_override(simc_input, talents), spec_override),
        omnium,
    );
    crate::talent_normalize::normalize_simc_talents(&with_overrides)
}

/// Why this profile can't be simmed, or `None` when it can. Run on the
/// PREPROCESSED input so a spec override has already been applied — a Holy
/// Paladin running a Retribution loadout sims fine and must not be rejected.
///
/// A missing `spec=` line is not a rejection: `armory_to_simc` omits it when the
/// loadout code won't decode, and SimC falls back to a default spec.
pub(super) fn profile_rejection(simc_input: &str) -> Option<String> {
    let class = match class_data::detect_class(simc_input) {
        Some(c) => c,
        None => {
            return Some(
                "This doesn't look like a SimC export. Copy your profile from the \
                 SimC addon with /simc and paste the whole thing."
                    .to_string(),
            )
        }
    };
    let spec = class_data::detect_spec(simc_input)?;
    if class_data::spec_is_simmable(&class, &spec) {
        return None;
    }
    Some(format!(
        "SimulationCraft has no damage rotation for {} {}, so it can't be simulated.",
        class_data::title_case(&spec.replace('_', " ")),
        class_data::title_case(&class.replace('_', " ")),
    ))
}

/// Guard for every handler that accepts an addon export: 400 before a Job row
/// exists, so an unsimmable profile never leaves an orphan Pending job.
/// Handlers skip this when `raw` is set — Advanced is the expert escape hatch
/// and its input is not an addon export.
pub(super) fn validate_profile(simc_input: &str) -> Option<HttpResponse> {
    let detail = profile_rejection(simc_input)?;
    Some(HttpResponse::BadRequest().json(json!({ "detail": detail })))
}

/// Clamp a client-requested max-combinations against the server-configured cap.
/// `MAX_COMBINATIONS == 0` means "unlimited" on the server side.
pub(super) fn capped_max_combinations(requested: Option<usize>) -> Option<usize> {
    let server_max = crate::db::MAX_COMBINATIONS.load(std::sync::atomic::Ordering::Relaxed);
    match (requested, server_max) {
        (Some(client), max) if max > 0 => Some(client.min(max)),
        (None, max) if max > 0 => Some(max),
        (client, _) => client,
    }
}

/// Collect item IDs that carry at least one socket (equipped + alternatives)
/// from a resolved-gear response. Feeds the gem-axis socket-count logic.
pub(super) fn socketed_item_ids(resolved: &crate::types::ResolveGearResponse) -> HashSet<u64> {
    resolved
        .slots
        .values()
        .flat_map(|res| {
            let mut ids = Vec::new();
            if let Some(eq) = &res.equipped {
                if eq.sockets > 0 {
                    ids.push(eq.item_id);
                }
            }
            for alt in &res.alternatives {
                if alt.sockets > 0 {
                    ids.push(alt.item_id);
                }
            }
            ids
        })
        .collect()
}

/// Serialize a `HashMap<String, Vec<Value>>` combo-metadata map into the
/// `(combo_name, json_string)` pairs `ProfilesetSubmission` expects. Used by
/// top_gear / upgrade_compare (delta-list shape).
pub(super) fn serialize_combo_metadata_vec(
    combo_metadata: &std::collections::HashMap<String, Vec<Value>>,
) -> Vec<(String, String)> {
    combo_metadata
        .iter()
        .map(|(name, deltas)| {
            (
                name.clone(),
                serde_json::to_string(deltas).unwrap_or_else(|_| "[]".to_string()),
            )
        })
        .collect()
}

/// Serialize a `HashMap<String, Value>` combo-metadata map (droptimizer shape:
/// one Value per combo, not a Vec) into `(combo_name, json_string)` pairs.
pub(super) fn serialize_combo_metadata_value(
    combo_metadata: &std::collections::HashMap<String, Value>,
) -> Vec<(String, String)> {
    combo_metadata
        .iter()
        .map(|(name, val)| {
            (
                name.clone(),
                serde_json::to_string(val).unwrap_or_else(|_| "null".to_string()),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preprocess_applies_talent_then_spec_override() {
        let input = "warrior=t\nspec=arms\nhead=,id=1\n";
        let out = preprocess_simc_input(input, "ABBA", "fury", "");
        assert!(
            out.contains("talents=ABBA"),
            "talents override missing: {out}"
        );
        assert!(out.contains("spec=fury"), "spec override missing: {out}");
    }

    #[test]
    fn preprocess_applies_the_omnium_override() {
        let input = "hunter=t\nspec=beast_mastery\nomnium_talents=136814:1\nhead=,id=1\n";
        let out = preprocess_simc_input(input, "", "", "136824:1/136815:1");
        assert!(
            out.contains("omnium_talents=136824:1/136815:1"),
            "omnium override missing: {out}"
        );
        assert!(
            !out.contains("omnium_talents=136814:1"),
            "the exported folio must be replaced, not kept: {out}"
        );
    }

    #[test]
    fn preprocess_empty_overrides_are_noops() {
        let input = "warrior=t\nspec=arms\nhead=,id=1\n";
        let out = preprocess_simc_input(input, "", "", "");
        // No talents= / spec= lines were forced in by empty overrides.
        assert!(
            !out.contains("talents="),
            "empty talents must not inject: {out}"
        );
        assert!(
            out.contains("spec=arms"),
            "original spec must survive: {out}"
        );
    }

    #[test]
    fn capped_zero_server_max_passes_client_through() {
        // With server_max default (0 = unlimited) the client value is returned as-is.
        assert_eq!(capped_max_combinations(Some(42)), Some(42));
        assert_eq!(capped_max_combinations(None), None);
    }

    #[test]
    fn serialize_vec_metadata_round_trips() {
        let mut m = std::collections::HashMap::new();
        m.insert(
            "Combo 2".to_string(),
            vec![serde_json::json!({"slot":"head"})],
        );
        let out = serialize_combo_metadata_vec(&m);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "Combo 2");
        assert!(out[0].1.contains("\"slot\":\"head\""));
    }

    #[test]
    fn a_profile_without_a_class_line_is_rejected() {
        let msg = profile_rejection("hello world\nthis is not a profile").unwrap();
        assert!(msg.contains("SimC export"), "message was: {msg}");
    }

    #[test]
    fn a_healing_spec_simc_rejects_is_named_in_the_message() {
        let input = "paladin=\"Colite\"\nlevel=90\nspec=holy\nhead=,id=271465\n";
        let msg = profile_rejection(input).unwrap();
        assert!(msg.contains("Holy Paladin"), "message was: {msg}");
    }

    #[test]
    fn every_simc_rejected_spec_is_caught() {
        for (class, spec) in [
            ("paladin", "holy"),
            ("priest", "discipline"),
            ("priest", "holy"),
            ("monk", "mistweaver"),
            ("evoker", "preservation"),
        ] {
            let input = format!("{class}=\"T\"\nlevel=90\nspec={spec}\n");
            assert!(
                profile_rejection(&input).is_some(),
                "{class}/{spec} must be rejected"
            );
        }
    }

    #[test]
    fn restoration_specs_are_accepted() {
        // SimC sims both as DPS actors; blocking them would be a regression.
        assert_eq!(
            profile_rejection("druid=\"T\"\nlevel=90\nspec=restoration\n"),
            None
        );
        assert_eq!(
            profile_rejection("shaman=\"T\"\nlevel=90\nspec=restoration\n"),
            None
        );
    }

    #[test]
    fn a_spec_override_to_a_simmable_spec_is_accepted() {
        // A Holy Paladin who picks a Retribution loadout submits a sim that
        // works — the gate must read the post-override profile.
        let raw = "paladin=\"Colite\"\nlevel=90\nspec=holy\n";
        assert!(profile_rejection(raw).is_some());
        let overridden = preprocess_simc_input(raw, "", "retribution", "");
        assert_eq!(profile_rejection(&overridden), None);
    }

    #[test]
    fn a_profile_without_a_spec_line_is_accepted() {
        // armory_to_simc omits spec= when the loadout code won't decode. SimC
        // picks a default spec; that is not grounds to reject the profile.
        assert_eq!(
            profile_rejection("hunter=\"T\"\nlevel=90\nhead=,id=1\n"),
            None
        );
    }

    #[test]
    fn validate_profile_rejects_with_a_400() {
        let resp = validate_profile("paladin=\"T\"\nspec=holy\n").unwrap();
        assert_eq!(resp.status(), actix_web::http::StatusCode::BAD_REQUEST);
        assert!(validate_profile("hunter=\"T\"\nspec=survival\n").is_none());
    }
}
