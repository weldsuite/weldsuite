//! `/api/fiscal-documents` (`routes/fiscal-documents/index.ts`, services
//! `br-fiscal/fiscal-documents`): the NF-e / NFS-e of invoices and credit
//! notes through Focus NFe, and the entity's fiscal settings.
//!
//! One row per attempt: written `processing` before the payload is sent (an
//! early webhook finds it); a rejection keeps it `rejected`, a network
//! failure `error`, which the next attempt asks Focus about first.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::compliance::get_contact_vat_number;
use weldsuite_books_domain::document_posting::load_tax_rates;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, created, now, now_ms, ok, paged, reply, validate,
};
use weldsuite_books_domain::js;
use weldsuite_books_domain::jurisdictions::br::{profile_of, regime_of};
use weldsuite_books_domain::jurisdictions::br_tax::compute_document_taxes;
use weldsuite_books_domain::tables::{FISCAL_DOCUMENTS, INVOICE_ITEMS, INVOICES, PARTIES};
use weldsuite_books_domain::tax::{
    Counterparty as HookCounterparty, Direction, HookContext, HookLine,
};
use weldsuite_catalogs::entity_events::{
    ACCOUNTING_ENTITY_UPDATED, FISCAL_DOCUMENT_CANCELLED, FISCAL_DOCUMENT_CREATED,
    FISCAL_DOCUMENT_UPDATED,
};
use weldsuite_db::Keyring;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::OutboundHttp;

use super::focus::{Focus, ProviderError, access_key_of, base_url, map_status};
use super::payload::{self, Args, Counterparty, Document, Issuer, Line, Taxes};
use super::settings::{
    ENVIRONMENTS, RegisterError, WEBHOOK_EVENTS, client_for, credential, environment_of,
    read_credentials, register_webhooks, remove_webhooks, seal_credentials, settings_of,
};
use super::{FiscalError, page_of, require_entity, require_fiscal_entity, str_of};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/settings",
            get(get_settings).route_layer(need("accounts:read")),
        )
        .route(
            "/settings",
            put(put_settings).route_layer(need("accounts:update")),
        )
        .route("/", get(list).route_layer(need("invoices:read")))
        .route("/{id}", get(detail).route_layer(need("invoices:read")))
        .route("/issue", post(issue).route_layer(need("invoices:update")))
        .route(
            "/{id}/refresh",
            post(refresh).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/cancel",
            post(cancel).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/correction",
            post(correction).route_layer(need("invoices:update")),
        )
        .with_state(state)
}

