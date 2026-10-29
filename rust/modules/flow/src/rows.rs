//! Rows as Drizzle reads them: `to_jsonb(t)` with each `numeric` column
//! replaced by its text (Drizzle returns `numeric` as a string), for
//! `weldsuite_db::js_row`. `$a` is the table's alias.

/// A `projects` row.
macro_rules! project_json {
    ($a:literal) => {
        concat!(
            "(to_jsonb(",
            $a,
            ") || jsonb_build_object(",
            "'budgeted_hours', ",
            $a,
            ".budgeted_hours::text, ",
            "'budgeted_amount', ",
            $a,
            ".budgeted_amount::text, ",
            "'actual_hours', ",
            $a,
            ".actual_hours::text, ",
            "'actual_amount', ",
            $a,
            ".actual_amount::text, ",
            "'hourly_rate', ",
            $a,
            ".hourly_rate::text, ",
            "'progress', ",
            $a,
            ".progress::text))"
        )
    };
}

/// A `project_members` row.
macro_rules! member_json {
    ($a:literal) => {
        concat!(
            "(to_jsonb(",
            $a,
            ") || jsonb_build_object(",
            "'allocation_percentage', ",
            $a,
            ".allocation_percentage::text, ",
            "'hourly_rate', ",
            $a,
            ".hourly_rate::text))"
        )
    };
}

/// A `tasks` row.
#[allow(unused_macros)]
macro_rules! task_json {
    ($a:literal) => {
        concat!(
            "(to_jsonb(",
            $a,
            ") || jsonb_build_object(",
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

/// A `milestones` row.
#[allow(unused_macros)]
macro_rules! milestone_json {
    ($a:literal) => {
        concat!(
            "(to_jsonb(",
            $a,
            ") || jsonb_build_object('progress', ",
            $a,
            ".progress::text))"
        )
    };
}

/// A `time_entries` row.
#[allow(unused_macros)]
macro_rules! time_entry_json {
    ($a:literal) => {
        concat!(
            "(to_jsonb(",
            $a,
            ") || jsonb_build_object(",
            "'rate', ",
            $a,
            ".rate::text, ",
            "'cost', ",
            $a,
            ".cost::text))"
        )
    };
}

/// The status the All Projects table shows for a row: a set `health`
/// wins, else the stored `status` (`DERIVED_STATUS_SQL`).
macro_rules! derived_status {
    ($a:literal) => {
        concat!(
            "(case when coalesce(btrim(",
            $a,
            ".health), '') <> '' then ",
            r"case regexp_replace(lower(btrim(",
            $a,
            r".health)), '[\s-]+', '_', 'g') ",
            "when 'at_risk' then 'at-risk' when 'off_track' then 'off-track' ",
            "when 'critical' then 'off-track' else 'on-track' end ",
            "else ",
            r"case regexp_replace(lower(btrim(",
            $a,
            r".status)), '[\s-]+', '_', 'g') ",
            "when 'on_hold' then 'on-hold' when 'completed' then 'completed' ",
            "when 'archived' then 'completed' when 'cancelled' then 'off-track' ",
            "else 'on-track' end end)"
        )
    };
}

/// Priority rank for sorting; an unset priority sorts as "medium".
macro_rules! priority_rank {
    ($a:literal) => {
        concat!(
            "(case lower(coalesce(nullif(btrim(",
            $a,
            ".priority), ''), 'medium')) ",
            "when 'critical' then 4 when 'high' then 3 when 'medium' then 2 when 'low' then 1 ",
            "else 0 end)"
        )
    };
}

/// The name of the project's first owner member.
macro_rules! owner_name {
    ($a:literal) => {
        concat!(
            "(select wm.name from project_members opm ",
            "join workspace_members wm on wm.user_id = opm.user_id ",
            "where opm.project_id = ",
            $a,
            ".id and lower(opm.role) = 'owner' ",
            "and opm.is_active = true and opm.deleted_at is null ",
            "order by opm.created_at asc limit 1)"
        )
    };
}
