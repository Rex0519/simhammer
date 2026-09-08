CREATE TABLE IF NOT EXISTS localized_names (
    kind TEXT NOT NULL,
    id BIGINT NOT NULL,
    locale TEXT NOT NULL,
    name TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (kind, id, locale)
);