fn text(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// The fiscal answer of a route: a [`FiscalError`] as `fiscalErrorResponse`
/// answers it, anything else as the route's `catch`.
fn fiscal_reply(result: Result<Response, FiscalError>, fallback: &str) -> Response {
    reply(result.map_err(FiscalError::refusal), fallback)
}

/// The request's origin (`new URL(c.req.url).origin`).
pub(crate) fn request_origin(caller: &Caller) -> String {
    let header = |name: &str| {
        caller
            .header(name)
            .and_then(|value| value.split(',').next())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let host = header("x-forwarded-host")
        .or_else(|| header("host"))
        .unwrap_or_else(|| "localhost".into());
    let scheme = header("x-forwarded-proto").unwrap_or_else(|| "http".into());
    let host = match (scheme.as_str(), host.rsplit_once(':')) {
        ("http", Some((name, "80"))) | ("https", Some((name, "443"))) => name.to_owned(),
        _ => host.clone(),
    };
    format!("{scheme}://{}", host.to_ascii_lowercase())
}

// ── settings ────────────────────────────────────────────────────────────────

/// `settingsPayload(entity, env)`.
fn settings_payload(entity: &Value, keyring: &Keyring) -> Result<Map<String, Value>, FiscalError> {
    let settings = settings_of(entity);
    let environment = environment_of(&settings);
    let (credentials, readable) = match read_credentials(entity, keyring) {
        Ok(credentials) => (credentials, true),
        Err(FiscalError::Document { .. }) => (Vec::new(), false),
        Err(other) => return Err(other),
    };
    let webhook = settings
        .get("fiscalWebhook")
        .and_then(|w| w.get(environment))
        .filter(|w| w.is_object());
    let hooks: Vec<Value> = webhook
        .and_then(|w| w.get("hooks"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let get_or_null = |key: &str| settings.get(key).cloned().unwrap_or(Value::Null);
    let mut out = Map::new();
    out.insert("entityId".into(), entity["id"].clone());
    out.insert("provider".into(), json!("focus_nfe"));
    out.insert("environment".into(), json!(environment));
    out.insert("environments".into(), json!(ENVIRONMENTS));
    out.insert(
        "hasCredentials".into(),
        json!(credential(&credentials, environment).is_some_and(|t| !t.is_empty())),
    );
    out.insert(
        "credentialEnvironments".into(),
        json!(
            ENVIRONMENTS
                .iter()
                .filter(|e| credential(&credentials, e).is_some_and(|t| !t.is_empty()))
                .collect::<Vec<_>>()
        ),
    );
    out.insert("credentialsReadable".into(), json!(readable));
    out.insert(
        "nfseStandard".into(),
        settings
            .get("nfseStandard")
            .cloned()
            .filter(|v| !v.is_null())
            .unwrap_or_else(|| json!("nacional")),
    );
    out.insert("dpsSeries".into(), get_or_null("dpsSeries"));
    out.insert("simplesCreditRate".into(), get_or_null("simplesCreditRate"));
    out.insert(
        "codigoTributarioMunicipio".into(),
        get_or_null("codigoTributarioMunicipio"),
    );
    out.insert(
        "webhook".into(),
        json!({
            "registered": !hooks.is_empty(),
            "events": hooks.iter().map(|h| h["event"].clone()).collect::<Vec<_>>(),
            "supportedEvents": WEBHOOK_EVENTS,
            "registeredAt": webhook.and_then(|w| w.get("registeredAt")).cloned().unwrap_or(Value::Null),
        }),
    );
    out.insert("providerUrl".into(), json!(base_url(environment)));
    Ok(out)
}

async fn get_settings(caller: Caller, State(state): State<BooksState>) -> Response {
    fiscal_reply(
        async {
            let entity = require_entity(&caller).await?;
            Ok(ok(Value::Object(settings_payload(
                &entity,
                &caller.keyring(&state),
            )?)))
        }
        .await,
        "Failed to fetch the fiscal settings",
    )
}

/// `updateSettingsSchema`.
struct SettingsBody {
    environment: String,
    token: weldsuite_kit::validation::Field<String>,
    nfse_standard: Option<String>,
    updates: Vec<(&'static str, weldsuite_kit::validation::Field<Value>)>,
}

fn read_settings(issues: &mut Issues, body: &Map<String, Value>) -> SettingsBody {
    use weldsuite_kit::validation::Field;
    let environment = issues
        .choice(
            body,
            "environment",
            Presence::Required,
            &["homologacao", "producao"],
        )
        .into_option()
        .unwrap_or_default();
    let token = issues.text_with(
        body,
        "token",
        Presence::Nullish,
        Text::trimmed(Some(8), Some(200)),
    );
    let nfse_standard = issues
        .choice(
            body,
            "nfseStandard",
            Presence::Optional,
            &["nacional", "municipal"],
        )
        .into_option();
    let to_value = |field: Field<f64>| match field {
        Field::Set(v) => Field::Set(js::number_value(v)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    };
    let dps = issues.number(
        body,
        "dpsSeries",
        Presence::Nullish,
        Number {
            int: true,
            min: Some(1.0),
            max: Some(49_999.0),
            ..Number::default()
        },
    );
    let credit = issues.number(
        body,
        "simplesCreditRate",
        Presence::Nullish,
        Number {
            min: Some(0.0),
            max: Some(20.0),
            ..Number::default()
        },
    );
    let code = match issues.text_with(
        body,
        "codigoTributarioMunicipio",
        Presence::Nullish,
        Text::trimmed(None, Some(20)),
    ) {
        Field::Set(v) => Field::Set(json!(v)),
        Field::Null => Field::Null,
        Field::Absent => Field::Absent,
    };
    SettingsBody {
        environment,
        token,
        nfse_standard,
        updates: vec![
            ("dpsSeries", to_value(dps)),
            ("simplesCreditRate", to_value(credit)),
            ("codigoTributarioMunicipio", code),
        ],
    }
}

async fn put_settings(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_settings) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update the fiscal settings"),
    };
    fiscal_reply(
        update_settings(&caller, &state, data).await,
        "Failed to update the fiscal settings",
    )
}

#[allow(clippy::too_many_lines)] // the route's steps, in order
async fn update_settings(
    caller: &Caller,
    state: &BooksState,
    data: SettingsBody,
) -> Result<Response, FiscalError> {
    use weldsuite_kit::validation::Field;
    let db = &caller.db;
    let keyring = caller.keyring(state);
    let entity = require_entity(caller).await?;
    let entity_id = entity["id"].as_str().unwrap_or_default().to_owned();
    let settings = settings_of(&entity);
    let previous_environment = environment_of(&settings);
    let environment = data.environment.clone();

    let mut credentials = match read_credentials(&entity, &keyring) {
        Ok(credentials) => credentials,
        Err(FiscalError::Document { .. }) if !data.token.is_absent() => Vec::new(),
        Err(other) => return Err(other),
    };
    let mut next = settings.clone();
    next.insert("fiscalProvider".into(), json!("focus_nfe"));
    next.insert("fiscalEnvironment".into(), json!(environment));
    if let Some(standard) = &data.nfse_standard {
        next.insert("nfseStandard".into(), json!(standard));
    }
    for (key, value) in &data.updates {
        match value {
            Field::Null => {
                next.remove(*key);
            }
            Field::Set(v) if v.as_str() == Some("") => {
                next.remove(*key);
            }
            Field::Set(v) => {
                next.insert((*key).to_owned(), v.clone());
            }
            Field::Absent => {}
        }
    }
    let previous_hook = settings
        .get("fiscalWebhook")
        .and_then(|w| w.get(&environment))
        .cloned();
    let mut warnings: Vec<String> = Vec::new();
    let mut webhook_url: Option<String> = None;
    let http = caller.http(state);
    let cache = caller.cache(state);

    match &data.token {
        Field::Set(token) => {
            let client = Focus::new(token, &environment, http.clone());
            // The hooks list doubles as the check that Focus accepts the token.
            if let Err(error) = client.list_hooks().await {
                if error.is_auth_failure() {
                    return Err(FiscalError::bad(
                        "Focus NFe rejected this token. Copy the company token of the matching environment.",
                    ));
                }
                return Err(error.into());
            }
            set_credential(&mut credentials, &environment, token);
            let Some(org_id) = caller.org_id.clone() else {
                return Err(Refusal::from(ApiError::org_required()).into());
            };
            let base = caller
                .env(state, "BOOKS_API_URL")
                .filter(|u| !u.is_empty())
                .map_or_else(|| request_origin(caller), str::to_owned);
            match register_webhooks(
                &client,
                cache.as_ref(),
                &org_id,
                &entity_id,
                &environment,
                &base,
                previous_hook.as_ref(),
            )
            .await
            {
                Ok(registered) => {
                    let mut hooks = settings
                        .get("fiscalWebhook")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    hooks.insert(environment.clone(), registered.config);
                    next.insert("fiscalWebhook".into(), Value::Object(hooks));
                    webhook_url = Some(registered.url);
                    warnings.extend(
                        registered
                            .failures
                            .iter()
                            .map(|f| format!("Webhook not registered for {f}")),
                    );
                }
                Err(RegisterError::Provider(error)) => warnings.push(format!(
                    "The webhooks could not be registered ({}). Use refresh on a document to fetch its status.",
                    error.detail()
                )),
                Err(RegisterError::Fiscal(error)) => return Err(error),
            }
        }
        Field::Null => {
            let client = match client_for(&entity, &keyring, &environment, http.clone()) {
                Ok(client) => Some(client),
                Err(FiscalError::Document { .. }) => None,
                Err(other) => return Err(other),
            };
            remove_webhooks(client.as_ref(), cache.as_ref(), previous_hook.as_ref()).await?;
            credentials.retain(|(env, _)| *env != environment);
            let mut remaining = settings
                .get("fiscalWebhook")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            remaining.remove(&environment);
            next.insert("fiscalWebhook".into(), Value::Object(remaining));
        }
        Field::Absent => {}
    }

    let changed = !data.token.is_absent();
    let sealed = if changed {
        Some(seal_credentials(&credentials, &keyring)?)
    } else {
        None
    };
    sqlx::query(
        "update entities set jurisdiction_settings = $1, \
         fiscal_credentials_encrypted = case when $2 then $3 else fiscal_credentials_encrypted end, \
         updated_at = $4::timestamp where id = $5",
    )
    .bind(Value::Object(next.clone()))
    .bind(changed)
    .bind(sealed.clone().flatten())
    .bind(now())
    .bind(&entity_id)
    .execute(db)
    .await?;

    let mut changes = Map::new();
    changes.insert(
        "fiscalEnvironment".into(),
        change(json!(previous_environment), json!(environment)),
    );
    changes.insert(
        "fiscalCredentialsChanged".into(),
        change(Value::Null, json!(changed)),
    );
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "accounting_entity",
            entity_id: &entity_id,
            action: "fiscal_settings",
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        ACCOUNTING_ENTITY_UPDATED,
        &entity_id,
        json!({ "id": entity_id, "fiscalEnvironment": environment }),
    );

    let mut updated = entity.clone();
    if let Value::Object(map) = &mut updated {
        map.insert("jurisdictionSettings".into(), Value::Object(next));
        if let Some(sealed) = sealed {
            map.insert("fiscalCredentialsEncrypted".into(), json!(sealed));
        }
    }
    let mut body = settings_payload(&updated, &keyring)?;
    body.insert("webhookUrl".into(), json!(webhook_url));
    body.insert("warnings".into(), json!(warnings));
    Ok(ok(Value::Object(body)))
}

fn set_credential(credentials: &mut Vec<(String, String)>, environment: &str, token: &str) {
    if let Some(entry) = credentials.iter_mut().find(|(env, _)| env == environment) {
        token.clone_into(&mut entry.1);
    } else {
        credentials.push((environment.to_owned(), token.to_owned()));
    }
}

// ── reading ─────────────────────────────────────────────────────────────────

/// `documentSummary(doc)`: without the payloads.
fn summary(mut doc: Value) -> Value {
    if let Value::Object(map) = &mut doc {
        map.remove("requestPayload");
        map.remove("responsePayload");
    }
    doc
}

async fn list(caller: Caller) -> Response {
    let q = caller.query();
    let (page, size) = page_of(&q);
    reply(
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Ok(paged(Vec::new(), 0, false, None));
            };
            let filter = |key: &str| q.present(key).map(str::to_owned);
            let (source_type, source_id, status, kind) =
                (filter("sourceType"), filter("sourceId"), filter("status"), filter("kind"));
            let rows: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                weldsuite_books_domain::books_row!(fiscal_documents),
                " from fiscal_documents t where t.entity_id = $1 \
                 and ($2::text is null or t.source_type = $2) and ($3::text is null or t.source_id = $3) \
                 and ($4::text is null or t.status = $4) and ($5::text is null or t.kind = $5) \
                 order by t.created_at desc limit $6 offset $7"
            ))
            .bind(&entity_id)
            .bind(&source_type)
            .bind(&source_id)
            .bind(&status)
            .bind(&kind)
            .bind(size)
            .bind((page - 1) * size)
            .fetch_all(&caller.db)
            .await?;
            let total: i64 = sqlx::query_scalar(
                "select count(*)::int8 from fiscal_documents where entity_id = $1 \
                 and ($2::text is null or source_type = $2) and ($3::text is null or source_id = $3) \
                 and ($4::text is null or status = $4) and ($5::text is null or kind = $5)",
            )
            .bind(&entity_id)
            .bind(&source_type)
            .bind(&source_id)
            .bind(&status)
            .bind(&kind)
            .fetch_one(&caller.db)
            .await?;
            let rows = FISCAL_DOCUMENTS
                .js_rows(rows)
                .into_iter()
                .map(summary)
                .collect();
            Ok(paged(rows, total, page * size < total, None))
        }
        .await,
        "Failed to fetch fiscal documents",
    )
}

