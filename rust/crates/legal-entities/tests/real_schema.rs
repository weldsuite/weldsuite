//! Legal entities against the real tenant schema (a database built from the
//! journaled migrations by `scripts/rust-test-db.ts`, as CI does): the ports
//! of `middleware.pglite.test.ts` and `lock.pglite.test.ts`, and a round trip
//! through the service.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.
//! The tenant database is shared with other crates' tests, so every row here
//! has an `_lert_` id, is removed before and after, and the scenarios run in
//! one test, one after another (the default entity is one per database).

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Request};
use axum::middleware::Next;
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use http::{Extensions, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use weldsuite_auth::AuthContext;
use weldsuite_db::{Keyring, Tenant, TenantPermissionQueries, WorkspaceRestrictions, master_pool};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::Field;
use weldsuite_legal_entities::schemas::RegistrationType;
use weldsuite_legal_entities::service::{
    self, CreateBankAccountInput, CreateLegalEntityInput, CreateRegistrationInput,
    ListLegalEntitiesOptions, RevealBankAccount, SetEntityMember, UpdateBankAccountInput,
    UpdateLegalEntityInput, UpdateRegistrationInput,
};
use weldsuite_legal_entities::{
    EntityRecordGuard, EntityTable, LegalEntityApp, LegalEntityContextOptions,
    LegalEntityErrorCode, RequestEntity, legal_entity_context, load_entity_access,
    record_in_request_entity, request_entity_scope,
};
use weldsuite_permissions::{PermissionGate, Permissions, resolve_effective_permissions};

const CLEANUP: &str = "
    delete from hr_pay_runs where id like '%\\_lert\\_%';
    delete from hr_payroll_employers where id like '%\\_lert\\_%';
    delete from fiscal_periods where id like '%\\_lert\\_%';
    delete from journal_entries where id like '%\\_lert\\_%';
    delete from accounting_entity_settings where entity_id like '%\\_lert\\_%';
    delete from legal_entity_members where entity_id like '%\\_lert\\_%' or user_id like '%\\_lert\\_%';
    delete from legal_entity_registrations where entity_id like '%\\_lert\\_%';
    delete from bank_accounts where entity_id like '%\\_lert\\_%';
    delete from tax_id_reveals where revealed_by like '%\\_lert\\_%';
    delete from entities where id like '%\\_lert\\_%';
    delete from workspace_members where id like '%\\_lert\\_%';
    delete from roles where id like '%\\_lert\\_%';
";

/// A 32-byte field key, hex.
const TEST_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

#[tokio::test]
async fn legal_entities_against_the_migrated_schema() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 4).expect("tenant pool");
    sqlx::raw_sql(CLEANUP).execute(&db).await.expect("cleanup");

    middleware_scenario(&db).await;
    lock_scenario(&db).await;
    let service_ids = service_scenario(&db).await;

    sqlx::raw_sql(CLEANUP).execute(&db).await.expect("cleanup");
    for id in &service_ids {
        sqlx::query("delete from legal_entity_registrations where entity_id = $1")
            .bind(id)
            .execute(&db)
            .await
            .expect("cleanup");
        sqlx::query("delete from bank_accounts where entity_id = $1")
            .bind(id)
            .execute(&db)
            .await
            .expect("cleanup");
        sqlx::query("delete from entities where id = $1")
            .bind(id)
            .execute(&db)
            .await
            .expect("cleanup");
    }
}

// ---------------------------------------------------------------------------
// middleware.pglite.test.ts
// ---------------------------------------------------------------------------

