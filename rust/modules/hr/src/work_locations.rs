//! Work locations and the clock-in location rule
//! (`routes/weldhr/work-locations.ts`, `services/weldhr/work-locations.ts`).
//! Configuration, like leave types: no entity events.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::permission_keys::{ATTENDANCE_READ, EMPLOYEES_MANAGE, EMPLOYEES_READ};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::fields::{Fields, change, int, number, short_text};
use crate::{
    Caller, HrError, HrResult, HrState, hr_json, js_round, js_to_fixed, now, query_values,
};

/// At most this much of a GPS fix's uncertainty is given the benefit of the doubt.
const MAX_ACCURACY_ALLOWANCE_METERS: f64 = 50.0;

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    let manage = || gate.require([EMPLOYEES_MANAGE]);
    Router::new()
        .route(
            "/work-locations",
            get(list).route_layer(gate.require([
                EMPLOYEES_READ,
                ATTENDANCE_READ,
                EMPLOYEES_MANAGE,
            ])),
        )
        .route("/work-locations", post(create).route_layer(manage()))
        .route("/work-locations/{id}", patch(update).route_layer(manage()))
        .route("/work-locations/{id}", delete(remove).route_layer(manage()))
}

/// `distanceMeters(a, b)`: great-circle distance (haversine).
pub(crate) fn distance_meters(a: (f64, f64), b: (f64, f64)) -> f64 {
    let to_rad = |deg: f64| (deg * std::f64::consts::PI) / 180.0;
    let d_lat = to_rad(b.0 - a.0);
    let d_lon = to_rad(b.1 - a.1);
    let s_lat = (d_lat / 2.0).sin();
    let s_lon = (d_lon / 2.0).sin();
    let h = s_lat * s_lat + to_rad(a.0).cos() * to_rad(b.0).cos() * s_lon * s_lon;
    2.0 * 6_371_000.0 * h.sqrt().min(1.0).asin()
}

/// `listWorkLocations(db, { includeInactive })`, by name.
pub(crate) async fn list_work_locations(
    db: &PgPool,
    include_inactive: bool,
) -> Result<Vec<Value>, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_work_locations t
         where t.deleted_at is null and ($1 or t.is_active = true)
         order by t.name asc",
    )
    .bind(include_inactive)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(js_row).collect())
}

async fn require_work_location(db: &PgPool, id: &str) -> Result<Value, HrError> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_work_locations t where t.id = $1 and t.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(js_row)
        .ok_or_else(|| HrError::not_found("Work location", id))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let include_inactive = query_values(query.as_deref())
        .get("includeInactive")
        .and_then(Value::as_str)
        == Some("true");
    Ok(Data(list_work_locations(&caller.db, include_inactive).await?).into_response())
}

struct LocationInput {
    name: Field<String>,
    address: Field<String>,
    latitude: Field<f64>,
    longitude: Field<f64>,
    radius_meters: Field<f64>,
    is_active: Field<bool>,
}

fn location_input(
    issues: &mut weldsuite_kit::validation::Issues,
    fields: &Fields,
    partial: bool,
) -> LocationInput {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    LocationInput {
        name: short_text(issues, fields, "name", required, 160, true),
        address: issues.text_with(
            fields,
            "address",
            Presence::Nullish,
            weldsuite_kit::validation::Text::trimmed(None, Some(500)),
        ),
        latitude: number(
            issues,
            fields,
            "latitude",
            required,
            Some(-90.0),
            Some(90.0),
        ),
        longitude: number(
            issues,
            fields,
            "longitude",
            required,
            Some(-180.0),
            Some(180.0),
        ),
        radius_meters: int(
            issues,
            fields,
            "radiusMeters",
            Presence::Optional,
            Some(25.0),
            Some(5000.0),
        ),
        is_active: issues.boolean(fields, "isActive", Presence::Optional),
    }
}

/// `input.address?.trim() || null`.
fn address_of(field: &Field<String>) -> Option<String> {
    field
        .as_set()
        .map(|address| address.trim().to_owned())
        .filter(|address| !address.is_empty())
}

