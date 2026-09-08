use sqlx::{AnyPool, Row};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Cache of names fetched on demand from Wowhead, keyed by `(kind, id, locale)`
/// where `kind` is "item" or "spell". Fills the zh_CN gap in the bundled
/// `item-names.json`, which ships de/en/es/fr/it/pt/ru only.
#[derive(Clone)]
pub struct LocalizedNamesRepo {
    backend: NamesBackend,
}

/// `(kind, id, locale) -> name`, mirroring the table's primary key.
type MemoryNames = HashMap<(String, i64, String), String>;

#[derive(Clone)]
enum NamesBackend {
    Database(AnyPool),
    Memory(Arc<Mutex<MemoryNames>>),
}

/// IN-clause chunk size — SQLite's variable limit is historically 999, so 500
/// leaves margin (matches `combo_dedup_repo`).
const IN_CHUNK_SIZE: usize = 500;

impl LocalizedNamesRepo {
    pub fn new(pool: AnyPool) -> Self {
        Self {
            backend: NamesBackend::Database(pool),
        }
    }

    pub fn new_memory() -> Self {
        Self {
            backend: NamesBackend::Memory(Arc::new(Mutex::new(HashMap::new()))),
        }
    }

    /// Cached names for `ids`; ids without a cached name are simply absent.
    pub async fn get_many(
        &self,
        kind: &str,
        locale: &str,
        ids: &[u64],
    ) -> Result<HashMap<u64, String>, sqlx::Error> {
        let mut found = HashMap::new();
        if ids.is_empty() {
            return Ok(found);
        }
        match &self.backend {
            NamesBackend::Database(pool) => {
                for chunk in ids.chunks(IN_CHUNK_SIZE) {
                    let placeholders: Vec<String> =
                        (0..chunk.len()).map(|i| format!("${}", i + 3)).collect();
                    let sql = format!(
                        "SELECT id, name FROM localized_names \
                         WHERE kind = $1 AND locale = $2 AND id IN ({})",
                        placeholders.join(",")
                    );
                    let mut q = sqlx::query(&sql).bind(kind).bind(locale);
                    for id in chunk {
                        q = q.bind(*id as i64);
                    }
                    for row in q.fetch_all(pool).await? {
                        found.insert(row.get::<i64, _>("id") as u64, row.get::<String, _>("name"));
                    }
                }
            }
            NamesBackend::Memory(names) => {
                let names = names.lock().unwrap();
                for id in ids {
                    if let Some(name) =
                        names.get(&(kind.to_string(), *id as i64, locale.to_string()))
                    {
                        found.insert(*id, name.clone());
                    }
                }
            }
        }
        Ok(found)
    }

    /// Upsert freshly fetched names. Re-fetching an id overwrites it, so a
    /// corrected Wowhead name replaces the stale one.
    pub async fn put_many(
        &self,
        kind: &str,
        locale: &str,
        entries: &[(u64, String)],
    ) -> Result<(), sqlx::Error> {
        if entries.is_empty() {
            return Ok(());
        }
        let now = chrono::Utc::now().to_rfc3339();
        match &self.backend {
            NamesBackend::Database(pool) => {
                for chunk in entries.chunks(IN_CHUNK_SIZE / 5) {
                    let values = crate::db::values_placeholders(chunk.len(), 5);
                    let sql = format!(
                        "INSERT INTO localized_names (kind, id, locale, name, fetched_at) \
                         VALUES {values} \
                         ON CONFLICT(kind, id, locale) DO UPDATE SET \
                             name = excluded.name, fetched_at = excluded.fetched_at"
                    );
                    let mut q = sqlx::query(&sql);
                    for (id, name) in chunk {
                        q = q
                            .bind(kind)
                            .bind(*id as i64)
                            .bind(locale)
                            .bind(name.as_str())
                            .bind(now.as_str());
                    }
                    q.execute(pool).await?;
                }
            }
            NamesBackend::Memory(names) => {
                let mut names = names.lock().unwrap();
                for (id, name) in entries {
                    names.insert(
                        (kind.to_string(), *id as i64, locale.to_string()),
                        name.clone(),
                    );
                }
            }
        }
        Ok(())
    }

