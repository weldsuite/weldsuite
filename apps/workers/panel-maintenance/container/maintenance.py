"""Rewrites the WeldPanel Iceberg tables: erasures (GDPR) and retention.

Basin SQL is read only, so this is the one place rows are removed
(docs/plans/weldpanel.md, "Privacy and GDPR"). The spec comes from the
panel-maintenance worker (src/spec.ts) and says which people to erase from
which project and how long each project's events are kept.

Every delete is scoped by workspace and project, and an erasure never touches
a row it does not name. A delete is skipped when nothing matches, so a run
over nothing commits nothing. Running the same spec twice is harmless.
"""

import os
from datetime import datetime, timezone

from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.expressions import And, EqualTo, In, LessThan, Or
from pyiceberg.types import TimestamptzType

NAMESPACE = os.environ.get("CATALOG_NAMESPACE", "panel")
EVENTS, IDENTITIES, PEOPLE, REPLAY_CHUNKS = "events_v1", "identities_v1", "people_v1", "replay_chunks_v1"
# Ids and projects go into a filter in slices, so one expression stays small.
SLICE = 500


def open_catalog(env=os.environ):
    return RestCatalog(
        name="panel",
        uri=env["CATALOG_URI"],
        warehouse=env["CATALOG_WAREHOUSE"],
        token=env["CATALOG_TOKEN"],
    )


def slices(items, size=SLICE):
    items = list(items)
    for start in range(0, len(items), size):
        yield items[start : start + size]


def months_before(moment, months):
    """The same moment `months` calendar months earlier (the day is clamped to the month's length)."""
    index = moment.year * 12 + (moment.month - 1) - months
    year, month = divmod(index, 12)
    month += 1
    for day in (moment.day, 30, 29, 28):
        try:
            return moment.replace(year=year, month=month, day=day)
        except ValueError:
            continue
    raise ValueError("unreachable")


def timestamp_literal(table, column, moment):
    """A literal the column's type accepts: timestamptz needs an offset, timestamp must have none."""
    field_type = table.schema().find_field(column).field_type
    if isinstance(field_type, TimestamptzType):
        return moment.astimezone(timezone.utc).isoformat()
    return moment.astimezone(timezone.utc).replace(tzinfo=None).isoformat()


def delete_where(table, expression):
    """Deletes the rows matching `expression`; returns how many there were (no commit when none)."""
    count = table.scan(row_filter=expression).count()
    if count:
        table.delete(delete_filter=expression)
    return count


def session_ids(table, expression):
    """The distinct session ids of the rows matching `expression`."""
    rows = table.scan(row_filter=expression, selected_fields=("session_id",)).to_arrow()
    return {value for value in rows.column("session_id").to_pylist() if value}


def erase(catalog, erasure):
    """Removes one project's erased ids from all four tables. Returns the row counts per table.

    Recording chunk rows only name sessions, so the sessions are found through
    the events first, and the events are deleted last: a run that stops halfway
    can still find them again.
    """
    events = catalog.load_table(f"{NAMESPACE}.{EVENTS}")
    identities = catalog.load_table(f"{NAMESPACE}.{IDENTITIES}")
    people = catalog.load_table(f"{NAMESPACE}.{PEOPLE}")
    chunks = catalog.load_table(f"{NAMESPACE}.{REPLAY_CHUNKS}")

    def scope(*conditions):
        base = And(EqualTo("workspace_id", erasure["workspaceId"]), EqualTo("project_id", erasure["projectId"]))
        return And(base, *conditions) if conditions else base

    counts = {"events": 0, "identities": 0, "people": 0, "replayChunks": 0}
    for ids in slices(sorted(set(erasure["ids"]))):
        who_events = Or(In("distinct_id", ids), In("anon_id", ids), In("user_id", ids))
        for sessions in slices(sorted(session_ids(events, scope(who_events)))):
            counts["replayChunks"] += delete_where(chunks, scope(In("session_id", sessions)))
        counts["identities"] += delete_where(identities, scope(Or(In("anon_id", ids), In("user_id", ids))))
        counts["people"] += delete_where(people, scope(In("user_id", ids)))
        counts["events"] += delete_where(events, scope(who_events))
    return counts


def expire(catalog, retention, max_months, now):
    """Drops events (and their recording chunk rows) past each project's retention.

    Projects the registry does not list (deleted ones) fall under the longest
    retention. Identity links and profile snapshots stay: the PanelProject
    object is their source of truth, and erasure removes them.
    """
    events = catalog.load_table(f"{NAMESPACE}.{EVENTS}")
    chunks = catalog.load_table(f"{NAMESPACE}.{REPLAY_CHUNKS}")
    counts = {"events": 0, "replayChunks": 0}

    def drop(table, column, expression_for_projects, months):
        cutoff = timestamp_literal(table, column, months_before(now, months))
        return delete_where(table, And(LessThan(column, cutoff), expression_for_projects))

    for group in retention:
        for project_ids in slices(group["projectIds"]):
            in_group = In("project_id", project_ids)
            counts["events"] += drop(events, "ts", in_group, group["months"])
            counts["replayChunks"] += drop(chunks, "ts_start", in_group, group["months"])

    for table, column, key in ((events, "ts", "events"), (chunks, "ts_start", "replayChunks")):
        cutoff = timestamp_literal(table, column, months_before(now, max_months))
        counts[key] += delete_where(table, LessThan(column, cutoff))
    return counts


def run(spec, catalog=None):
    """Runs one spec. Returns {'erased': {...}, 'expired': {...}} (the shape src/spec.ts calls MaintenanceJobResult)."""
    catalog = catalog or open_catalog()
    now = datetime.fromisoformat(spec["now"].replace("Z", "+00:00"))

    erased = {"events": 0, "identities": 0, "people": 0, "replayChunks": 0}
    for erasure in spec["erasures"]:
        for table, count in erase(catalog, erasure).items():
            erased[table] += count

    expired = expire(catalog, spec["retention"], spec["maxRetentionMonths"], now)
    return {"erased": erased, "expired": expired}
