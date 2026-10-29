//! The Rust engine against answers from the TypeScript package
//! (`fixtures/permission-cases.json`, written by `pnpm rust:catalogs` from
//! `scripts/rust-permission-cases.ts`). Tables are cross products in loop
//! order; a row packs its innermost list into one string.
// The fakes answer synchronously; the trait is async for the database.
#![allow(clippy::unused_async_trait_impl, clippy::struct_field_names)]

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::LazyLock;

use serde::Deserialize;
use weldsuite_permissions::{
    AppCheckMode, AppPermissionCheck, Grants, MemberRow, PermissionQueries, ResolvedPermissions,
    check_app_permission, check_permission_grants, expand_wildcards, has_object_access,
    has_object_access_in_app, has_permission, is_grantable_permission_key, normalize_app_code,
    parse_permission_key, qualify_permission, resolve_effective_permissions, role_row_permissions,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cases {
    grants: Vec<Vec<String>>,
    required: Vec<String>,
    has_permission: Vec<String>,
    objects: Vec<String>,
    has_object_access: Vec<String>,
    expand_catalog: Vec<String>,
    expand_wildcards: Vec<Vec<String>>,
    keys: Vec<String>,
    parse: Vec<Parsed>,
    qualify: Vec<String>,
    normalize_inputs: Vec<String>,
    normalize: Vec<Option<String>>,
    apps: Vec<Option<String>>,
    denies: Vec<Option<Vec<String>>>,
    app_check: Vec<String>,
    object_access_in_app: Vec<String>,
    grantable_keys: Vec<String>,
    grantable: String,
    grantors: Vec<Grantor>,
    requested: Vec<Vec<String>>,
    already_granted: Vec<Vec<String>>,
    grant_checks: Vec<GrantCheck>,
    role_rows: Vec<RoleRow>,
    role_row_permissions: Vec<Vec<String>>,
    resolve: Resolve,
}

#[derive(Deserialize)]
struct Parsed {
    app: Option<String>,
    object: String,
    unqualified: String,
}

#[derive(Deserialize)]
struct Grantor {
    permissions: Vec<String>,
    #[serde(default)]
    denies: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantCheck {
    ok: bool,
    invalid: Vec<String>,
    not_held: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoleRow {
    is_system: bool,
    name: String,
    permissions: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct Resolve {
    db: Db,
    users: Vec<String>,
    results: Vec<Resolved>,
}

#[derive(Deserialize)]
struct Db {
    members: HashMap<String, Member>,
    roles: HashMap<String, Vec<String>>,
    teams: HashMap<String, Vec<Vec<String>>>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Member {
    id: String,
    role: String,
    role_id: Option<String>,
    permissions: Option<Vec<String>>,
    permission_denies: Option<Vec<String>>,
    member_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Resolved {
    permissions: Vec<String>,
    denies: Vec<String>,
    role: String,
    role_id: Option<String>,
    is_owner: bool,
}

static CASES: LazyLock<Cases> = LazyLock::new(|| {
    serde_json::from_str(include_str!("fixtures/permission-cases.json")).expect("fixture parses")
});

fn flags(values: impl Iterator<Item = bool>) -> String {
    values.map(|v| if v { 'y' } else { 'n' }).collect()
}

/// The fixture's encoding of one check: `ya:weldcrm`, `nx!`, `nw`.
fn encode(check: AppPermissionCheck) -> String {
    let mode = match check.mode {
        AppCheckMode::Workspace => 'w',
        AppCheckMode::App => 'a',
        AppCheckMode::AnyApp => 'x',
    };
    format!(
        "{}{mode}{}{}",
        if check.allowed { 'y' } else { 'n' },
        check.app.map(|app| format!(":{app}")).unwrap_or_default(),
        if check.object_not_in_app { "!" } else { "" },
    )
}

/// Every (grants, denies) subject in loop order.
fn subjects() -> impl Iterator<Item = Grants> {
    CASES.grants.iter().flat_map(|permissions| {
        CASES.denies.iter().map(|denies| Grants {
            permissions: permissions.clone(),
            denies: denies.clone().unwrap_or_default(),
        })
    })
}

#[test]
fn matching() {
    for (grants, expected) in CASES.grants.iter().zip(&CASES.has_permission) {
        let actual = flags(CASES.required.iter().map(|r| has_permission(grants, r)));
        assert_eq!(&actual, expected, "has_permission {grants:?}");
    }
    for (grants, expected) in CASES.grants.iter().zip(&CASES.has_object_access) {
        let actual = flags(CASES.objects.iter().map(|o| has_object_access(grants, o)));
        assert_eq!(&actual, expected, "has_object_access {grants:?}");
    }
    for (grants, expected) in CASES.grants.iter().zip(&CASES.expand_wildcards) {
        assert_eq!(
            &expand_wildcards(grants, &CASES.expand_catalog),
            expected,
            "expand_wildcards {grants:?}"
        );
    }
}

#[test]
fn keys_and_app_codes() {
    for (key, expected) in CASES.keys.iter().zip(&CASES.parse) {
        let parsed = parse_permission_key(key);
        assert_eq!(parsed.app, expected.app.as_deref(), "{key}");
        assert_eq!(parsed.object, expected.object, "{key}");
        assert_eq!(parsed.unqualified, expected.unqualified, "{key}");
    }
    let qualified: Vec<String> = CASES
        .keys
        .iter()
        .flat_map(|key| ["weldcrm", "weldhost"].map(|app| qualify_permission(key, app)))
        .collect();
    assert_eq!(qualified, CASES.qualify);
    for (input, expected) in CASES.normalize_inputs.iter().zip(&CASES.normalize) {
        assert_eq!(normalize_app_code(input), expected.as_deref(), "{input:?}");
    }
}

#[test]
fn app_checks() {
    let mut rows = CASES.app_check.iter();
    for subject in subjects() {
        for required in &CASES.required {
            let actual: Vec<String> = CASES
                .apps
                .iter()
                .map(|app| encode(check_app_permission(&subject, required, app.as_deref())))
                .collect();
            let expected = rows.next().expect("a row per case");
            assert_eq!(&actual.join(" "), expected, "{subject:?} {required}");
        }
    }
    assert!(rows.next().is_none());

    let mut rows = CASES.object_access_in_app.iter();
    for subject in subjects() {
        for object in &CASES.objects {
            let actual = flags(
                CASES
                    .apps
                    .iter()
                    .map(|app| has_object_access_in_app(&subject, object, app.as_deref())),
            );
            let expected = rows.next().expect("a row per case");
            assert_eq!(&actual, expected, "{subject:?} {object}");
        }
    }
    assert!(rows.next().is_none());
}

#[test]
fn grants() {
    let actual = flags(
        CASES
            .grantable_keys
            .iter()
            .map(|key| is_grantable_permission_key(key)),
    );
    assert_eq!(actual, CASES.grantable, "{:?}", CASES.grantable_keys);

    let mut checks = CASES.grant_checks.iter();
    for grantor in &CASES.grantors {
        let grantor = Grants {
            permissions: grantor.permissions.clone(),
            denies: grantor.denies.clone(),
        };
        for requested in &CASES.requested {
            for already in &CASES.already_granted {
                let actual = check_permission_grants(&grantor, requested, already);
                let expected = checks.next().expect("a check per case");
                assert_eq!(actual.ok, expected.ok, "{grantor:?} {requested:?}");
                assert_eq!(
                    actual.invalid, expected.invalid,
                    "{grantor:?} {requested:?}"
                );
                assert_eq!(
                    actual.not_held, expected.not_held,
                    "{grantor:?} {requested:?}"
                );
            }
        }
    }
    assert!(checks.next().is_none());
}

struct FixtureDb;

impl PermissionQueries for FixtureDb {
    type Error = Infallible;

    async fn get_member(&self, user_id: &str) -> Result<Option<MemberRow>, Infallible> {
        Ok(CASES
            .resolve
            .db
            .members
            .get(user_id)
            .cloned()
            .map(|m| MemberRow {
                id: m.id,
                role: m.role,
                role_id: m.role_id,
                permissions: m.permissions,
                permission_denies: m.permission_denies,
                member_type: m.member_type,
            }))
    }

    async fn get_role_permissions(&self, role_id: &str) -> Result<Option<Vec<String>>, Infallible> {
        Ok(CASES.resolve.db.roles.get(role_id).cloned())
    }

    async fn get_team_permissions(&self, member_id: &str) -> Result<Vec<Vec<String>>, Infallible> {
        Ok(CASES
            .resolve
            .db
            .teams
            .get(member_id)
            .cloned()
            .unwrap_or_default())
    }
}

#[tokio::test]
async fn resolution() {
    for (row, expected) in CASES.role_rows.iter().zip(&CASES.role_row_permissions) {
        assert_eq!(
            &role_row_permissions(row.is_system, &row.name, row.permissions.as_deref()),
            expected,
            "{}",
            row.name
        );
    }
    for (user, expected) in CASES.resolve.users.iter().zip(&CASES.resolve.results) {
        let actual = resolve_effective_permissions(&FixtureDb, user)
            .await
            .expect("infallible");
        let expected = ResolvedPermissions {
            permissions: expected.permissions.clone(),
            denies: expected.denies.clone(),
            role: expected.role.clone(),
            role_id: expected.role_id.clone(),
            is_owner: expected.is_owner,
        };
        assert_eq!(actual, expected, "{user}");
    }
}