    /// Every cached name for one kind, as `id -> locale -> name`. One query —
    /// `GET /api/item-names` merges this into its response on every request.
    pub async fn all_by_kind(
        &self,
        kind: &str,
    ) -> Result<HashMap<u64, HashMap<String, String>>, sqlx::Error> {
        let mut out: HashMap<u64, HashMap<String, String>> = HashMap::new();
        match &self.backend {
            NamesBackend::Database(pool) => {
                let rows =
                    sqlx::query("SELECT id, locale, name FROM localized_names WHERE kind = $1")
                        .bind(kind)
                        .fetch_all(pool)
                        .await?;
                for row in rows {
                    out.entry(row.get::<i64, _>("id") as u64)
                        .or_default()
                        .insert(row.get::<String, _>("locale"), row.get::<String, _>("name"));
                }
            }
            NamesBackend::Memory(names) => {
                for ((row_kind, id, locale), name) in names.lock().unwrap().iter() {
                    if row_kind == kind {
                        out.entry(*id as u64)
                            .or_default()
                            .insert(locale.clone(), name.clone());
                    }
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Guards the miss semantics: uncached ids are absent, never an error.
    #[tokio::test]
    async fn get_many_returns_only_cached_ids() {
        let repo = LocalizedNamesRepo::new_memory();
        repo.put_many("item", "zh_CN", &[(271465, "祝圣烈焰战盔".to_string())])
            .await
            .unwrap();
        let found = repo
            .get_many("item", "zh_CN", &[271465, 999])
            .await
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found.get(&271465).map(String::as_str), Some("祝圣烈焰战盔"));
    }

    // Guards key separation: same id under a different kind/locale is a miss.
    #[tokio::test]
    async fn kind_and_locale_are_part_of_the_key() {
        let repo = LocalizedNamesRepo::new_memory();
        repo.put_many("spell", "zh_CN", &[(7967, "纳拉雷克斯的梦魇".to_string())])
            .await
            .unwrap();
        assert!(repo
            .get_many("item", "zh_CN", &[7967])
            .await
            .unwrap()
            .is_empty());
        assert!(repo
            .get_many("spell", "de_DE", &[7967])
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            repo.get_many("spell", "zh_CN", &[7967])
                .await
                .unwrap()
                .len(),
            1
        );
    }

    // Guards the upsert path — a re-fetch replaces rather than duplicates.
    #[tokio::test]
    async fn put_many_overwrites_existing_name() {
        let repo = LocalizedNamesRepo::new_memory();
        repo.put_many("item", "zh_CN", &[(1, "旧名".to_string())])
            .await
            .unwrap();
        repo.put_many("item", "zh_CN", &[(1, "新名".to_string())])
            .await
            .unwrap();
        let found = repo.get_many("item", "zh_CN", &[1]).await.unwrap();
        assert_eq!(found.get(&1).map(String::as_str), Some("新名"));
    }

    // Guards the GET /api/item-names merge source: item rows only, grouped by locale.
    #[tokio::test]
    async fn all_by_kind_groups_locales_and_filters_kind() {
        let repo = LocalizedNamesRepo::new_memory();
        repo.put_many("item", "zh_CN", &[(1, "甲".to_string())])
            .await
            .unwrap();
        repo.put_many("item", "ko_KR", &[(1, "kor".to_string())])
            .await
            .unwrap();
        repo.put_many("spell", "zh_CN", &[(2, "法术".to_string())])
            .await
            .unwrap();
        let all = repo.all_by_kind("item").await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[&1].len(), 2);
        assert_eq!(all[&1]["zh_CN"], "甲");
    }

    /// One in-memory SQLite DB built through the production connector so the
    /// migration and real SQL can't drift from the memory backend.
    async fn sqlite_test_pool() -> AnyPool {
        crate::db::Database::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite")
            .pool
    }

    // Exercises the real SQL (migration, IN-chunked SELECT, ON CONFLICT upsert).
    #[tokio::test]
    async fn sqlite_round_trip() {
        let repo = LocalizedNamesRepo::new(sqlite_test_pool().await);
        repo.put_many(
            "item",
            "zh_CN",
            &[
                (271465, "祝圣烈焰战盔".to_string()),
                (268265, "甲".to_string()),
            ],
        )
        .await
        .unwrap();
        repo.put_many("spell", "zh_CN", &[(7967, "纳拉雷克斯的梦魇".to_string())])
            .await
            .unwrap();
        let found = repo
            .get_many("item", "zh_CN", &[271465, 268265, 1])
            .await
            .unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[&271465], "祝圣烈焰战盔");
        // Upsert, not a duplicate-key error.
        repo.put_many("item", "zh_CN", &[(271465, "新名".to_string())])
            .await
            .unwrap();
        let all = repo.all_by_kind("item").await.unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[&271465]["zh_CN"], "新名");
    }
}