/// `getFiscalDocument(db, entityId, id)`.
pub(crate) async fn get_document(
    db: &PgPool,
    entity_id: &str,
    id: &str,
) -> Result<Value, FiscalError> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(fiscal_documents),
        " from fiscal_documents t where t.id = $1 and t.entity_id = $2 limit 1"
    ))
    .bind(id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|row| FISCAL_DOCUMENTS.js(row))
        .ok_or_else(|| FiscalError::status("Fiscal document not found", 404, None))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    fiscal_reply(
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Err(Refusal::not_found("Fiscal document", &id).into());
            };
            Ok(ok(get_document(&caller.db, &entity_id, &id).await?))
        }
        .await,
        "Failed to fetch the fiscal document",
    )
}

// ── what a Focus answer changes ─────────────────────────────────────────────

fn error_messages(data: &Value) -> Vec<String> {
    let mut messages = Vec::new();
    if let Some(sefaz) = str_of(data.get("mensagem_sefaz")) {
        messages.push(sefaz);
    }
    if let Some(Value::Array(items)) = data.get("erros") {
        for item in items {
            if let Some(text) = str_of(item.get("mensagem"))
                && !messages.contains(&text)
            {
                messages.push(text);
            }
        }
    }
    messages
}

const ECHOED_KEYS: [&str; 3] = [
    "requisicao_nota_fiscal",
    "requisicao_cancelamento",
    "requisicao_carta_correcao",
];

fn truncated(text: &str, n: usize) -> String {
    js::slice_utf16(text, n)
}