/// A router behind the test's session (the `x-user` header) and the
/// legal entity layer, with probes of what the layer settled.
fn probe_app(db: &PgPool, options: LegalEntityContextOptions) -> Router {
    let gate = Arc::new(PermissionGate::new(|extensions: &Extensions| {
        extensions
            .get::<Tenant>()
            .map(|tenant| TenantPermissionQueries::new(tenant.db.clone()))
            .ok_or_else(ApiError::internal)
    }));
    let db = db.clone();
    Router::new()
        .route(
            "/probe",
            get(
                |permissions: Permissions, entity: RequestEntity| async move {
                    Json(json!({
                        "entity": entity.entity_id(),
                        "permissions": permissions.resolved().permissions,
                        "scope": request_entity_scope(&entity),
                    }))
                },
            )
            .route_layer(gate.resolve()),
        )
        .route(
            "/record/{entity_id}",
            get(
                |Path(record): Path<String>, entity: RequestEntity| async move {
                    Json(json!({ "ok": record_in_request_entity(&entity, Some(&record)) }))
                },
            ),
        )
        .nest(
            "/journal",
            Router::new()
                .route("/{id}", get(|| async { "ok" }))
                .route_layer(
                    EntityRecordGuard::table(EntityTable::new("journal_entries"), "Journal entry")
                        .layer(),
                ),
        )
        .layer(legal_entity_context(&gate, options))
        .layer(axum::middleware::from_fn(
            move |mut request: Request, next: Next| {
                let db = db.clone();
                async move {
                    let user = request
                        .headers()
                        .get("x-user")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_owned();
                    request.extensions_mut().insert(AuthContext {
                        user_id: user,
                        org_id: None,
                        session_id: String::new(),
                        factor_verification_age: None,
                    });
                    request.extensions_mut().insert(Tenant {
                        workspace_id: "ws_lert".to_owned(),
                        clerk_org_id: None,
                        db,
                        suspended: false,
                        restrictions: WorkspaceRestrictions::default(),
                    });
                    next.run(request).await
                }
            },
        ))
}

