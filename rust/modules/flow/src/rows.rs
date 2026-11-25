//! Rows as Drizzle reads them, for the one list that stays SQL (`tasks::list_rows`):
//! `to_jsonb(t)` with each `numeric` column replaced by its text (Drizzle
//! returns `numeric` as a string), for `weldsuite_db::js_row`. `$a` is the
//! table's alias. Everything else reads rows through the entities.

/// A `tasks` row. `epic_id` (EU and self-hosted only, FLOW-023) is left out
/// while null, as the entity leaves `epicId` out: the rows answer as
/// TypeScript's do.
macro_rules! task_json {
    ($a:literal) => {
        concat!(
            "((to_jsonb(",
            $a,
            ") - (case when ",
            $a,
            ".epic_id is null then 'epic_id' else '' end)::text) || jsonb_build_object(",
            "'progress', ",
            $a,
            ".progress::text, ",
            "'estimated_hours', ",
            $a,
            ".estimated_hours::text, ",
            "'actual_hours', ",
            $a,
            ".actual_hours::text))"
        )
    };
}