/// `documentColumns(row, data, client)`: the patch, by property.
pub(crate) fn document_columns(row: &Value, data: &Value, client: &Focus) -> Map<String, Value> {
    let status = map_status(data.get("status"));
    let now = now();
    let protocol_record = data.get("protocolo_nota_fiscal").filter(|v| !v.is_null());
    let messages = error_messages(data);
    let mut patch = Map::new();
    patch.insert("status".into(), json!(status));
    let message = if (status == "rejected" || status == "authorized") && !messages.is_empty() {
        let joined = messages.join(" | ");
        if joined.is_empty() {
            Value::Null
        } else {
            json!(joined)
        }
    } else {
        Value::Null
    };
    patch.insert("statusMessage".into(), message);
    patch.insert("updatedAt".into(), json!(now));
    if let Some(number) = str_of(data.get("numero")) {
        patch.insert("number".into(), json!(truncated(&number, 20)));
    }
    if let Some(series) = str_of(data.get("serie")).or_else(|| str_of(data.get("serie_rps"))) {
        patch.insert("series".into(), json!(truncated(&series, 5)));
    }
    if let Some(key) = access_key_of(data.get("chave_nfe")) {
        patch.insert("accessKey".into(), json!(key));
    }
    if let Some(code) = str_of(data.get("codigo_verificacao")) {
        patch.insert("verificationCode".into(), json!(truncated(&code, 60)));
    }
    if let Some(protocol) = str_of(data.get("protocolo"))
        .or_else(|| str_of(protocol_record.and_then(|p| p.get("numero_protocolo"))))
    {
        patch.insert("protocol".into(), json!(truncated(&protocol, 60)));
    }
    if let Some(xml) = client.absolute_url(data.get("caminho_xml_nota_fiscal")) {
        patch.insert("xmlUrl".into(), json!(xml));
    }
    if let Some(pdf) = client
        .absolute_url(data.get("caminho_danfe"))
        .or_else(|| client.absolute_url(data.get("url_danfse")))
    {
        patch.insert("pdfUrl".into(), json!(pdf));
    }
    if let Some(url) = str_of(data.get("url")) {
        patch.insert("publicUrl".into(), json!(url));
    }
    if status == "authorized" && row.get("authorizedAt").is_none_or(Value::is_null) {
        let received = str_of(protocol_record.and_then(|p| p.get("data_recebimento")))
            .and_then(|d| js::js_date(&d));
        patch.insert(
            "authorizedAt".into(),
            json!(received.unwrap_or_else(|| now.clone())),
        );
    }
    if status == "cancelled" && row.get("cancelledAt").is_none_or(Value::is_null) {
        patch.insert("cancelledAt".into(), json!(now));
    }
    let kept: Map<String, Value> = match data {
        Value::Object(map) => map
            .iter()
            .filter(|(key, _)| !ECHOED_KEYS.contains(&key.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        _ => Map::new(),
    };
    patch.insert("responsePayload".into(), Value::Object(kept));
    patch
}

/// `db.update(fiscalDocuments).set(patch).where(id).returning()`.
pub(crate) async fn patch_document(
    db: &PgPool,
    id: &str,
    patch: &Map<String, Value>,
) -> Result<Value, FiscalError> {
    let row = FISCAL_DOCUMENTS
        .patch_raw(db, id, FISCAL_DOCUMENTS.values(patch), false)
        .await?;
    row.ok_or_else(|| Refusal::Internal("the fiscal document is gone".into()).into())
}

/// `fiscalDocumentEventData(doc)`.
pub(crate) fn event_data(doc: &Value) -> Value {
    let pick = |key: &str| doc.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": pick("id"),
        "entityId": pick("entityId"),
        "sourceType": pick("sourceType"),
        "sourceId": pick("sourceId"),
        "kind": pick("kind"),
        "environment": pick("environment"),
        "status": pick("status"),
        "number": pick("number"),
        "series": pick("series"),
        "accessKey": pick("accessKey"),
    })
}

// ── refresh ─────────────────────────────────────────────────────────────────

/// `RefreshResult`.
pub(crate) struct Refreshed {
    pub document: Value,
    pub changed: bool,
    pub previous_status: String,
}

/// `refreshFiscalDocument(db, env, doc)`.
pub(crate) async fn refresh_document(
    db: &PgPool,
    keyring: &Keyring,
    http: Option<OutboundHttp>,
    doc: &Value,
) -> Result<Refreshed, FiscalError> {
    let entity = require_fiscal_entity(db, doc["entityId"].as_str().unwrap_or_default()).await?;
    let environment = doc["environment"].as_str().unwrap_or_default();
    let client = client_for(&entity, keyring, environment, http)?;
    let id = doc["id"].as_str().unwrap_or_default();
    let status = doc["status"].as_str().unwrap_or_default().to_owned();
    let res = match client
        .get(
            doc["kind"].as_str().unwrap_or_default(),
            doc["providerRef"].as_str().unwrap_or_default(),
        )
        .await
    {
        Ok(res) => res,
        Err(error) if error.status == 404 && (status == "error" || status == "processing") => {
            let mut patch = Map::new();
            patch.insert("status".into(), json!("error"));
            patch.insert(
                "statusMessage".into(),
                json!("Focus NFe has no record of this document: the request did not arrive. Issue it again."),
            );
            patch.insert("updatedAt".into(), json!(now()));
            let saved = patch_document(db, id, &patch).await?;
            return Ok(Refreshed {
                document: saved,
                changed: status != "error",
                previous_status: status,
            });
        }
        Err(error) => return Err(error.into()),
    };
    let patch = document_columns(doc, &res.data, &client);
    let saved = patch_document(db, id, &patch).await?;
    let changed = saved["status"] != doc["status"]
        || saved["number"] != doc["number"]
        || saved["accessKey"] != doc["accessKey"];
    Ok(Refreshed {
        document: saved,
        changed,
        previous_status: status,
    })
}

// ── issue ───────────────────────────────────────────────────────────────────