async fn call(app: &Router, path: &str, user: &str, entity: Option<&str>) -> (StatusCode, Value) {
    let mut request = Request::builder().uri(path).header("x-user", user);
    if let Some(entity) = entity {
        request = request.header("x-legal-entity-id", entity);
    }
    let response: Response = app
        .clone()
        .oneshot(request.body(Body::empty()).expect("request"))
        .await
        .expect("infallible");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn middleware_scenario(db: &PgPool) {
    // The default entity is one per database: this scenario owns it.
    sqlx::query("update entities set is_default = false where is_default = true")
        .execute(db)
        .await
        .expect("no default");
    sqlx::raw_sql(
        "insert into roles (id, name, is_system, permissions) values
             ('role_lert_viewer', 'Books viewer', false, '[\"invoices:read\"]'),
             ('role_lert_owner', 'Owner', true, '[\"*\"]');
         insert into workspace_members (id, user_id, role, permissions, member_type) values
             ('wm_lert_member', 'u_lert_member', 'MEMBER', '[\"invoices:create\"]', 'INTERNAL'),
             ('wm_lert_admin', 'u_lert_admin', 'ADMIN', '[]', 'INTERNAL'),
             ('wm_lert_emp', 'u_lert_emp', 'MEMBER', '[]', 'EMPLOYEE');
         insert into entities (id, name, jurisdiction_code, base_currency, is_default, access_restricted) values
             ('ent_lert_open', 'Open', 'NL', 'EUR', true, false),
             ('ent_lert_secret', 'Secret', 'NL', 'EUR', false, true),
             ('ent_lert_role', 'Viewer here', 'NL', 'EUR', false, false);
         insert into legal_entity_members (id, entity_id, user_id, role_id) values
             ('lem_lert_1', 'ent_lert_role', 'u_lert_member', 'role_lert_viewer');
         insert into journal_entries (id, entity_id, date, status) values
             ('je_lert_role', 'ent_lert_role', '2026-01-15', 'draft');",
    )
    .execute(db)
    .await
    .expect("seed");

    let books = probe_app(db, LegalEntityContextOptions::new().scoped());
    let hr = probe_app(
        db,
        LegalEntityContextOptions::new()
            .scoped()
            .fallback_to_default(false),
    );

    // Resolves the named entity, and the default when none is named.
    assert_eq!(
        call(&books, "/probe", "u_lert_member", Some("ent_lert_open"))
            .await
            .1["entity"],
        "ent_lert_open"
    );
    assert_eq!(
        call(&books, "/probe", "u_lert_member", None).await.1["entity"],
        "ent_lert_open"
    );
    assert_eq!(
        call(&hr, "/probe", "u_lert_member", None).await.1["entity"],
        Value::Null
    );
    // `?entityId` and the old header name.
    assert_eq!(
        call(
            &books,
            "/probe?entityId=ent_lert_role",
            "u_lert_member",
            None
        )
        .await
        .1["entity"],
        "ent_lert_role"
    );

    // A restricted entity resolves to nothing for a member without a row,
    // never to the default.
    let (_, hidden) = call(&books, "/probe", "u_lert_member", Some("ent_lert_secret")).await;
    assert_eq!(hidden["entity"], Value::Null);
    assert_eq!(hidden["scope"], json!([]));
    assert_eq!(
        call(&books, "/probe", "u_lert_admin", Some("ent_lert_secret"))
            .await
            .1["entity"],
        "ent_lert_secret"
    );

    // The entity role is swapped in, keeping personal extras.
    let (_, in_role) = call(&books, "/probe", "u_lert_member", Some("ent_lert_role")).await;
    assert_eq!(in_role["entity"], "ent_lert_role");
    let role_permissions = in_role["permissions"]
        .as_array()
        .expect("permissions")
        .clone();
    assert!(role_permissions.contains(&json!("invoices:read")));
    assert!(role_permissions.contains(&json!("invoices:create")));
    let (_, open) = call(&books, "/probe", "u_lert_member", Some("ent_lert_open")).await;
    assert!(open["permissions"].as_array().expect("permissions").len() > role_permissions.len());

    // A non-uniform member only touches records acting with the same role.
    assert_eq!(
        call(
            &books,
            "/record/ent_lert_role",
            "u_lert_member",
            Some("ent_lert_role")
        )
        .await
        .1["ok"],
        true
    );
    assert_eq!(
        call(
            &books,
            "/record/ent_lert_role",
            "u_lert_member",
            Some("ent_lert_open")
        )
        .await
        .1["ok"],
        false
    );
    assert_eq!(
        call(
            &books,
            "/record/ent_lert_secret",
            "u_lert_member",
            Some("ent_lert_open")
        )
        .await
        .1["ok"],
        false
    );
    assert_eq!(
        call(
            &books,
            "/record/ent_lert_secret",
            "u_lert_admin",
            Some("ent_lert_open")
        )
        .await
        .1["ok"],
        true
    );

    // The record guard: 404 for a record of an entity acted in with another
    // role; unknown ids pass to the route.
    let (status, body) = call(
        &books,
        "/journal/je_lert_role",
        "u_lert_member",
        Some("ent_lert_open"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        body["error"]["message"],
        "Journal entry with ID 'je_lert_role' not found"
    );
    assert_eq!(
        call(
            &books,
            "/journal/je_lert_role",
            "u_lert_member",
            Some("ent_lert_role")
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &books,
            "/journal/je_lert_missing",
            "u_lert_member",
            Some("ent_lert_open")
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &books,
            "/journal/je_lert_role",
            "u_lert_admin",
            Some("ent_lert_open")
        )
        .await
        .0,
        StatusCode::OK
    );

    // A request without an entity spans where the member acts with the
    // workspace role (other tests' open entities may be listed too).
    let scope = call(&hr, "/probe", "u_lert_member", None).await.1["scope"].clone();
    let scope: Vec<&str> = scope
        .as_array()
        .expect("scope")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(scope.contains(&"ent_lert_open"));
    assert!(!scope.contains(&"ent_lert_role"));
    assert!(!scope.contains(&"ent_lert_secret"));
    assert_eq!(
        call(&hr, "/probe", "u_lert_admin", None).await.1["scope"],
        Value::Null
    );

    // The effective access inside an entity.
    let member_permissions =
        resolve_effective_permissions(&TenantPermissionQueries::new(db.clone()), "u_lert_member")
            .await
            .expect("resolve");
    let access = load_entity_access(db, "u_lert_member", member_permissions)
        .await
        .expect("access");
    let mine = service::my_effective_access(db, &access, "ent_lert_role")
        .await
        .expect("my access")
        .expect("visible");
    assert_eq!(
        serde_json::to_value(&mine).expect("json")["source"],
        "member"
    );
    assert_eq!(mine.role_id.as_deref(), Some("role_lert_viewer"));
    assert_eq!(mine.role_name.as_deref(), Some("Books viewer"));
    assert!(
        service::my_effective_access(db, &access, "ent_lert_secret")
            .await
            .expect("query")
            .is_none()
    );

    // setEntityMember refuses the Owner role, unknown roles and Employee members.
    let refused = |result: Result<_, weldsuite_legal_entities::LegalEntityError>| {
        result.err().and_then(|error| error.code()) == Some(LegalEntityErrorCode::BadRequest)
    };
    let member =
        |user: &'static str, role: Option<&'static str>, entity: &'static str| SetEntityMember {
            entity_id: entity,
            user_id: user,
            role_id: role,
            granted_by: "u_lert_admin",
        };
    assert!(refused(
        service::set_entity_member(
            db,
            member("u_lert_member", Some("role_lert_owner"), "ent_lert_open")
        )
        .await
    ));
    assert!(refused(
        service::set_entity_member(
            db,
            member("u_lert_member", Some("role_lert_missing"), "ent_lert_open")
        )
        .await
    ));
    assert!(refused(
        service::set_entity_member(db, member("u_lert_emp", None, "ent_lert_open")).await
    ));
    assert!(refused(
        service::set_entity_member(db, member("u_lert_nobody", None, "ent_lert_open")).await
    ));

    // Adds a member and then changes their role.
    let first = service::set_entity_member(db, member("u_lert_member", None, "ent_lert_secret"))
        .await
        .expect("added");
    assert!(first.created);
    let second = service::set_entity_member(
        db,
        member("u_lert_member", Some("role_lert_viewer"), "ent_lert_secret"),
    )
    .await
    .expect("changed");
    assert!(!second.created);
    assert_eq!(second.member.role_id.as_deref(), Some("role_lert_viewer"));

    let list = service::get_entity_access_list(db, "ent_lert_secret")
        .await
        .expect("list");
    assert_eq!(list.members.len(), 1);
    assert_eq!(list.members[0].role_name.as_deref(), Some("Books viewer"));
    assert_eq!(list.members[0].workspace_role, "MEMBER");
    assert_eq!(
        list.members[0].workspace_role_name.as_deref(),
        Some("Member")
    );
    assert!(list.restricted);
    let removed = service::remove_entity_member(db, "ent_lert_secret", "u_lert_member")
        .await
        .expect("removed");
    assert_eq!(removed.map(|row| row.id), Some(second.member.id));

    // Listing filters to what the member sees.
    let visible =
        service::list_legal_entities(db, Some(&access), ListLegalEntitiesOptions::default())
            .await
            .expect("list");
    let ids: Vec<&str> = visible.iter().map(|entity| entity.id.as_str()).collect();
    assert_eq!(
        ids.first(),
        Some(&"ent_lert_open"),
        "the default comes first"
    );
    assert!(ids.contains(&"ent_lert_role"));
    assert!(!ids.contains(&"ent_lert_secret"));
    let with_role = visible
        .iter()
        .find(|entity| entity.id == "ent_lert_role")
        .expect("role entity");
    let my_access = serde_json::to_value(with_role).expect("json")["myAccess"].clone();
    assert_eq!(
        my_access,
        json!({ "source": "member", "roleId": "role_lert_viewer", "roleName": "Books viewer" })
    );
    assert_eq!(
        serde_json::to_value(with_role).expect("json")["enabledApps"],
        json!(["weldhr"])
    );
}

// ---------------------------------------------------------------------------
// lock.pglite.test.ts
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn lock_scenario(db: &PgPool) {
    sqlx::raw_sql(
        "insert into entities (id, name, jurisdiction_code, base_currency, fiscal_year_start) values
             ('ent_lert_books', 'Books BV', 'NL', 'EUR', 1),
             ('ent_lert_periods', 'Periods BV', 'NL', 'EUR', 1),
             ('ent_lert_hr', 'Payroll BV', 'NL', 'EUR', 1),
             ('ent_lert_off', 'No books BV', 'NL', 'EUR', 1);
         insert into accounting_entity_settings (entity_id) values ('ent_lert_books'), ('ent_lert_periods');
         insert into journal_entries (id, entity_id, date, status) values
             ('je_lert_1', 'ent_lert_books', '2026-01-15', 'posted'),
             ('je_lert_2', 'ent_lert_off', '2026-01-15', 'posted');
         insert into fiscal_periods (id, entity_id, name, type, start_date, end_date) values
             ('fp_lert_1', 'ent_lert_periods', '2026', 'year', '2026-01-01', '2026-12-31');
         insert into hr_payroll_employers (id, name, legal_name, country, currency, legal_entity_id) values
             ('emp_lert_1', 'Payroll BV', 'Payroll BV', 'NL', 'EUR', 'ent_lert_hr');
         insert into hr_pay_runs (id, employer_id, country, currency, period_start, period_end, pay_date, tax_year, period_number) values
             ('run_lert_1', 'emp_lert_1', 'NL', 'EUR', '2026-01-01', '2026-01-31', '2026-01-25', 2026, 1);",
    )
    .execute(db)
    .await
    .expect("seed");

    let conflict = |result: Result<_, weldsuite_legal_entities::LegalEntityError>| {
        result.err().and_then(|error| error.code()) == Some(LegalEntityErrorCode::Conflict)
    };

    // A new country or currency once WeldBooks has postings.
    let country = UpdateLegalEntityInput {
        jurisdiction_code: Some("BE".to_owned()),
        ..Default::default()
    };
    let Err(error) = service::update_legal_entity(db, "ent_lert_books", &country).await else {
        panic!("locked");
    };
    assert_eq!(
        error.message(),
        "The country of this legal entity can no longer be changed because WeldBooks has posted transactions for it. Create a new legal entity instead."
    );
    let currency = UpdateLegalEntityInput {
        base_currency: Some("USD".to_owned()),
        ..Default::default()
    };
    assert!(conflict(
        service::update_legal_entity(db, "ent_lert_books", &currency).await
    ));
    let fiscal = UpdateLegalEntityInput {
        fiscal_year_start: Some(4),
        ..Default::default()
    };
    assert!(conflict(
        service::update_legal_entity(db, "ent_lert_books", &fiscal).await
    ));

    // The same value in another case, and every other field.
    let renamed = service::update_legal_entity(
        db,
        "ent_lert_books",
        &UpdateLegalEntityInput {
            jurisdiction_code: Some("nl".to_owned()),
            name: Some("Books B.V.".to_owned()),
            ..Default::default()
        },
    )
    .await
    .expect("allowed");
    assert_eq!(renamed.name, "Books B.V.");

    // The fiscal year freezes once fiscal periods exist, but not the country.
    let Err(error) = service::update_legal_entity(
        db,
        "ent_lert_periods",
        &UpdateLegalEntityInput {
            fiscal_year_start: Some(7),
            ..Default::default()
        },
    )
    .await
    else {
        panic!("locked");
    };
    assert_eq!(
        error.message(),
        "The fiscal year of this legal entity can no longer be changed because WeldBooks has generated fiscal periods for it."
    );
    let usd = service::update_legal_entity(db, "ent_lert_periods", &currency)
        .await
        .expect("allowed");
    assert_eq!(usd.base_currency, "USD");

    // A new country or currency once WeldHR has pay runs.
    let Err(error) = service::update_legal_entity(db, "ent_lert_hr", &currency).await else {
        panic!("locked");
    };
    assert_eq!(
        error.message(),
        "The base currency of this legal entity can no longer be changed because WeldHR has pay runs for it. Create a new legal entity instead."
    );
    let moved = service::update_legal_entity(db, "ent_lert_hr", &fiscal)
        .await
        .expect("allowed");
    assert_eq!(moved.fiscal_year_start, Some(4));

    // Data of an app that is not enabled for the entity does not lock it.
    let off = service::update_legal_entity(db, "ent_lert_off", &country)
        .await
        .expect("allowed");
    assert_eq!(off.jurisdiction_code, "BE");

    // Usage and delete: WeldHR holds data for the HR entity.
    let usage = service::legal_entity_usage(db, "ent_lert_hr")
        .await
        .expect("usage");
    assert_eq!(
        serde_json::to_value(&usage).expect("json"),
        json!([
            { "app": "weldbooks", "enabled": false, "hasData": false },
            { "app": "weldhr", "enabled": true, "hasData": true },
        ])
    );
    let Err(error) = service::delete_legal_entity(db, "ent_lert_hr").await else {
        panic!("in use");
    };
    assert_eq!(
        error.message(),
        "This legal entity still has data in weldhr; archive it instead"
    );
    // The default cannot be archived or deleted.
    assert!(conflict(
        service::set_legal_entity_archived(db, "ent_lert_open", true).await
    ));
    assert!(conflict(
        service::delete_legal_entity(db, "ent_lert_open").await
    ));
}

// ---------------------------------------------------------------------------
// The service, round trip
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_lines)] // one scenario, step by step
async fn service_scenario(db: &PgPool) -> Vec<String> {
    let mut created = Vec::new();
    let input = CreateLegalEntityInput {
        name: "Service BV".to_owned(),
        jurisdiction_code: "NL".to_owned(),
        base_currency: "EUR".to_owned(),
        branding: Field::Null,
        ..Default::default()
    };
    let row = service::create_legal_entity(db, &input)
        .await
        .expect("created");
    created.push(row.id.clone());
    // Another entity is the default, so this one is not; NL defaults.
    assert_eq!(row.is_default, Some(false));
    assert_eq!(row.locale, "nl-NL");
    assert_eq!(row.timezone.as_deref(), Some("Europe/Amsterdam"));
    assert_eq!(row.fiscal_year_start, Some(1), "the column default");
    assert_eq!(row.branding, json!({}));
    let entity = service::get_legal_entity(db, &row.id, None)
        .await
        .expect("query")
        .expect("live");
    assert_eq!(
        serde_json::to_value(&entity).expect("json")["branding"],
        Value::Null
    );
    assert!(
        serde_json::to_value(&entity)
            .expect("json")
            .get("myAccess")
            .is_none()
    );

    // Registrations: the first VAT number becomes the primary and is mirrored.
    let vat = service::create_registration(
        db,
        &row.id,
        &CreateRegistrationInput::new(RegistrationType::Vat, "nl 1234.56789.b01"),
    )
    .await
    .expect("vat");
    assert!(vat.is_primary);
    assert_eq!(vat.number, "NL123456789B01");
    assert_eq!(vat.country.as_deref(), Some("NL"));
    let Err(error) = service::create_registration(
        db,
        &row.id,
        &CreateRegistrationInput::new(RegistrationType::Rsin, "12"),
    )
    .await
    else {
        panic!("bad format");
    };
    assert_eq!(error.code(), Some(LegalEntityErrorCode::BadRequest));
    assert_eq!(error.message(), "An RSIN has nine digits");
    let second = service::create_registration(
        db,
        &row.id,
        &CreateRegistrationInput {
            is_primary: Some(true),
            ..CreateRegistrationInput::new(RegistrationType::Vat, "NL999999999B01")
        },
    )
    .await
    .expect("second vat");
    assert!(second.is_primary);
    let primary = service::get_registration(db, &row.id, RegistrationType::Vat, None)
        .await
        .expect("query")
        .expect("primary");
    assert_eq!(primary.id, second.id);
    let tax_identifiers: Value =
        sqlx::query_scalar("select tax_identifiers from entities where id = $1")
            .bind(&row.id)
            .fetch_one(db)
            .await
            .expect("mirror");
    assert_eq!(tax_identifiers, json!({ "vatNumber": "NL999999999B01" }));
    let renumbered = service::update_registration(
        db,
        &row.id,
        &vat.id,
        &UpdateRegistrationInput {
            number: Some("NL111111111B01".to_owned()),
            label: Field::Set("Old".to_owned()),
            ..Default::default()
        },
    )
    .await
    .expect("updated");
    assert_eq!(renumbered.label.as_deref(), Some("Old"));
    assert!(!renumbered.is_primary);
    service::delete_registration(db, &row.id, &second.id)
        .await
        .expect("deleted");
    let left = service::list_registrations(db, &row.id)
        .await
        .expect("list");
    assert_eq!(left.len(), 1);
    let tax_identifiers: Value =
        sqlx::query_scalar("select tax_identifiers from entities where id = $1")
            .bind(&row.id)
            .fetch_one(db)
            .await
            .expect("mirror");
    assert_eq!(tax_identifiers, json!({}));
    let Err(missing) = service::delete_registration(db, &row.id, "ler_lert_missing").await else {
        panic!("missing");
    };
    assert_eq!(missing.message(), "Registration not found");

    // Bank accounts: the number is sealed and only its last four come back.
    let keyring = Keyring {
        v1: None,
        v2: Some(TEST_KEY.to_owned()),
    };
    let Err(no_key) = service::create_bank_account(
        db,
        &Keyring::default(),
        &row.id,
        &CreateBankAccountInput {
            name: "Main".to_owned(),
            account_number: Field::Set("123456789".to_owned()),
            ..Default::default()
        },
    )
    .await
    else {
        panic!("no key");
    };
    assert_eq!(no_key.code(), Some(LegalEntityErrorCode::NoEncryptionKey));
    let account = service::create_bank_account(
        db,
        &keyring,
        &row.id,
        &CreateBankAccountInput {
            name: "Main".to_owned(),
            iban: Field::Set(String::new()),
            account_number: Field::Set("123456789".to_owned()),
            is_default: Some(true),
            ..Default::default()
        },
    )
    .await
    .expect("account");
    let shape = serde_json::to_value(&account).expect("json");
    assert_eq!(shape["accountNumberLast4"], "6789");
    assert_eq!(shape["hasAccountNumber"], true);
    assert_eq!(shape["iban"], Value::Null);
    assert_eq!(shape["accountHolderName"], "Service BV");
    assert_eq!(shape["currency"], "EUR");
    assert_eq!(shape["inWeldbooks"], false);
    assert!(shape.get("accountNumberEncrypted").is_none());
    let revealed = service::reveal_bank_account_number(
        db,
        &keyring,
        RevealBankAccount {
            entity_id: &row.id,
            account_id: &account.id,
            user_id: "u_lert_admin",
            reason: Some("audit"),
        },
    )
    .await
    .expect("revealed");
    assert_eq!(revealed.account_number, "123456789");
    let reveals: i64 = sqlx::query_scalar(
        "select count(*) from tax_id_reveals where subject_id = $1 and field = 'account_number'",
    )
    .bind(&account.id)
    .fetch_one(db)
    .await
    .expect("log");
    assert_eq!(reveals, 1);
    let cleared = service::update_bank_account(
        db,
        &keyring,
        &row.id,
        &account.id,
        &UpdateBankAccountInput {
            account_number: Field::Null,
            ..Default::default()
        },
    )
    .await
    .expect("cleared");
    assert!(!cleared.has_account_number);
    assert_eq!(cleared.account_number_last4, None);
    let Err(error) = service::update_bank_account(
        db,
        &keyring,
        "ent_lert_open",
        &account.id,
        &UpdateBankAccountInput::default(),
    )
    .await
    else {
        panic!("another entity's account");
    };
    assert_eq!(error.message(), "Bank account not found");
    service::delete_bank_account(db, &row.id, &account.id)
        .await
        .expect("deleted");
    let remaining = service::list_bank_accounts(db, &row.id)
        .await
        .expect("list");
    assert_eq!(remaining.len(), 0);

    // Restricting and archiving.
    let restricted = service::set_entity_restricted(db, &row.id, true)
        .await
        .expect("restricted");
    assert!(restricted.access_restricted);
    let archived = service::set_legal_entity_archived(db, &row.id, true)
        .await
        .expect("archived");
    assert_eq!(archived.is_active, Some(false));
    let Err(error) = service::set_default_legal_entity(db, &row.id).await else {
        panic!("archived");
    };
    assert_eq!(
        error.message(),
        "An archived legal entity cannot be the default"
    );
    let active = service::list_legal_entities(db, None, ListLegalEntitiesOptions::default())
        .await
        .expect("list");
    assert!(!active.iter().any(|entity| entity.id == row.id));
    let all = service::list_legal_entities(
        db,
        None,
        ListLegalEntitiesOptions {
            app: Some(LegalEntityApp::Weldhr),
            include_archived: true,
        },
    )
    .await
    .expect("list");
    assert!(all.iter().any(|entity| entity.id == row.id));
    service::delete_legal_entity(db, &row.id)
        .await
        .expect("deleted");
    assert!(
        service::get_legal_entity(db, &row.id, None)
            .await
            .expect("query")
            .is_none()
    );

    created
}
