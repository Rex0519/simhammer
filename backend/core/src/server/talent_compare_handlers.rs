use actix_web::{web, HttpRequest, HttpResponse};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

use super::handler_prep::{
    normalized_talent_builds, preprocess_simc_input, serialize_combo_metadata_vec,
};
use super::job_spawn::{
    resolve_provider_for_request, submit_profileset_sim, validate_batch, ProfilesetSubmission,
};
use super::simc_input::inject_expert_fields;
use super::types::*;
use crate::addon_parser;
use crate::compute::SimcBinaries;
use crate::compute::{ProviderRegistry, WorkloadEstimate};
use crate::db::{JobRepo, SettingsRepo};
use crate::gear_resolver;
use crate::log_buffer::LogBuffer;
use crate::profileset_generator;

/// Stamp each combo's metadata rows with the talent string of the build they
/// were generated for. `GET /api/sim/{id}` doesn't expose `request_json`, so
/// this is the only place the results page can recover the per-row strings the
/// talent diff needs.
fn stamp_talent_strings(
    combo_metadata: &mut HashMap<String, Vec<Value>>,
    talent_builds: &[(String, String)],
) {
    let by_name: HashMap<&str, &str> = talent_builds
        .iter()
        .map(|(name, ts)| (name.as_str(), ts.as_str()))
        .collect();
    for items in combo_metadata.values_mut() {
        for item in items.iter_mut() {
            let build = item
                .get("talent_build")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            if let Some(ts) = build.as_deref().and_then(|b| by_name.get(b)) {
                item["talent_string"] = json!(ts);
            }
        }
    }
}

pub(super) async fn create_talent_compare_sim(
    http_req: HttpRequest,
    req: web::Json<TalentCompareRequest>,
    repo: web::Data<JobRepo>,
    settings_repo: web::Data<SettingsRepo>,
    simc_bins: web::Data<Arc<SimcBinaries>>,
    log_buffer: web::Data<Arc<LogBuffer>>,
    registry: web::Data<Arc<ProviderRegistry>>,
) -> HttpResponse {
    let simc_input = preprocess_simc_input(
        &req.simc_input,
        &req.options.talents,
        &req.options.spec_override,
    );

    let talent_builds = normalized_talent_builds(&req.talent_builds);
    if talent_builds.len() < 2 {
        return HttpResponse::BadRequest().json(json!({
            "detail": "Select at least two talent builds."
        }));
    }

    let parse_result = addon_parser::parse_simc_input(&simc_input);
    let base_profile = gear_resolver::resolve_gear(&parse_result).base_profile;

    // Talents are the only axis: gear stays exactly as equipped.
    let items_by_slot: HashMap<String, Vec<Value>> = HashMap::new();
    let selected_items: HashMap<String, Vec<String>> = HashMap::new();
    let gem_opts = profileset_generator::GemEnchantOptions::default();

    let (generated_input, combo_count, mut combo_metadata) =
        match profileset_generator::generate_top_gear_input_with_talents(
            &base_profile,
            &items_by_slot,
            &selected_items,
            None,
            &talent_builds,
            None,
            &gem_opts,
        ) {
            Ok(r) => r,
            Err(e) => {
                return HttpResponse::BadRequest().json(json!({ "detail": e }));
            }
        };
    stamp_talent_strings(&mut combo_metadata, &talent_builds);

    let generated_input = inject_expert_fields(&generated_input, &req.options);

    if let Some(resp) = validate_batch(&req.options.batch_id, repo.get_ref()).await {
        return resp;
    }

    let (provider, avail) = match resolve_provider_for_request(
        "talent_compare",
        req.options.compute_provider.as_deref(),
        WorkloadEstimate {
            combo_count,
            would_use_streaming_path: false,
        },
        http_req.headers(),
        settings_repo.get_ref(),
        registry.get_ref(),
    )
    .await
    {
        Ok(t) => t,
        Err(resp) => return resp,
    };

    let envelope_payload = json!({
        "base_profile": base_profile,
        "talent_builds": talent_builds,
        "spec": req.options.spec_override,
        "options": req.options.to_json(),
    });

    let combo_metadata_serialized = serialize_combo_metadata_vec(&combo_metadata);

    submit_profileset_sim(
        ProfilesetSubmission {
            sim_type: "talent_compare",
            sim_mode: crate::models::SimMode::TalentCompare,
            generated_input,
            combo_count,
            combo_metadata_serialized,
            envelope_payload,
        },
        &req.options,
        provider,
        avail,
        repo.get_ref(),
        simc_bins.get_ref(),
        log_buffer.get_ref(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Regression: the results page recovers each row's talent string from its
    // combo metadata (request_json isn't exposed by GET /api/sim/{id}), so the
    // stamp must land on every row tagged with a known build name.
    #[test]
    fn stamp_talent_strings_tags_rows_by_build_name() {
        let mut meta = HashMap::new();
        meta.insert(
            "Currently Equipped (Build A)".to_string(),
            vec![json!({"talent_build": "Build A", "is_kept": true})],
        );
        meta.insert(
            "Combo 2".to_string(),
            vec![json!({"talent_build": "Build B", "is_kept": true})],
        );
        let builds = vec![
            ("Build A".to_string(), "AAAA".to_string()),
            ("Build B".to_string(), "BBBB".to_string()),
        ];

        stamp_talent_strings(&mut meta, &builds);

        assert_eq!(
            meta["Currently Equipped (Build A)"][0]["talent_string"],
            "AAAA"
        );
        assert_eq!(meta["Combo 2"][0]["talent_string"], "BBBB");
    }

    // Rows the generator synthesizes without a build tag (e.g. the empty
    // off_hand filler) must be left alone rather than mis-tagged.
    #[test]
    fn stamp_talent_strings_skips_untagged_rows() {
        let mut meta = HashMap::new();
        meta.insert(
            "Combo 2".to_string(),
            vec![json!({"slot": "off_hand", "item_id": 0})],
        );
        let builds = vec![("Build A".to_string(), "AAAA".to_string())];

        stamp_talent_strings(&mut meta, &builds);

        assert!(meta["Combo 2"][0].get("talent_string").is_none());
    }
}