fn num(value: Option<&Value>, fallback: f64) -> f64 {
    let parsed = match value {
        Some(Value::String(text)) => js::parse_float(text),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    if parsed.is_finite() { parsed } else { fallback }
}

fn object(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

/// `loadCounterparty(db, invoice)`.
async fn load_counterparty(db: &PgPool, invoice: &Value) -> Result<Counterparty, FiscalError> {
    let contact_id = text(invoice, "contactId");
    let party: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(parties),
        " from parties t where t.id = $1 limit 1"
    ))
    .bind(&contact_id)
    .fetch_optional(db)
    .await?;
    let party = party.map(|row| PARTIES.js(row));
    let mut br_fiscal = object(party.as_ref().and_then(|p| p.get("brFiscal")));
    let mut identity_name: Option<String> = None;
    if let Some(company_id) = party
        .as_ref()
        .and_then(|p| text(p, "companyId"))
        .filter(|c| !c.is_empty())
    {
        let name: Option<Option<String>> =
            sqlx::query_scalar("select display_name from companies where id = $1 limit 1")
                .bind(&company_id)
                .fetch_optional(db)
                .await?;
        identity_name = name.flatten();
    } else if let Some(person_id) = party
        .as_ref()
        .and_then(|p| text(p, "personId"))
        .filter(|c| !c.is_empty())
    {
        let name: Option<Option<String>> =
            sqlx::query_scalar("select display_name from people where id = $1 limit 1")
                .bind(&person_id)
                .fetch_optional(db)
                .await?;
        identity_name = name.flatten();
    }
    let address = normalize_postal_address(invoice.get("shippingAddress"))
        .or_else(|| normalize_postal_address(invoice.get("billingAddress")))
        .or_else(|| normalize_postal_address(party.as_ref().and_then(|p| p.get("shippingAddress"))))
        .or_else(|| normalize_postal_address(party.as_ref().and_then(|p| p.get("billingAddress"))));
    let tax_id = match get_contact_vat_number(db, contact_id.as_deref()).await? {
        Some(vat) => Some(vat),
        None => br_fiscal
            .get("taxId")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    br_fiscal.remove("taxId");
    let name = text(invoice, "contactName")
        .filter(|n| !n.is_empty())
        .or_else(|| {
            party
                .as_ref()
                .and_then(|p| text(p, "displayName"))
                .filter(|n| !n.is_empty())
        })
        .or_else(|| identity_name.filter(|n| !n.is_empty()))
        .unwrap_or_default();
    Ok(Counterparty {
        name,
        email: text(invoice, "contactEmail"),
        tax_id,
        address: object(address.as_ref()),
        fiscal: br_fiscal,
    })
}

/// `normalizeCnpj(value)`.
pub(crate) fn normalize_cnpj(value: &str) -> String {
    value
        .chars()
        .filter(|c| {
            !(weldsuite_books_domain::jurisdictions::is_js_space(*c)
                || matches!(c, '.' | '/' | '-'))
        })
        .collect::<String>()
        .to_uppercase()
}

fn iso_day(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(10)
        .collect()
}

/// `buildIssueContext(db, entity, invoice, environment, now)`: the kind and
/// the payload's inputs.
#[allow(clippy::too_many_lines)] // the context, read in the service's order
async fn build_issue_context(
    db: &PgPool,
    entity: &Value,
    invoice: &Value,
    environment: &str,
    now_millis: i64,
) -> Result<(&'static str, Args), FiscalError> {
    let entity_id = entity["id"].as_str().unwrap_or_default();
    let invoice_id = invoice["id"].as_str().unwrap_or_default();
    let items: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(invoice_items),
        " from invoice_items t where t.invoice_id = $1 and t.deleted_at is null \
         order by t.sort_order asc, t.created_at asc"
    ))
    .bind(invoice_id)
    .fetch_all(db)
    .await?;
    let items = INVOICE_ITEMS.js_rows(items);
    if items.is_empty() {
        return Err(FiscalError::bad("The invoice has no lines"));
    }
    let rates = load_tax_rates(
        db,
        entity_id,
        items
            .iter()
            .map(|i| i.get("taxRateId").and_then(Value::as_str)),
    )
    .await?;
    let rate_of = |item: &Value| {
        item.get("taxRateId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .and_then(|id| rates.get(id))
    };
    let lines: Vec<Line> = items
        .iter()
        .map(|item| {
            let quantity = num(item.get("quantity"), 1.0);
            let unit_price = num(item.get("unitPrice"), 0.0);
            let discount = num(item.get("discountPercent"), 0.0);
            let gross = quantity * unit_price;
            let line_total = if item.get("lineTotal").is_some_and(|v| !v.is_null()) {
                num(item.get("lineTotal"), 0.0)
            } else {
                js::math_round((gross - gross * (discount / 100.0) + js::EPSILON) * 100.0) / 100.0
            };
            let ncm = text(item, "ncm");
            let cfop = text(item, "cfop");
            let mut fiscal = object(item.get("fiscalData"));
            if let Some(ncm) = ncm.as_deref().filter(|v| !v.is_empty()) {
                fiscal.insert("ncm".into(), json!(ncm));
            }
            if let Some(cfop) = cfop.as_deref().filter(|v| !v.is_empty()) {
                fiscal.insert("cfop".into(), json!(cfop));
            }
            Line {
                description: text(item, "description").unwrap_or_default(),
                quantity,
                unit_price,
                unit: text(item, "unit"),
                line_total,
                product_code: text(item, "productId"),
                ncm,
                cfop,
                fiscal,
                kind: profile_of(rate_of(item).and_then(|r| r.get("jurisdictionMetadata")))
                    .and_then(|p| p["kind"].as_str())
                    .map(str::to_owned),
            }
        })
        .collect();
    let settings = settings_of(entity);
    let kind = payload::choose_kind(&lines, &settings)?;
    let is_credit_note = invoice["type"].as_str() == Some("credit_note");

    let mut referenced: Option<String> = None;
    if is_credit_note {
        if kind != "nfe" {
            return Err(FiscalError::bad(
                "A service credit note has no NFS-e. Cancel the original NFS-e instead",
            ));
        }
        if let Some(original) = text(invoice, "creditNoteForInvoiceId").filter(|o| !o.is_empty()) {
            let key: Option<Option<String>> = sqlx::query_scalar(
                "select access_key from fiscal_documents where source_id = $1 and kind = 'nfe' \
                 and status = 'authorized' order by created_at desc limit 1",
            )
            .bind(&original)
            .fetch_optional(db)
            .await?;
            referenced = key.flatten();
        }
        if referenced.as_deref().is_none_or(str::is_empty) {
            return Err(FiscalError::bad(
                "A credit note returns an authorized NF-e: issue the NF-e of the invoice it credits first",
            ));
        }
    }

    let counterparty = load_counterparty(db, invoice).await?;
    let identifiers = object(entity.get("taxIdentifiers"));
    let invoice_fiscal = invoice.get("fiscalData").filter(|v| !v.is_null()).cloned();

    // The taxes of each line, worked out again by the BR engine.
    let hook_lines: Vec<HookLine> = items
        .iter()
        .zip(&lines)
        .map(|(item, line)| {
            let rate = rate_of(item);
            HookLine {
                line_total: line.line_total,
                tax_rate_id: text(item, "taxRateId"),
                tax_rate_name: rate.and_then(|r| text(r, "name")),
                tax_category_code: rate.and_then(|r| text(r, "taxCategoryCode")),
                rate: num(item.get("taxRate"), 0.0),
                jurisdiction_metadata: rate
                    .and_then(|r| r.get("jurisdictionMetadata").cloned())
                    .filter(|m| !m.is_null()),
                fiscal_data: Some(Value::Object(line.fiscal.clone())),
            }
        })
        .collect();
    let result = compute_document_taxes(
        &hook_lines,
        &HookContext {
            direction: Direction::Sales,
            issue_date: Some(iso_day(invoice.get("issueDate"))),
            entity_settings: entity
                .get("jurisdictionSettings")
                .filter(|v| !v.is_null())
                .cloned(),
            entity_tax_classification: text(entity, "taxClassification"),
            counterparty: HookCounterparty {
                country: payload::text(&counterparty.address, "country"),
                state_code: payload::text(&counterparty.address, "state"),
                tax_id: counterparty.tax_id.clone(),
                fiscal: Some(Value::Object(counterparty.fiscal.clone())),
            },
            document_fiscal: invoice_fiscal.clone(),
        },
    )
    .map_err(|error| FiscalError::Refusal(Refusal::Internal(error.to_string())))?;
    let withheld = match invoice.get("taxBreakdown") {
        Some(Value::Array(rows)) => rows
            .iter()
            .filter(|r| r.get("treatment").and_then(Value::as_str) == Some("withheld"))
            .filter_map(|r| r.as_object().cloned())
            .collect(),
        Some(Value::Null) | None => result.document_rows.clone(),
        Some(_) => Vec::new(),
    };

    Ok((
        kind,
        Args {
            environment: environment.to_owned(),
            now_ms: now_millis,
            issuer: Issuer {
                cnpj: identifiers
                    .get("vatNumber")
                    .and_then(Value::as_str)
                    .filter(|v| !v.is_empty())
                    .map(normalize_cnpj)
                    .unwrap_or_default(),
                regime: regime_of(entity["taxClassification"].as_str()).to_owned(),
                inscricao_estadual: identifiers
                    .get("registrationNumber")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                settings,
            },
            counterparty,
            document: Document {
                number: text(invoice, "invoiceNumber"),
                issue_date: iso_day(invoice.get("issueDate")),
                due_date: Some(iso_day(invoice.get("dueDate"))).filter(|d| !d.is_empty()),
                notes: text(invoice, "notes"),
                fiscal: object(invoice_fiscal.as_ref()),
                is_credit_note,
                referenced_access_key: referenced,
                online: js::truthy(invoice.get("commerceOrderId")),
            },
            lines,
            taxes: Taxes {
                lines: result.lines,
                withheld,
            },
            dps_number: None,
        },
    ))
}