async fn create(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        location_input(issues, fields, false)
    })?;
    let row: Value = sqlx::query_scalar(
        "insert into hr_work_locations (id, name, address, latitude, longitude, radius_meters, is_active)
         values ($1, $2, $3, $4, $5, coalesce($6::int, 150), coalesce($7, true))
         returning to_jsonb(hr_work_locations)",
    )
    .bind(generate_id("hrloc"))
    .bind(input.name.as_set().map(|name| name.trim()))
    .bind(address_of(&input.address))
    .bind(input.latitude.as_set())
    .bind(input.longitude.as_set())
    .bind(input.radius_meters.as_set().map(|r| *r as i32))
    .bind(input.is_active.as_set())
    .fetch_one(&caller.db)
    .await?;
    Ok(Created(js_row(row)).into_response())
}

async fn update(
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        location_input(issues, fields, true)
    })?;
    require_work_location(&caller.db, &id).await?;
    let (set_name, name) = change(&input.name);
    let set_address = !input.address.is_absent();
    let (set_lat, lat) = change(&input.latitude);
    let (set_lon, lon) = change(&input.longitude);
    let (set_radius, radius) = change(&input.radius_meters);
    let (set_active, active) = change(&input.is_active);
    let row: Value = sqlx::query_scalar(
        "update hr_work_locations set
             name = case when $2 then $3 else name end,
             address = case when $4 then $5 else address end,
             latitude = case when $6 then $7 else latitude end,
             longitude = case when $8 then $9 else longitude end,
             radius_meters = case when $10 then $11::int else radius_meters end,
             is_active = case when $12 then $13 else is_active end,
             updated_at = $14::timestamp
         where id = $1 returning to_jsonb(hr_work_locations)",
    )
    .bind(&id)
    .bind(set_name)
    .bind(name.map(|name| name.trim().to_owned()))
    .bind(set_address)
    .bind(address_of(&input.address))
    .bind(set_lat)
    .bind(lat)
    .bind(set_lon)
    .bind(lon)
    .bind(set_radius)
    .bind(radius.map(|r| r as i32))
    .bind(set_active)
    .bind(active)
    .bind(now())
    .fetch_one(&caller.db)
    .await?;
    Ok(Data(js_row(row)).into_response())
}

async fn remove(caller: Caller, Path(id): Path<String>) -> HrResult {
    require_work_location(&caller.db, &id).await?;
    sqlx::query(
        "update hr_work_locations set deleted_at = $2::timestamp, is_active = false, updated_at = $2::timestamp
         where id = $1",
    )
    .bind(&id)
    .bind(now())
    .execute(&caller.db)
    .await?;
    Ok(NoContent.into_response())
}

/// `assertWorkLocations(db, ids)`: every id in an employee's allowed list
/// is a live location.
pub(crate) async fn assert_work_locations(
    db: &PgPool,
    ids: Option<&[String]>,
) -> Result<(), HrError> {
    let Some(ids) = ids.filter(|ids| !ids.is_empty()) else {
        return Ok(());
    };
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    let count: i64 = sqlx::query_scalar(
        "select count(*) from hr_work_locations where id = any($1) and deleted_at is null",
    )
    .bind(&unique)
    .fetch_one(db)
    .await?;
    if usize::try_from(count).unwrap_or_default() != unique.len() {
        return Err(HrError::validation(
            "One of the work locations does not exist",
        ));
    }
    Ok(())
}

/// `workLocationNames(db, ids)`: names, deleted locations included.
pub(crate) async fn work_location_names(
    db: &PgPool,
    ids: &[Option<&str>],
) -> Result<HashMap<String, String>, HrError> {
    let unique: Vec<String> = ids
        .iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .map(|id| (*id).to_owned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if unique.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, String)> =
        sqlx::query_as("select id, name from hr_work_locations where id = any($1)")
            .bind(&unique)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().collect())
}

/// A device's position (`hrGeoPointSchema`).
#[derive(Debug, Clone, Copy)]
pub(crate) struct GeoPoint {
    pub(crate) latitude: f64,
    pub(crate) longitude: f64,
    pub(crate) accuracy: Option<f64>,
}

