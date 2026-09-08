use actix_web::{web, HttpResponse};
use serde::{ser::SerializeMap, Deserialize, Serialize, Serializer};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::db::LocalizedNamesRepo;
use crate::localized_names::{parse_tooltip_name, tooltip_url, wowhead_locale_id};

/// Cap per request so one client can't fan out unboundedly onto Wowhead.
const MAX_IDS: usize = 500;
/// Politeness: at most this many Wowhead requests in flight per request.
const FETCH_CONCURRENCY: usize = 6;
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Deserialize)]
pub(super) struct LocalizeRequest {
    locale: String,
    #[serde(default)]
    items: Vec<u64>,
    #[serde(default)]
    spells: Vec<u64>,
}

/// Dedicated client (short timeout, own User-Agent) so tooltip lookups can't
/// sit on the 30 s provider client's budget.
fn tooltip_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("SimHammer")
            .timeout(FETCH_TIMEOUT)
            .build()
            .expect("tooltip reqwest client")
    })
}

async fn fetch_name(kind: &str, id: u64, locale_id: u32) -> Option<(u64, String)> {
    let response = tooltip_client()
        .get(tooltip_url(kind, id, locale_id))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().await.ok()?;
    parse_tooltip_name(&body).map(|name| (id, name))
}

/// Cached names for `ids`, fetching the misses from Wowhead. Ids that stay
/// unresolved are simply absent — one bad id never fails the request.
async fn resolve_names(
    repo: &LocalizedNamesRepo,
    kind: &str,
    locale: &str,
    locale_id: u32,
    ids: &[u64],
) -> HashMap<u64, String> {
    let mut seen = std::collections::HashSet::new();
    let ids: Vec<u64> = ids.iter().copied().filter(|id| seen.insert(*id)).collect();
    if ids.is_empty() {
        return HashMap::new();
    }

    let mut names = repo
        .get_many(kind, locale, &ids)
        .await
        .unwrap_or_else(|err| {
            eprintln!("localized_names: cache read failed ({err}); fetching all");
            HashMap::new()
        });
    let missing: Vec<u64> = ids
        .into_iter()
        .filter(|id| !names.contains_key(id))
        .collect();
    if missing.is_empty() {
        return names;
    }

    let permits = Arc::new(Semaphore::new(FETCH_CONCURRENCY));
    let mut tasks = JoinSet::new();
    for id in missing {
        let permits = permits.clone();
        let kind = kind.to_string();
        tasks.spawn(async move {
            let _permit = permits.acquire_owned().await.ok()?;
            fetch_name(&kind, id, locale_id).await
        });
    }
    let mut fetched: Vec<(u64, String)> = Vec::new();
    while let Some(result) = tasks.join_next().await {
        if let Ok(Some(pair)) = result {
            fetched.push(pair);
        }
    }

    if !fetched.is_empty() {
        if let Err(err) = repo.put_many(kind, locale, &fetched).await {
            eprintln!("localized_names: cache write failed ({err})");
        }
        names.extend(fetched);
    }
    names
}

pub(super) async fn localize_names(
    repo: web::Data<LocalizedNamesRepo>,
    req: web::Json<LocalizeRequest>,
) -> HttpResponse {
    let Some(locale_id) = wowhead_locale_id(&req.locale) else {
        return HttpResponse::BadRequest()
            .json(json!({"detail": format!("Unsupported locale '{}'", req.locale)}));
    };
    if req.items.len() + req.spells.len() > MAX_IDS {
        return HttpResponse::BadRequest()
            .json(json!({"detail": format!("Provide at most {MAX_IDS} ids")}));
    }

    let items = resolve_names(&repo, "item", &req.locale, locale_id, &req.items).await;
    let spells = resolve_names(&repo, "spell", &req.locale, locale_id, &req.spells).await;
    HttpResponse::Ok().json(json!({ "items": items, "spells": spells }))
}

/// `GET /api/item-names` response: the bundled 175k-entry map with cached
/// on-demand names layered on top. Serializes by reference so the big map is
/// never cloned.
pub(super) struct MergedItemNames {
    pub base: &'static HashMap<u64, HashMap<String, String>>,
    pub overrides: HashMap<u64, HashMap<String, String>>,
}

impl Serialize for MergedItemNames {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let extra = self
            .overrides
            .keys()
            .filter(|id| !self.base.contains_key(id))
            .count();
        let mut map = serializer.serialize_map(Some(self.base.len() + extra))?;
        for (id, locales) in self.base {
            match self.overrides.get(id) {
                Some(extra) => {
                    let mut merged: HashMap<&str, &str> = locales
                        .iter()
                        .map(|(k, v)| (k.as_str(), v.as_str()))
                        .collect();
                    for (k, v) in extra {
                        merged.insert(k.as_str(), v.as_str());
                    }
                    map.serialize_entry(id, &merged)?;
                }
                None => map.serialize_entry(id, locales)?,
            }
        }
        for (id, locales) in &self.overrides {
            if !self.base.contains_key(id) {
                map.serialize_entry(id, locales)?;
            }
        }
        map.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_map() -> &'static HashMap<u64, HashMap<String, String>> {
        static BASE: OnceLock<HashMap<u64, HashMap<String, String>>> = OnceLock::new();
        BASE.get_or_init(|| {
            HashMap::from([(
                1u64,
                HashMap::from([
                    ("en_US".to_string(), "Helm".to_string()),
                    ("de_DE".to_string(), "Helm de".to_string()),
                ]),
            )])
        })
    }

    // Guards the merge: cached zh_CN is layered onto the bundled locales
    // without dropping them, and cache-only ids still appear.
    #[test]
    fn merge_adds_locale_without_dropping_bundled_ones() {
        let merged = MergedItemNames {
            base: base_map(),
            overrides: HashMap::from([
                (
                    1u64,
                    HashMap::from([("zh_CN".to_string(), "头盔".to_string())]),
                ),
                (
                    2u64,
                    HashMap::from([("zh_CN".to_string(), "戒指".to_string())]),
                ),
            ]),
        };
        let value: serde_json::Value = serde_json::to_value(&merged).unwrap();
        assert_eq!(value["1"]["en_US"], "Helm");
        assert_eq!(value["1"]["de_DE"], "Helm de");
        assert_eq!(value["1"]["zh_CN"], "头盔");
        assert_eq!(value["2"]["zh_CN"], "戒指");
    }

    // Guards the no-cache fast path: the response is the bundled map untouched.
    #[test]
    fn merge_without_overrides_is_the_bundled_map() {
        let merged = MergedItemNames {
            base: base_map(),
            overrides: HashMap::new(),
        };
        let value: serde_json::Value = serde_json::to_value(&merged).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 1);
        assert_eq!(value["1"]["en_US"], "Helm");
        assert!(value["1"].get("zh_CN").is_none());
    }
}