/// `nextDpsNumber(db, entityId, environment)`.
async fn next_dps_number(
    db: &PgPool,
    entity_id: &str,
    environment: &str,
) -> Result<i64, sqlx::Error> {
    let next: i64 = sqlx::query_scalar(
        "insert into entity_number_sequences (id, entity_id, sequence_type, prefix, next_value, padding) \
         values ($1, $2, $3, '', 2, 0) on conflict (entity_id, sequence_type) \
         do update set next_value = entity_number_sequences.next_value + 1, updated_at = $4::timestamp \
         returning next_value::int8",
    )
    .bind(generate_id("seq"))
    .bind(entity_id)
    .bind(format!("dps_{environment}"))
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(next - 1)
}

/// `providerRefFor(sourceId, attempt)`.
fn provider_ref(source_id: &str, attempt: usize) -> String {
    let clean: String = source_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        .collect();
    let full = format!("{clean}-{attempt}");
    let len = full.chars().count();
    full.chars().skip(len.saturating_sub(60)).collect()
}

/// `issueFiscalDocument(db, env, args)`.
#[allow(clippy::too_many_lines)] // the service's steps, in order
async fn issue_document(
    caller: &Caller,
    state: &BooksState,
    entity_id: &str,
    invoice_id: &str,
) -> Result<Value, FiscalError> {
    let db = &caller.db;
    let keyring = caller.keyring(state);
    let http = caller.http(state);
    let now_millis = now_ms();
    let entity = require_fiscal_entity(db, entity_id).await?;
    let invoice: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(invoices),
        " from invoices t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(invoice_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some(invoice) = invoice.map(|row| INVOICES.js(row)) else {
        return Err(FiscalError::status("Invoice not found", 404, None));
    };
    if invoice["type"].as_str() == Some("proforma") {
        return Err(FiscalError::bad(
            "A pro forma invoice cannot be issued as a fiscal document",
        ));
    }
    if matches!(invoice["status"].as_str(), Some("draft" | "cancelled")) {
        return Err(FiscalError::bad(
            "Finalize the invoice before issuing its fiscal document",
        ));
    }
    let settings = settings_of(&entity);
    let environment = environment_of(&settings);
    let client = client_for(&entity, &keyring, environment, http.clone())?;
    let source_type = if invoice["type"].as_str() == Some("credit_note") {
        "credit_note"
    } else {
        "invoice"
    };

    // Settle what a network failure left with Focus before sending another.
    let earlier: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(fiscal_documents),
        " from fiscal_documents t where t.source_type = $1 and t.source_id = $2 \
         order by t.created_at desc"
    ))
    .bind(source_type)
    .bind(invoice_id)
    .fetch_all(db)
    .await?;
    for stale in FISCAL_DOCUMENTS
        .js_rows(earlier)
        .iter()
        .filter(|d| d["status"].as_str() == Some("error"))
    {
        match refresh_document(db, &keyring, http.clone(), stale).await {
            Ok(_) | Err(FiscalError::Provider(_) | FiscalError::Document { .. }) => {}
            Err(other) => return Err(other),
        }
    }
    let previous: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(fiscal_documents),
        " from fiscal_documents t where t.source_type = $1 and t.source_id = $2"
    ))
    .bind(source_type)
    .bind(invoice_id)
    .fetch_all(db)
    .await?;
    let previous = FISCAL_DOCUMENTS.js_rows(previous);
    if let Some(live) = previous
        .iter()
        .find(|d| matches!(d["status"].as_str(), Some("authorized" | "processing")))
    {
        let message = if live["status"].as_str() == Some("authorized") {
            "This invoice already has an authorized fiscal document"
        } else {
            "This invoice has a fiscal document that is still being authorized"
        };
        return Err(FiscalError::status(
            message,
            409,
            Some(json!({ "documentId": live["id"] })),
        ));
    }

    let (kind, mut args) =
        build_issue_context(db, &entity, &invoice, environment, now_millis).await?;
    let payload = match kind {
        "nfe" => payload::build_nfe(&args)?,
        "nfse" => payload::build_nfse(&args)?,
        _ => {
            args.dps_number = Some(next_dps_number(db, entity_id, environment).await?);
            payload::build_nfsen(&args)?
        }
    };

    let id = generate_id("fdoc");
    let reference = provider_ref(invoice_id, previous.len() + 1);
    let inserted: Result<Value, sqlx::Error> = sqlx::query_scalar(concat!(
        "insert into fiscal_documents as t (id, entity_id, source_type, source_id, kind, provider, \
         provider_ref, environment, status, request_payload, created_by) \
         values ($1, $2, $3, $4, $5, 'focus_nfe', $6, $7, 'processing', $8, $9) returning ",
        weldsuite_books_domain::books_row!(fiscal_documents)
    ))
    .bind(&id)
    .bind(entity_id)
    .bind(source_type)
    .bind(invoice_id)
    .bind(kind)
    .bind(&reference)
    .bind(environment)
    .bind(&payload)
    .bind(caller.user())
    .fetch_one(db)
    .await;
    let created_row = match inserted {
        Ok(row) => FISCAL_DOCUMENTS.js(row),
        Err(error) => {
            let text = error.to_string();
            if text.contains("fiscal_documents_provider_ref_idx") || text.contains("duplicate key")
            {
                return Err(FiscalError::status(
                    "This invoice is already being issued",
                    409,
                    None,
                ));
            }
            return Err(error.into());
        }
    };

    match client.submit(kind, &reference, &payload).await {
        Ok(res) => {
            let patch = document_columns(&created_row, &res.data, &client);
            patch_document(db, &id, &patch).await
        }
        Err(error) => {
            record_failure(db, &id, &error).await?;
            Err(error.into())
        }
    }
}

