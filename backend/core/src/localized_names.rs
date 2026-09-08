//! Pure helpers for the on-demand localized-name lookup against Wowhead's
//! tooltip endpoint. The IO lives in the handler; everything here is testable
//! without a network.

/// Wowhead's numeric locale id for a SimHammer locale code, or `None` when
/// Wowhead has no localization we need to fetch (the bundled `item-names.json`
/// already covers de/es/fr/it/pt/ru, and en_US is the fallback name).
pub fn wowhead_locale_id(locale: &str) -> Option<u32> {
    match locale {
        "zh_CN" => Some(4),
        _ => None,
    }
}

/// Tooltip endpoint for one `kind` ("item" or "spell") and id.
pub fn tooltip_url(kind: &str, id: u64, locale_id: u32) -> String {
    format!("https://nether.wowhead.com/tooltip/{kind}/{id}?dataEnv=1&locale={locale_id}")
}

/// The `name` field of a tooltip response, rejecting empty/blank names.
pub fn parse_tooltip_name(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let name = value.get("name")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Guards the locale allow-list: only zh_CN is missing from item-names.json,
    // so only it may trigger a Wowhead fetch.
    #[test]
    fn maps_only_zh_cn_to_a_wowhead_locale() {
        assert_eq!(wowhead_locale_id("zh_CN"), Some(4));
        for other in [
            "en_US", "de_DE", "es_ES", "fr_FR", "it_IT", "pt_BR", "ru_RU", "",
        ] {
            assert_eq!(wowhead_locale_id(other), None, "locale {other}");
        }
    }

    // Guards the URL shape (host, kind segment, dataEnv + locale query).
    #[test]
    fn builds_item_and_spell_tooltip_urls() {
        assert_eq!(
            tooltip_url("item", 271465, 4),
            "https://nether.wowhead.com/tooltip/item/271465?dataEnv=1&locale=4"
        );
        assert_eq!(
            tooltip_url("spell", 7967, 4),
            "https://nether.wowhead.com/tooltip/spell/7967?dataEnv=1&locale=4"
        );
    }

    // Guards name extraction from a real-shaped tooltip payload.
    #[test]
    fn parses_name_from_tooltip_json() {
        let body = r#"{"name":"祝圣烈焰战盔","quality":4,"icon":"inv_helm_plate"}"#;
        assert_eq!(parse_tooltip_name(body).as_deref(), Some("祝圣烈焰战盔"));
    }

    // Guards the two miss paths: a payload without a usable name, and garbage.
    #[test]
    fn rejects_missing_blank_and_invalid_names() {
        assert_eq!(parse_tooltip_name(r#"{"quality":4}"#), None);
        assert_eq!(parse_tooltip_name(r#"{"name":""}"#), None);
        assert_eq!(parse_tooltip_name(r#"{"name":"   "}"#), None);
        assert_eq!(parse_tooltip_name(r#"{"name":123}"#), None);
        assert_eq!(parse_tooltip_name("not json at all"), None);
    }
}