/// `ClockPlace`: what a clock-in or -out records about where it happened.
#[derive(Debug, Clone, Default)]
pub(crate) struct ClockPlace {
    pub(crate) location_id: Option<String>,
    pub(crate) latitude: Option<f64>,
    pub(crate) longitude: Option<f64>,
}

/// `formatDistance(meters)`.
fn format_distance(meters: f64) -> String {
    if meters >= 1000.0 {
        format!("{} km", js_to_fixed(meters / 1000.0, 1))
    } else {
        format!("{} m", crate::number_text(js_round(meters)))
    }
}

/// `resolveClockPlace(db, employee, point)`.
pub(crate) async fn resolve_clock_place(
    db: &PgPool,
    work_location_ids: Option<Vec<String>>,
    point: Option<GeoPoint>,
) -> Result<ClockPlace, HrError> {
    let Some(point) = point else {
        return Err(HrError::Validation {
            message: "Share your location to clock in or out here".to_owned(),
            details: Some(json!({ "code": "LOCATION_REQUIRED" })),
        });
    };
    let allowed: Option<HashSet<String>> = work_location_ids
        .filter(|ids| !ids.is_empty())
        .map(|ids| ids.into_iter().collect());
    let locations: Vec<Value> = list_work_locations(db, false)
        .await?
        .into_iter()
        .filter(|loc| {
            allowed
                .as_ref()
                .is_none_or(|allowed| allowed.contains(loc["id"].as_str().unwrap_or_default()))
        })
        .collect();
    if locations.is_empty() {
        return Err(HrError::Validation {
            message: "No work location is set up for you yet. Ask HR to add one.".to_owned(),
            details: Some(json!({ "code": "NO_WORK_LOCATION" })),
        });
    }
    let allowance = point
        .accuracy
        .unwrap_or(0.0)
        .max(0.0)
        .min(MAX_ACCURACY_ALLOWANCE_METERS);
    let mut ranked: Vec<(Value, f64)> = locations
        .into_iter()
        .map(|loc| {
            let distance = distance_meters(
                (point.latitude, point.longitude),
                (
                    loc["latitude"].as_f64().unwrap_or(f64::NAN),
                    loc["longitude"].as_f64().unwrap_or(f64::NAN),
                ),
            );
            (loc, distance)
        })
        .collect();
    ranked.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    let at = ranked.iter().find(|(loc, distance)| {
        distance - allowance <= loc["radiusMeters"].as_f64().unwrap_or(0.0)
    });
    let Some((at, _)) = at else {
        let (nearest, distance) = &ranked[0];
        let name = nearest["name"].as_str().unwrap_or_default();
        return Err(HrError::Validation {
            message: format!(
                "You are not at a work location. The nearest, {name}, is {} away.",
                format_distance(*distance)
            ),
            details: Some(json!({
                "code": "NOT_AT_WORK_LOCATION",
                "nearest": name,
                "distanceMeters": js_round(*distance),
            })),
        });
    };
    Ok(ClockPlace {
        location_id: at["id"].as_str().map(str::to_owned),
        latitude: Some(point.latitude),
        longitude: Some(point.longitude),
    })
}

/// `clockPlaceFor(db, employeeId, requiresLocation, point)`.
pub(crate) async fn clock_place_for(
    db: &PgPool,
    employee_id: &str,
    requires_location: bool,
    point: Option<GeoPoint>,
) -> Result<ClockPlace, HrError> {
    if !requires_location {
        return Ok(ClockPlace::default());
    }
    let ids: Option<Option<Value>> = sqlx::query_scalar(
        "select to_jsonb(work_location_ids) from hr_employees where id = $1 limit 1",
    )
    .bind(employee_id)
    .fetch_optional(db)
    .await?;
    let ids = ids.flatten().and_then(|ids| {
        ids.as_array().map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
    });
    resolve_clock_place(db, ids, point).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distances_and_their_text() {
        let amsterdam = (52.3676, 4.9041);
        let d = distance_meters(amsterdam, (52.3676, 4.9241));
        assert!((d - 1357.0).abs() < 5.0, "{d}");
        assert_eq!(format_distance(1379.4), "1.4 km");
        assert_eq!(format_distance(412.6), "413 m");
    }
}