async fn record_failure(db: &PgPool, id: &str, error: &ProviderError) -> Result<(), FiscalError> {
    let mut patch = Map::new();
    patch.insert(
        "status".into(),
        json!(if error.is_rejection() {
            "rejected"
        } else {
            "error"
        }),
    );
    patch.insert(
        "statusMessage".into(),
        json!(js::slice_utf16(&error.detail(), 2000)),
    );
    patch.insert(
        "responsePayload".into(),
        json!({ "codigo": error.codigo, "mensagem": error.message, "erros": error.erros_json() }),
    );
    patch.insert("updatedAt".into(), json!(now()));
    patch_document(db, id, &patch).await?;
    Ok(())
}

async fn audit_and_publish(
    caller: &Caller,
    state: &BooksState,
    doc: &Value,
    event: weldsuite_catalogs::entity_events::EventName,
    audit_action: &str,
    changes: Option<Map<String, Value>>,
) {
    let id = doc["id"].as_str().unwrap_or_default();
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: doc["entityId"].as_str(),
            entity_type: "fiscal_document",
            entity_id: id,
            action: audit_action,
            changes,
        },
    )
    .await;
    caller.publish(state, event, id, event_data(doc));
}

fn read_issue(issues: &mut Issues, body: &Map<String, Value>) -> String {
    issues
        .text(body, "invoiceId", Presence::Required, Some(1), Some(30))
        .into_option()
        .unwrap_or_default()
}

async fn issue(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let invoice_id = match validate(&headers, &body, read_issue) {
        Ok(id) => id,
        Err(refusal) => return refusal.respond("Failed to issue the fiscal document"),
    };
    fiscal_reply(
        async {
            let entity = require_entity(&caller).await?;
            let entity_id = entity["id"].as_str().unwrap_or_default();
            let document = issue_document(&caller, &state, entity_id, &invoice_id).await?;
            let mut changes = Map::new();
            changes.insert(
                "status".into(),
                change(Value::Null, document["status"].clone()),
            );
            audit_and_publish(
                &caller,
                &state,
                &document,
                FISCAL_DOCUMENT_CREATED,
                "issued",
                Some(changes),
            )
            .await;
            Ok(created(document))
        }
        .await,
        "Failed to issue the fiscal document",
    )
}

async fn refresh(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    fiscal_reply(
        async {
            let entity = require_entity(&caller).await?;
            let doc =
                get_document(&caller.db, entity["id"].as_str().unwrap_or_default(), &id).await?;
            let refreshed = refresh_document(
                &caller.db,
                &caller.keyring(&state),
                caller.http(&state),
                &doc,
            )
            .await?;
            if refreshed.changed {
                let event = if refreshed.document["status"].as_str() == Some("cancelled") {
                    FISCAL_DOCUMENT_CANCELLED
                } else {
                    FISCAL_DOCUMENT_UPDATED
                };
                let mut changes = Map::new();
                changes.insert(
                    "status".into(),
                    change(
                        json!(refreshed.previous_status),
                        refreshed.document["status"].clone(),
                    ),
                );
                audit_and_publish(
                    &caller,
                    &state,
                    &refreshed.document,
                    event,
                    "refreshed",
                    Some(changes),
                )
                .await;
            }
            Ok(ok(refreshed.document))
        }
        .await,
        "Failed to refresh the fiscal document",
    )
}

fn read_reason(
    key: &'static str,
    max: usize,
) -> impl Fn(&mut Issues, &Map<String, Value>) -> String {
    move |issues, body| {
        issues
            .text_with(
                body,
                key,
                Presence::Required,
                Text::trimmed(Some(15), Some(max)),
            )
            .into_option()
            .unwrap_or_default()
    }
}

async fn cancel(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let reason = match validate(&headers, &body, read_reason("reason", 255)) {
        Ok(reason) => reason,
        Err(refusal) => return refusal.respond("Failed to cancel the fiscal document"),
    };
    fiscal_reply(
        cancel_document(&caller, &state, &id, &reason).await,
        "Failed to cancel the fiscal document",
    )
}

async fn cancel_document(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    reason: &str,
) -> Result<Response, FiscalError> {
    let db = &caller.db;
    let entity = require_entity(caller).await?;
    let doc = get_document(db, entity["id"].as_str().unwrap_or_default(), id).await?;
    if doc["status"].as_str() != Some("authorized") {
        return Err(FiscalError::bad(
            "Only an authorized fiscal document can be cancelled",
        ));
    }
    let doc_entity =
        require_fiscal_entity(db, doc["entityId"].as_str().unwrap_or_default()).await?;
    let client = client_for(
        &doc_entity,
        &caller.keyring(state),
        doc["environment"].as_str().unwrap_or_default(),
        caller.http(state),
    )?;
    let res = client
        .cancel(
            doc["kind"].as_str().unwrap_or_default(),
            doc["providerRef"].as_str().unwrap_or_default(),
            reason,
        )
        .await?;
    if map_status(res.data.get("status")) != "cancelled" {
        return Err(not_accepted(&res.data, "The cancellation was not accepted"));
    }
    let now = now();
    let mut kept = object(doc.get("responsePayload"));
    kept.insert("cancellation".into(), res.data.clone());
    if let Some(xml) = client.absolute_url(res.data.get("caminho_xml_cancelamento")) {
        kept.insert("cancellationXmlUrl".into(), json!(xml));
    }
    let mut patch = Map::new();
    patch.insert("status".into(), json!("cancelled"));
    patch.insert("cancelledAt".into(), json!(now));
    patch.insert("cancelReason".into(), json!(reason));
    patch.insert(
        "statusMessage".into(),
        json!(str_of(res.data.get("mensagem_sefaz"))),
    );
    patch.insert("responsePayload".into(), Value::Object(kept));
    patch.insert("updatedAt".into(), json!(now));
    let saved = patch_document(db, id, &patch).await?;
    let mut changes = Map::new();
    changes.insert(
        "status".into(),
        change(doc["status"].clone(), saved["status"].clone()),
    );
    changes.insert("cancelReason".into(), change(Value::Null, json!(reason)));
    audit_and_publish(
        caller,
        state,
        &saved,
        FISCAL_DOCUMENT_CANCELLED,
        "cancelled",
        Some(changes),
    )
    .await;
    Ok(ok(saved))
}

fn not_accepted(data: &Value, fallback: &str) -> FiscalError {
    let messages = error_messages(data);
    let message = if messages.is_empty() {
        fallback.to_owned()
    } else {
        messages.join(" | ")
    };
    let mut details = Map::new();
    details.insert("provider".into(), json!("focus_nfe"));
    if let Some(status) = str_of(data.get("status")) {
        details.insert("status".into(), json!(status));
    }
    FiscalError::status(message, 400, Some(Value::Object(details)))
}

async fn correction(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let text = match validate(&headers, &body, read_reason("text", 1000)) {
        Ok(text) => text,
        Err(refusal) => return refusal.respond("Failed to send the correction"),
    };
    fiscal_reply(
        correct_document(&caller, &state, &id, &text).await,
        "Failed to send the correction",
    )
}

async fn correct_document(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    correction_text: &str,
) -> Result<Response, FiscalError> {
    let db = &caller.db;
    let entity = require_entity(caller).await?;
    let doc = get_document(db, entity["id"].as_str().unwrap_or_default(), id).await?;
    if doc["kind"].as_str() != Some("nfe") {
        return Err(FiscalError::bad(
            "A carta de correção only exists for the NF-e",
        ));
    }
    if doc["status"].as_str() != Some("authorized") {
        return Err(FiscalError::bad("Only an authorized NF-e can be corrected"));
    }
    let doc_entity =
        require_fiscal_entity(db, doc["entityId"].as_str().unwrap_or_default()).await?;
    let client = client_for(
        &doc_entity,
        &caller.keyring(state),
        doc["environment"].as_str().unwrap_or_default(),
        caller.http(state),
    )?;
    let res = client
        .correction(
            doc["providerRef"].as_str().unwrap_or_default(),
            correction_text,
        )
        .await?;
    if map_status(res.data.get("status")) != "authorized" {
        return Err(not_accepted(&res.data, "The correction was not accepted"));
    }
    let number = match res.data.get("numero_carta_correcao") {
        Some(Value::Number(n)) => Value::Number(n.clone()),
        other => str_of(other)
            .and_then(|t| js::parse_int(&t))
            .filter(|n| *n != 0)
            .map_or(Value::Null, |n| json!(n)),
    };
    let correction = json!({
        "status": "authorized",
        "number": number,
        "xmlUrl": client.absolute_url(res.data.get("caminho_xml_carta_correcao")),
        "pdfUrl": client.absolute_url(res.data.get("caminho_pdf_carta_correcao")),
        "message": str_of(res.data.get("mensagem_sefaz")),
    });
    let mut payload = object(doc.get("responsePayload"));
    let mut corrections = payload
        .get("corrections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut entry = correction.as_object().cloned().unwrap_or_default();
    entry.insert("text".into(), json!(correction_text));
    entry.insert("at".into(), json!(now()));
    corrections.push(Value::Object(entry));
    payload.insert("corrections".into(), Value::Array(corrections));
    let mut patch = Map::new();
    patch.insert("responsePayload".into(), Value::Object(payload));
    patch.insert("updatedAt".into(), json!(now()));
    let saved = patch_document(db, id, &patch).await?;
    let mut changes = Map::new();
    changes.insert(
        "correction".into(),
        change(Value::Null, json!({ "number": correction["number"] })),
    );
    audit_and_publish(
        caller,
        state,
        &saved,
        FISCAL_DOCUMENT_UPDATED,
        "corrected",
        Some(changes),
    )
    .await;
    Ok(ok(json!({ "document": saved, "correction": correction })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references() {
        assert_eq!(provider_ref("inv_goods", 1), "inv_goods-1");
        assert_eq!(normalize_cnpj("12.345.678/0001-23"), "12345678000123");
    }
}
