//! `/api/received-fiscal-documents` (`routes/received-fiscal-documents`,
//! services `br-fiscal/received`): the NF-e suppliers issued to the entity,
//! fetched from Focus NFe or uploaded as XML; manifestação do destinatário;
//! a draft bill from a note.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{FromRequest, Multipart, Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::entity_context::{
    SequenceType, next_entity_number, resolve_entity_base_currency, resolve_entity_id,
};
use weldsuite_books_domain::fx::{RateQuery, draft_rate};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, created, now, now_ms, ok, paged, reply, validate,
};
use weldsuite_books_domain::js;
use weldsuite_books_domain::jurisdictions::br::{profile_of, regime_of};
use weldsuite_books_domain::jurisdictions::br_tax::is_simples_regime;
use weldsuite_books_domain::sales_tax::document_tax::{DocumentContext, DocumentKind, IssueDate};
use weldsuite_books_domain::tables::{BILL_ITEMS, BILLS, RECEIVED_FISCAL_DOCUMENTS};
use weldsuite_books_domain::tax::{
    Direction, DocumentTaxItem, TaxArgs, TaxError, calculate_document_tax,
};
use weldsuite_catalogs::entity_events::{
    BILL_CREATED, RECEIVED_FISCAL_DOCUMENT_CREATED, RECEIVED_FISCAL_DOCUMENT_UPDATED,
};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::documents::normalize_cnpj;
use super::focus::Focus;
use super::nfe_xml::{XmlError, parse_nfe};
use super::settings::{client_for, environment_of, settings_of};
use super::{FiscalError, page_of, require_entity, require_fiscal_entity, str_of};

/// `MAX_NFE_XML_BYTES`.
const MAX_XML_BYTES: usize = 2 * 1024 * 1024;
const MAX_PAGES: usize = 5;
const MAX_XML_FETCHES: i64 = 25;
const MANIFESTATIONS: [&str; 4] = ["ciencia", "confirmacao", "desconhecimento", "nao_realizada"];

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("bills:read")))
        .route("/sync", post(sync).route_layer(need("bills:create")))
        .route(
            "/upload",
            post(upload)
                .route_layer(need("bills:create"))
                .layer(axum::extract::DefaultBodyLimit::max(MAX_XML_BYTES * 2)),
        )
        .route("/{id}", get(detail).route_layer(need("bills:read")))
        .route(
            "/{id}/manifest",
            post(manifest).route_layer(need("bills:update")),
        )
        .route(
            "/{id}/create-bill",
            post(create_bill).route_layer(need("bills:create")),
        )
        .route(
            "/{id}/ignore",
            post(ignore).route_layer(need("bills:create")),
        )
        .with_state(state)
}

fn fiscal_reply(result: Result<Response, FiscalError>, fallback: &str) -> Response {
    reply(result.map_err(FiscalError::refusal), fallback)
}

/// `receivedSummary(doc)`: without the XML and the parsed items.
fn summary(doc: &Value) -> Value {
    let mut out = doc.as_object().cloned().unwrap_or_default();
    let xml = out.remove("xml");
    let parsed = out.remove("parsed");
    out.insert("hasXml".into(), json!(js::truthy(xml.as_ref())));
    out.insert(
        "summary".into(),
        parsed
            .as_ref()
            .and_then(|p| p.get("summary"))
            .cloned()
            .unwrap_or(Value::Null),
    );
    Value::Object(out)
}

/// `receivedEventData(doc)`.
fn event_data(doc: &Value) -> Value {
    let pick = |key: &str| doc.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": pick("id"), "entityId": pick("entityId"), "kind": pick("kind"), "accessKey": pick("accessKey"),
        "issuerName": pick("issuerName"), "number": pick("number"), "total": pick("total"),
        "status": pick("status"), "manifestation": pick("manifestation"), "billId": pick("billId"),
    })
}

async fn audit_and_publish(
    caller: &Caller,
    state: &BooksState,
    doc: &Value,
    created: bool,
    action: &str,
    changes: Option<Map<String, Value>>,
) {
    let id = doc["id"].as_str().unwrap_or_default();
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: doc["entityId"].as_str(),
            entity_type: "received_fiscal_document",
            entity_id: id,
            action,
            changes,
        },
    )
    .await;
    caller.publish(
        state,
        if created {
            RECEIVED_FISCAL_DOCUMENT_CREATED
        } else {
            RECEIVED_FISCAL_DOCUMENT_UPDATED
        },
        id,
        event_data(doc),
    );
}

async fn find(db: &PgPool, entity_id: &str, id: &str) -> Result<Value, FiscalError> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(received_fiscal_documents),
        " from received_fiscal_documents t where t.id = $1 and t.entity_id = $2 limit 1"
    ))
    .bind(id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|row| RECEIVED_FISCAL_DOCUMENTS.js(row))
        .ok_or_else(|| FiscalError::status("Received fiscal document not found", 404, None))
}

async fn find_by_key(
    db: &PgPool,
    entity_id: &str,
    key: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(received_fiscal_documents),
        " from received_fiscal_documents t where t.entity_id = $1 and t.access_key = $2 limit 1"
    ))
    .bind(entity_id)
    .bind(key)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| RECEIVED_FISCAL_DOCUMENTS.js(row)))
}

async fn patch(db: &PgPool, id: &str, props: &Map<String, Value>) -> Result<Value, FiscalError> {
    RECEIVED_FISCAL_DOCUMENTS
        .patch_raw(db, id, RECEIVED_FISCAL_DOCUMENTS.values(props), false)
        .await?
        .ok_or_else(|| Refusal::Internal("the received document is gone".into()).into())
}

fn entity_cnpj(entity: &Value) -> Result<String, FiscalError> {
    entity
        .get("taxIdentifiers")
        .and_then(|t| t.get("vatNumber"))
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(normalize_cnpj)
        .filter(|c| !c.is_empty())
        .ok_or_else(|| FiscalError::bad("Set the entity's CNPJ before fetching received NF-e"))
}

fn xml_failure(error: XmlError) -> Result<String, FiscalError> {
    match error {
        XmlError::Parse(message) => Ok(message),
        XmlError::Fatal(message) => Err(Refusal::Internal(message).into()),
    }
}

/// `parsedColumns(parsed, xml)`, by property.
fn parsed_columns(parsed: &Value, xml: &str) -> Map<String, Value> {
    let cut = |v: Option<&str>, n: usize| v.map_or(Value::Null, |v| json!(js::slice_utf16(v, n)));
    let mut out = Map::new();
    out.insert("accessKey".into(), parsed["accessKey"].clone());
    out.insert(
        "issuerTaxId".into(),
        cut(parsed["issuer"]["taxId"].as_str(), 14),
    );
    out.insert(
        "issuerName".into(),
        cut(parsed["issuer"]["name"].as_str(), 255),
    );
    out.insert("number".into(), cut(parsed["number"].as_str(), 20));
    out.insert("series".into(), cut(parsed["series"].as_str(), 5));
    out.insert("issueDate".into(), parsed["issueDate"].clone());
    out.insert(
        "total".into(),
        json!(js::to_fixed(parsed["total"].as_f64().unwrap_or(0.0), 2)),
    );
    out.insert("xml".into(), json!(xml));
    out
}

/// `attachXml(db, row, xml)`.
async fn attach_xml(db: &PgPool, row: &Value, xml: &str) -> Result<Value, FiscalError> {
    let mut parsed_state = row
        .get("parsed")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let parsed = parse_nfe(xml).and_then(|parsed| {
        if parsed["accessKey"] == row["accessKey"] {
            Ok(parsed)
        } else {
            Err(XmlError::Parse(
                "The XML belongs to a different NF-e than this row".into(),
            ))
        }
    });
    let mut props = match parsed {
        Ok(parsed) => {
            let mut columns = parsed_columns(&parsed, xml);
            columns.remove("accessKey");
            parsed_state.insert("nfe".into(), parsed);
            parsed_state.insert("parseError".into(), Value::Null);
            columns
        }
        Err(error) => {
            let message = xml_failure(error)?;
            parsed_state.insert("parseError".into(), json!(message));
            let mut columns = Map::new();
            columns.insert("xml".into(), json!(xml));
            columns
        }
    };
    props.insert("parsed".into(), Value::Object(parsed_state));
    props.insert("updatedAt".into(), json!(now()));
    patch(db, row["id"].as_str().unwrap_or_default(), &props).await
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller) -> Response {
    let q = caller.query();
    let (page, size) = page_of(&q);
    reply(
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Ok(paged(Vec::new(), 0, false, None));
            };
            let status = q.present("status").map(str::to_owned);
            let term = q.present("search").map(|s| format!("%{s}%"));
            let rows: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                weldsuite_books_domain::books_row!(received_fiscal_documents),
                " from received_fiscal_documents t where t.entity_id = $1 \
                 and ($2::text is null or t.status = $2) \
                 and ($3::text is null or (t.issuer_name like $3 or t.number like $3 \
                 or t.access_key like $3 or t.issuer_tax_id like $3)) \
                 order by t.issue_date desc, t.created_at desc limit $4 offset $5"
            ))
            .bind(&entity_id)
            .bind(&status)
            .bind(&term)
            .bind(size)
            .bind((page - 1) * size)
            .fetch_all(&caller.db)
            .await?;
            let total: i64 = sqlx::query_scalar(
                "select count(*)::int8 from received_fiscal_documents where entity_id = $1 \
                 and ($2::text is null or status = $2) \
                 and ($3::text is null or (issuer_name like $3 or number like $3 \
                 or access_key like $3 or issuer_tax_id like $3))",
            )
            .bind(&entity_id)
            .bind(&status)
            .bind(&term)
            .fetch_one(&caller.db)
            .await?;
            let rows = RECEIVED_FISCAL_DOCUMENTS
                .js_rows(rows)
                .iter()
                .map(summary)
                .collect();
            Ok(paged(rows, total, page * size < total, None))
        }
        .await,
        "Failed to fetch received NF-e",
    )
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    fiscal_reply(
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Err(Refusal::not_found("Received fiscal document", &id).into());
            };
            Ok(ok(find(&caller.db, &entity_id, &id).await?))
        }
        .await,
        "Failed to fetch the received NF-e",
    )
}

// ── POST /sync ──────────────────────────────────────────────────────────────

#[derive(Default)]
struct SyncResult {
    fetched: i64,
    created: i64,
    updated: i64,
    xml_fetched: i64,
    has_more: bool,
    version: f64,
}

async fn sync(caller: Caller, State(state): State<BooksState>) -> Response {
    fiscal_reply(
        async {
            let entity = require_entity(&caller).await?;
            let entity_id = entity["id"].as_str().unwrap_or_default().to_owned();
            let result = sync_received(&caller, &state, &entity_id).await?;
            let mut changes = Map::new();
            changes.insert("created".into(), change(Value::Null, json!(result.created)));
            changes.insert("updated".into(), change(Value::Null, json!(result.updated)));
            write_accounting_audit(
                &caller,
                &caller.db,
                AuditInput {
                    accounting_entity_id: Some(&entity_id),
                    entity_type: "received_fiscal_document",
                    entity_id: &entity_id,
                    action: "synced",
                    changes: Some(changes),
                },
            )
            .await;
            Ok(ok(json!({
                "fetched": result.fetched,
                "created": result.created,
                "updated": result.updated,
                "xmlFetched": result.xml_fetched,
                "hasMore": result.has_more,
                "version": js::number_value(result.version),
            })))
        }
        .await,
        "Failed to fetch received NF-e",
    )
}

fn versao_of(item: &Value) -> f64 {
    match item.get("versao") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        other => str_of(other)
            .and_then(|s| js::parse_int(&s))
            .map_or(f64::NAN, |v| {
                #[allow(clippy::cast_precision_loss)]
                let v = v as f64;
                v
            }),
    }
}

async fn sync_received(
    caller: &Caller,
    state: &BooksState,
    entity_id: &str,
) -> Result<SyncResult, FiscalError> {
    let db = &caller.db;
    let entity = require_fiscal_entity(db, entity_id).await?;
    let settings = settings_of(&entity);
    let environment = environment_of(&settings);
    let client = client_for(
        &entity,
        &caller.keyring(state),
        environment,
        caller.http(state),
    )?;
    let cnpj = entity_cnpj(&entity)?;
    let stored_version = settings.get("receivedNfeVersion").and_then(Value::as_f64);
    let mut version = if settings
        .get("receivedNfeVersionEnv")
        .and_then(Value::as_str)
        == Some(environment)
    {
        stored_version.unwrap_or(0.0)
    } else {
        0.0
    };
    let mut result = SyncResult {
        version,
        ..SyncResult::default()
    };
    for page in 0..MAX_PAGES {
        let (items, total, max) = client.list_received(&cnpj, Some(version)).await?;
        if items.is_empty() {
            break;
        }
        let mut highest = version;
        for item in &items {
            let versao = sync_item(db, &client, entity_id, item, &mut result).await?;
            if versao.is_finite() {
                highest = highest.max(versao);
            }
        }
        version = highest;
        #[allow(clippy::cast_precision_loss)]
        if items.len() as f64 >= total {
            version = version.max(max.unwrap_or(0.0));
            break;
        }
        if page == MAX_PAGES - 1 {
            result.has_more = true;
        }
    }
    result.version = version;
    #[allow(clippy::float_cmp)]
    let unchanged = version == stored_version.unwrap_or(0.0)
        && settings
            .get("receivedNfeVersionEnv")
            .and_then(Value::as_str)
            == Some(environment);
    if !unchanged {
        let mut next = settings.clone();
        next.insert("receivedNfeVersion".into(), js::number_value(version));
        next.insert("receivedNfeVersionEnv".into(), json!(environment));
        sqlx::query("update entities set jurisdiction_settings = $1, updated_at = $2::timestamp where id = $3")
            .bind(Value::Object(next))
            .bind(now())
            .bind(entity_id)
            .execute(db)
            .await?;
    }
    Ok(result)
}

/// `syncReceivedItem(...)`: the note's `versao`, NaN when skipped.
async fn sync_item(
    db: &PgPool,
    client: &Focus,
    entity_id: &str,
    item: &Value,
    result: &mut SyncResult,
) -> Result<f64, FiscalError> {
    let Some((row, created)) = upsert_summary(db, entity_id, item).await? else {
        return Ok(f64::NAN);
    };
    result.fetched += 1;
    if created {
        result.created += 1;
    } else {
        result.updated += 1;
    }
    let versao = versao_of(item);
    if item.get("nfe_completa") == Some(&Value::Bool(true))
        && !js::truthy(row.get("xml"))
        && result.xml_fetched < MAX_XML_FETCHES
        && let Some(xml) = client
            .received_xml(row["accessKey"].as_str().unwrap_or_default())
            .await?
    {
        attach_xml(db, &row, &xml).await?;
        result.xml_fetched += 1;
    }
    Ok(versao)
}

/// `seriesAndNumberOf(accessKey)`.
fn series_and_number(key: &str) -> (String, String) {
    let strip = |v: &str| {
        let s = v.trim_start_matches('0');
        if s.is_empty() {
            "0".to_owned()
        } else {
            s.to_owned()
        }
    };
    (strip(&key[22..25]), strip(&key[25..34]))
}

async fn upsert_summary(
    db: &PgPool,
    entity_id: &str,
    item: &Value,
) -> Result<Option<(Value, bool)>, FiscalError> {
    let Some(chave) = str_of(item.get("chave_nfe")) else {
        return Ok(None);
    };
    let key = if chave
        .get(..3)
        .is_some_and(|p| p.eq_ignore_ascii_case("nfe"))
    {
        chave[3..].to_owned()
    } else {
        chave
    };
    if !(key.len() == 44 && key.bytes().all(|b| b.is_ascii_digit())) {
        return Ok(None);
    }
    let existing = find_by_key(db, entity_id, &key).await?;
    let (series, number) = series_and_number(&key);
    let versao = match item.get("versao") {
        Some(Value::Number(n)) => Value::Number(n.clone()),
        other => str_of(other)
            .and_then(|s| js::parse_int(&s))
            .filter(|v| *v != 0)
            .map_or(Value::Null, |v| json!(v)),
    };
    let summary = json!({
        "situacao": str_of(item.get("situacao")),
        "tipoNfe": str_of(item.get("tipo_nfe")),
        "nfeCompleta": item.get("nfe_completa") == Some(&Value::Bool(true)),
        "versao": versao,
        "digestValue": str_of(item.get("digest_value")),
        "cancelledAt": str_of(item.get("data_cancelamento")),
        "cancelReason": str_of(item.get("justificativa_cancelamento")),
        "correction": str_of(item.get("carta_correcao")),
    });
    let cut = |key: &str, n: usize| {
        str_of(item.get(key)).map_or(Value::Null, |v| json!(js::slice_utf16(&v, n)))
    };
    let mut columns = Map::new();
    columns.insert("issuerTaxId".into(), cut("documento_emitente", 14));
    columns.insert("issuerName".into(), cut("nome_emitente", 255));
    columns.insert("issueDate".into(), cut("data_emissao", 10));
    columns.insert(
        "total".into(),
        str_of(item.get("valor_total")).map_or(Value::Null, |v| json!(v)),
    );
    columns.insert(
        "manifestation".into(),
        str_of(item.get("manifestacao_destinatario"))
            .filter(|m| m != "nulo")
            .map_or(Value::Null, |m| json!(m)),
    );
    if let Some(existing) = existing {
        let mut props = columns;
        if !js::truthy(existing.get("xml")) {
            props.insert("number".into(), json!(number));
            props.insert("series".into(), json!(series));
        }
        let mut parsed = existing
            .get("parsed")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        parsed.insert("summary".into(), summary);
        props.insert("parsed".into(), Value::Object(parsed));
        props.insert("updatedAt".into(), json!(now()));
        let saved = patch(db, existing["id"].as_str().unwrap_or_default(), &props).await?;
        return Ok(Some((saved, false)));
    }
    let mut props = Map::new();
    props.insert("id".into(), json!(generate_id("rfd")));
    props.insert("entityId".into(), json!(entity_id));
    props.insert("kind".into(), json!("nfe"));
    props.insert("accessKey".into(), json!(key));
    props.insert("number".into(), json!(number));
    props.insert("series".into(), json!(series));
    props.insert("status".into(), json!("new"));
    props.insert("source".into(), json!("focus_nfe"));
    props.insert("parsed".into(), json!({ "summary": summary }));
    props.extend(columns);
    let row = RECEIVED_FISCAL_DOCUMENTS
        .insert_raw(db, RECEIVED_FISCAL_DOCUMENTS.values(&props))
        .await?;
    Ok(Some((row, true)))
}

// ── POST /upload ────────────────────────────────────────────────────────────

/// `readUploadedXml(c)`: `{ xml }`, or the "file" / "xml" part of a form.
async fn read_uploaded_xml(headers: &HeaderMap, body: Bytes) -> Result<String, FiscalError> {
    let declared = headers
        .get(http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .map_or(0.0, weldsuite_kit::validation::js_number);
    #[allow(clippy::cast_precision_loss)]
    if declared > (MAX_XML_BYTES + 4096) as f64 {
        return Err(FiscalError::bad("The XML file is too large"));
    }
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if content_type.contains("multipart/form-data") {
        let request = http::Request::builder()
            .header(http::header::CONTENT_TYPE, content_type)
            .body(Body::from(body))
            .map_err(|error| FiscalError::Refusal(Refusal::Internal(error.to_string())))?;
        let mut form = Multipart::from_request(request, &())
            .await
            .map_err(|error| FiscalError::Refusal(Refusal::Internal(error.to_string())))?;
        let (mut file, mut xml) = (None, None);
        while let Ok(Some(field)) = form.next_field().await {
            let name = field.name().unwrap_or_default().to_owned();
            if (name == "file" && file.is_none()) || (name == "xml" && xml.is_none()) {
                let value = field
                    .text()
                    .await
                    .map_err(|error| FiscalError::Refusal(Refusal::Internal(error.to_string())))?;
                if name == "file" {
                    file = Some(value);
                } else {
                    xml = Some(value);
                }
            }
        }
        return file
            .or(xml)
            .ok_or_else(|| FiscalError::bad("Send the NF-e XML in the \"file\" field"));
    }
    let parsed: Option<Value> = serde_json::from_slice(&body).ok();
    match parsed
        .as_ref()
        .and_then(|v| v.get("xml"))
        .and_then(Value::as_str)
        .filter(|x| !x.is_empty())
    {
        Some(xml) => Ok(xml.to_owned()),
        None => Err(FiscalError::bad(
            "Send { \"xml\": \"<NF-e XML>\" } or a multipart form with the file",
        )),
    }
}

async fn upload(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    fiscal_reply(
        async {
            let entity = require_entity(&caller).await?;
            let entity_id = entity["id"].as_str().unwrap_or_default().to_owned();
            let xml = read_uploaded_xml(&headers, body).await?;
            let (row, created) = import_xml(&caller.db, &entity_id, &xml).await?;
            audit_and_publish(
                &caller,
                &state,
                &row,
                created,
                if created { "uploaded" } else { "reuploaded" },
                None,
            )
            .await;
            Ok(if created {
                weldsuite_books_domain::http::created(summary(&row))
            } else {
                ok(summary(&row))
            })
        }
        .await,
        "Failed to read the NF-e",
    )
}

/// `importNfeXml(db, entityId, xml)`.
async fn import_xml(db: &PgPool, entity_id: &str, xml: &str) -> Result<(Value, bool), FiscalError> {
    if xml.len() > MAX_XML_BYTES {
        return Err(FiscalError::bad("The XML file is too large"));
    }
    let entity = require_fiscal_entity(db, entity_id).await?;
    let parsed = match parse_nfe(xml) {
        Ok(parsed) => parsed,
        Err(error) => {
            let message = xml_failure(error)?;
            return Err(FiscalError::bad(format!(
                "The file is not a readable NF-e: {message}"
            )));
        }
    };
    let cnpj = entity_cnpj(&entity)?;
    if let Some(recipient) = parsed["recipient"]["taxId"]
        .as_str()
        .filter(|t| !t.is_empty())
        && normalize_cnpj(recipient) != cnpj
    {
        return Err(FiscalError::bad(format!(
            "This NF-e is addressed to {recipient}, not to this entity ({cnpj})"
        )));
    }
    let key = parsed["accessKey"].as_str().unwrap_or_default().to_owned();
    if let Some(existing) = find_by_key(db, entity_id, &key).await? {
        if existing["status"].as_str() == Some("imported") {
            return Err(FiscalError::status(
                "This NF-e was already turned into a bill",
                409,
                Some(json!({ "receivedDocumentId": existing["id"] })),
            ));
        }
        return Ok((attach_xml(db, &existing, xml).await?, false));
    }
    let mut props = Map::new();
    props.insert("id".into(), json!(generate_id("rfd")));
    props.insert("entityId".into(), json!(entity_id));
    props.insert("kind".into(), json!("nfe"));
    props.insert("status".into(), json!("new"));
    props.insert("source".into(), json!("upload"));
    props.insert("parsed".into(), json!({ "nfe": parsed }));
    props.extend(parsed_columns(&parsed, xml));
    let row = RECEIVED_FISCAL_DOCUMENTS
        .insert_raw(db, RECEIVED_FISCAL_DOCUMENTS.values(&props))
        .await?;
    Ok((row, true))
}

// ── POST /:id/manifest ──────────────────────────────────────────────────────

fn read_manifest(issues: &mut Issues, body: &Map<String, Value>) -> (String, Option<String>) {
    let kind = issues
        .choice(body, "type", Presence::Required, &MANIFESTATIONS)
        .into_option();
    let reason_field = issues.text_with(
        body,
        "reason",
        Presence::Optional,
        Text::trimmed(Some(15), Some(255)),
    );
    let reason_raw = body.get("reason");
    let reason_type_ok = reason_raw.is_none_or(Value::is_string);
    if kind.as_deref() == Some("nao_realizada")
        && reason_type_ok
        && reason_raw
            .and_then(Value::as_str)
            .map(weldsuite_books_domain::jurisdictions::js_trim)
            .is_none_or(str::is_empty)
    {
        issues.custom(
            "reason",
            "A reason of 15 to 255 characters is required when the operation was not carried out",
        );
    }
    (kind.unwrap_or_default(), reason_field.into_option())
}

async fn manifest(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (kind, reason) = match validate(&headers, &body, read_manifest) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to send the manifestation"),
    };
    fiscal_reply(
        async {
            let db = &caller.db;
            let entity = require_entity(&caller).await?;
            let doc = find(db, entity["id"].as_str().unwrap_or_default(), &id).await?;
            let doc_entity = require_fiscal_entity(db, doc["entityId"].as_str().unwrap_or_default()).await?;
            let environment = environment_of(&settings_of(&doc_entity));
            let client = client_for(&doc_entity, &caller.keyring(&state), environment, caller.http(&state))?;
            let key = doc["accessKey"].as_str().unwrap_or_default();
            let res = client.manifest(key, &kind, reason.as_deref()).await?;
            if res.data.get("status").and_then(Value::as_str) != Some("evento_registrado") {
                return Err(FiscalError::status(
                    str_of(res.data.get("mensagem_sefaz"))
                        .unwrap_or_else(|| "The manifestation was not accepted".into()),
                    400,
                    Some(json!({ "provider": "focus_nfe", "statusSefaz": str_of(res.data.get("status_sefaz")) })),
                ));
            }
            let mut props = Map::new();
            props.insert("manifestation".into(), json!(kind));
            props.insert("updatedAt".into(), json!(now()));
            let mut saved = patch(db, &id, &props).await?;
            if kind == "ciencia"
                && !js::truthy(saved.get("xml"))
                && let Ok(Some(xml)) = client.received_xml(key).await
            {
                saved = attach_xml(db, &saved, &xml).await?;
            }
            let mut changes = Map::new();
            changes.insert(
                "manifestation".into(),
                change(doc["manifestation"].clone(), json!(kind)),
            );
            audit_and_publish(&caller, &state, &saved, false, "manifested", Some(changes)).await;
            Ok(ok(summary(&saved)))
        }
        .await,
        "Failed to send the manifestation",
    )
}

// ── POST /:id/ignore ────────────────────────────────────────────────────────

async fn ignore(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    fiscal_reply(
        async {
            let entity = require_entity(&caller).await?;
            let doc = find(&caller.db, entity["id"].as_str().unwrap_or_default(), &id).await?;
            if doc["status"].as_str() == Some("imported") {
                return Err(FiscalError::status(
                    "This NF-e was already turned into a bill",
                    409,
                    None,
                ));
            }
            let mut props = Map::new();
            props.insert("status".into(), json!("ignored"));
            props.insert("updatedAt".into(), json!(now()));
            let saved = patch(&caller.db, &id, &props).await?;
            let mut changes = Map::new();
            changes.insert(
                "status".into(),
                change(doc["status"].clone(), saved["status"].clone()),
            );
            audit_and_publish(&caller, &state, &saved, false, "ignored", Some(changes)).await;
            Ok(ok(summary(&saved)))
        }
        .await,
        "Failed to ignore the NF-e",
    )
}

// ── POST /:id/create-bill ───────────────────────────────────────────────────

struct BillBody {
    contact_id: Option<String>,
    expense_account_id: Option<String>,
    due_date: Option<String>,
}

fn read_bill(issues: &mut Issues, body: &Map<String, Value>) -> BillBody {
    let contact_id = issues.text(body, "contactId", Presence::Optional, Some(1), Some(30));
    let expense = issues.text(body, "expenseAccountId", Presence::Optional, None, Some(30));
    let due = issues.pattern(
        body,
        "dueDate",
        Presence::Optional,
        None,
        None,
        |d| {
            let b = d.as_bytes();
            b.len() == 10
                && b.iter().enumerate().all(|(i, c)| {
                    if i == 4 || i == 7 {
                        *c == b'-'
                    } else {
                        c.is_ascii_digit()
                    }
                })
        },
        "Use a date as YYYY-MM-DD",
    );
    BillBody {
        contact_id: contact_id.into_option(),
        expense_account_id: expense.into_option(),
        due_date: due.into_option(),
    }
}

async fn create_bill(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_bill) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create the bill"),
    };
    fiscal_reply(
        async {
            let entity = require_entity(&caller).await?;
            let doc = find(&caller.db, entity["id"].as_str().unwrap_or_default(), &id).await?;
            let (bill, document, warnings) =
                bill_from_received(&caller, &state, &entity, &doc, &data).await?;
            let bill_id = bill["id"].as_str().unwrap_or_default().to_owned();
            write_accounting_audit(
                &caller,
                &caller.db,
                AuditInput {
                    accounting_entity_id: entity["id"].as_str(),
                    entity_type: "bill",
                    entity_id: &bill_id,
                    action: "created",
                    changes: None,
                },
            )
            .await;
            caller.publish(
                &state,
                BILL_CREATED,
                &bill_id,
                json!({
                    "id": bill_id,
                    "billNumber": bill["billNumber"],
                    "status": "draft",
                    "total": bill["total"],
                    "currency": bill["currency"],
                    "contactId": bill["contactId"],
                    "issueDate": bill["issueDate"],
                    "dueDate": bill["dueDate"],
                }),
            );
            let mut changes = Map::new();
            changes.insert(
                "status".into(),
                change(doc["status"].clone(), document["status"].clone()),
            );
            audit_and_publish(&caller, &state, &document, false, "imported", Some(changes)).await;
            Ok(created(
                json!({ "bill": bill, "document": summary(&document), "warnings": warnings }),
            ))
        }
        .await,
        "Failed to create the bill",
    )
}

/// `entryCfop(cfop)`: the supplier's 5xxx / 6xxx / 7xxx as 1xxx / 2xxx / 3xxx.
fn entry_cfop(cfop: &str) -> Option<String> {
    if !(cfop.len() == 4 && cfop.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let first = match &cfop[..1] {
        "1" | "2" | "3" => return Some(cfop.to_owned()),
        "5" => "1",
        "6" => "2",
        "7" => "3",
        _ => return None,
    };
    Some(format!("{first}{}", &cfop[1..]))
}

fn unit_price_of(item: &Value) -> f64 {
    let quantity = item["quantity"].as_f64().unwrap_or(0.0);
    let price = item["unitPrice"].as_f64().unwrap_or(0.0);
    let total = item["total"].as_f64().unwrap_or(0.0);
    if quantity <= 0.0 {
        return total;
    }
    if (quantity * price - total).abs() <= 0.01 {
        return price;
    }
    js::math_round((total / quantity) * 10_000.0) / 10_000.0
}

/// A bill line of a note (`BillLine`): the tax item and its description.
struct BillLine {
    item: DocumentTaxItem,
    description: String,
}

fn bill_lines(parsed: &Value, tax_rate_id: Option<&str>) -> Vec<BillLine> {
    let mut lines: Vec<BillLine> = parsed["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(idx, item)| {
            let gross = item["total"].as_f64().unwrap_or(0.0);
            let discount = item["discount"].as_f64().unwrap_or(0.0);
            let discount_percent = if gross > 0.0 && discount > 0.0 {
                js::to_fixed((discount / gross) * 100.0, 2)
            } else {
                "0".into()
            };
            let quantity = item["quantity"].as_f64().unwrap_or(0.0);
            let mut fiscal = Map::new();
            if let Some(origin) = item["origin"].as_str().filter(|o| !o.is_empty()) {
                fiscal.insert("origin".into(), json!(origin));
            }
            fiscal.insert("icmsRate".into(), item["icms"]["rate"].clone());
            fiscal.insert("ipiRate".into(), item["ipi"]["rate"].clone());
            let ncm = item["ncm"].as_str().unwrap_or_default();
            let description = item["description"]
                .as_str()
                .filter(|d| !d.is_empty())
                .map_or_else(|| format!("Item {}", idx + 1), str::to_owned);
            #[allow(clippy::cast_precision_loss)]
            BillLine {
                item: DocumentTaxItem {
                    id: Some(generate_id("bli")),
                    description: Some(description.clone()),
                    quantity: Some(js::number_text(if quantity == 0.0 || quantity.is_nan() {
                        1.0
                    } else {
                        quantity
                    })),
                    unit_price: js::number_text(unit_price_of(item)),
                    discount_percent: Some(discount_percent),
                    sort_order: Some(idx as f64),
                    tax_rate_id: tax_rate_id.map(str::to_owned),
                    ncm: (ncm.len() == 8 && ncm.bytes().all(|b| b.is_ascii_digit()))
                        .then(|| ncm.to_owned()),
                    cfop: entry_cfop(item["cfop"].as_str().unwrap_or_default()),
                    fiscal_data: Some(Value::Object(fiscal)),
                    ..DocumentTaxItem::default()
                },
                description,
            }
        })
        .collect();
    for (description, key) in [
        ("ICMS substituição tributária", "icmsSt"),
        ("Frete", "freight"),
        ("Seguro", "insurance"),
        ("Outras despesas acessórias", "other"),
    ] {
        let amount = parsed[key].as_f64().unwrap_or(0.0);
        if amount > 0.0 {
            #[allow(clippy::cast_precision_loss)]
            let sort = lines.len() as f64;
            lines.push(BillLine {
                item: DocumentTaxItem {
                    id: Some(generate_id("bli")),
                    description: Some(description.to_owned()),
                    quantity: Some("1".into()),
                    unit_price: js::to_fixed(amount, 2),
                    discount_percent: Some("0".into()),
                    sort_order: Some(sort),
                    tax_rate_id: None,
                    ..DocumentTaxItem::default()
                },
                description: description.to_owned(),
            });
        }
    }
    lines
}

/// `createBillFromReceived(db, env, entity, doc, args)`: (bill with its
/// items, the linked note, the engine's warnings).
#[allow(clippy::too_many_lines)] // the bill, built as the TypeScript service builds it
async fn bill_from_received(
    caller: &Caller,
    state: &BooksState,
    entity: &Value,
    doc: &Value,
    args: &BillBody,
) -> Result<(Value, Value, Value), FiscalError> {
    let db = &caller.db;
    let entity_id = entity["id"].as_str().unwrap_or_default().to_owned();
    if doc["status"].as_str() == Some("imported") {
        return Err(FiscalError::status(
            "This NF-e was already turned into a bill",
            409,
            Some(json!({ "billId": doc["billId"] })),
        ));
    }
    let parsed = doc
        .get("parsed")
        .and_then(|p| p.get("nfe"))
        .filter(|p| p.is_object())
        .cloned();
    let Some(parsed) = parsed.filter(|p| p["items"].as_array().is_some_and(|i| !i.is_empty()))
    else {
        return Err(FiscalError::bad(
            "The full XML of this NF-e is not available yet. Send a ciência manifestation (or upload the XML), then try again.",
        ));
    };
    let issuer_tax_id = parsed["issuer"]["taxId"].as_str().filter(|t| !t.is_empty());
    let mut contact_id = args.contact_id.clone();
    if contact_id.is_none()
        && let Some(tax_id) = issuer_tax_id
    {
        contact_id = sqlx::query_scalar(
            "select parties.id from parties inner join companies on companies.id = parties.company_id \
             where parties.deleted_at is null \
             and upper(regexp_replace(companies.vat_number, '[^0-9A-Za-z]', '', 'g')) = $1 limit 1",
        )
        .bind(normalize_cnpj(tax_id))
        .fetch_optional(db)
        .await?;
    }
    let Some(contact_id) = contact_id else {
        let message = format!(
            "No contact has the CNPJ {} of the issuer {}: create the supplier, or pass contactId",
            issuer_tax_id.unwrap_or_default(),
            parsed["issuer"]["name"].as_str().unwrap_or_default()
        );
        let collapsed = message
            .split(weldsuite_books_domain::jurisdictions::is_js_space)
            .filter(|w| !w.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        // `.replace(/\s+/g, ' ')` keeps one space at either end.
        let collapsed = if message.starts_with(weldsuite_books_domain::jurisdictions::is_js_space) {
            format!(" {collapsed}")
        } else {
            collapsed
        };
        return Err(FiscalError::bad(collapsed));
    };
    let contact: Option<(String, String, Option<String>)> = sqlx::query_as(
        "select id, display_name, role from parties where id = $1 and deleted_at is null limit 1",
    )
    .bind(&contact_id)
    .fetch_optional(db)
    .await?;
    let Some((_, contact_name, contact_role)) = contact else {
        return Err(FiscalError::status("Contact not found", 404, None));
    };

    let regime = regime_of(entity["taxClassification"].as_str());
    let takes_credits = !is_simples_regime(regime);
    let has_credit = parsed["items"].as_array().is_some_and(|items| {
        items.iter().any(|i| {
            ["icms", "pis", "cofins", "ipi"]
                .iter()
                .any(|t| i[*t]["value"].as_f64().unwrap_or(0.0) > 0.0)
        })
    });
    let profile_name = if takes_credits && has_credit {
        "compra_revenda_credito"
    } else {
        "compra_sem_credito"
    };
    let rates: Vec<(String, Option<Value>)> = sqlx::query_as(
        "select id, jurisdiction_metadata from tax_rates where entity_id = $1 and is_active = true \
         and deleted_at is null",
    )
    .bind(&entity_id)
    .fetch_all(db)
    .await?;
    let purchase_rate = rates.into_iter().find_map(|(id, metadata)| {
        (profile_of(metadata.as_ref()).and_then(|p| p["profile"].as_str()) == Some(profile_name))
            .then_some(id)
    });

    let bill_id = generate_id("bil");
    let lines = bill_lines(&parsed, purchase_rate.as_deref());
    let base_currency = resolve_entity_base_currency(db, &entity_id).await?;
    let today = js::iso_from_millis(now_ms()).unwrap_or_default();
    let issue_day = parsed["issueDate"]
        .as_str()
        .map_or_else(|| today[..10].to_owned(), str::to_owned);
    let issue_date = js::js_date(&format!("{issue_day}T12:00:00Z")).unwrap_or_default();
    let due_day = args
        .due_date
        .clone()
        .or_else(|| {
            parsed["installments"].as_array().and_then(|list| {
                list.iter().find_map(|i| {
                    i["dueDate"]
                        .as_str()
                        .filter(|d| !d.is_empty())
                        .map(str::to_owned)
                })
            })
        })
        .or_else(|| parsed["issueDate"].as_str().map(str::to_owned))
        .unwrap_or_else(|| issue_date.chars().take(10).collect());
    let due_date = js::js_date(&format!("{due_day}T12:00:00Z"));
    let Some(due_date) = due_date else {
        return Err(Refusal::Internal("Invalid time value".into()).into());
    };
    let bill_number = next_entity_number(db, &entity_id, SequenceType::Bill)
        .await?
        .formatted;
    let fiscal_data = json!({ "accessKey": parsed["accessKey"] });

    let items: Vec<DocumentTaxItem> = lines.iter().map(|l| l.item.clone()).collect();
    let document = DocumentContext {
        kind: DocumentKind::Bill,
        document_id: Some(bill_id.clone()),
        document_number: Some(bill_number.clone()),
        contact_id: Some(contact_id.clone()),
        issue_date: IssueDate::Instant(issue_date.clone()),
        currency: Some(base_currency.clone()),
        billing_address: None,
        shipping_address: None,
        delivery_address: None,
        ship_from_address: None,
        marketplace_facilitated: None,
        fiscal_data: Some(fiscal_data.clone()),
        original_invoice_id: None,
    };
    let mut tax_args = TaxArgs::new(&entity_id, Direction::Purchase, &items);
    tax_args.document = Some(&document);
    let totals = calculate_document_tax(db, &tax_args)
        .await
        .map_err(|error| match error {
            TaxError::Calculation(message) => FiscalError::bad(message),
            other => FiscalError::Refusal(Refusal::from(other)),
        })?;
    let exchange_rate = draft_rate(
        db,
        caller.http(state).as_ref(),
        RateQuery {
            base_currency: &base_currency,
            currency: &base_currency,
            at_millis: js::js_date_millis(&issue_date).unwrap_or(0),
            typed: None,
            use_feed: true,
        },
    )
    .await?;

    let now = now();
    let total_number = js::parse_float(&totals.total);
    let nfe_total = parsed["total"].as_f64().unwrap_or(0.0);
    let mismatch = (total_number - nfe_total).abs() > 0.05;
    let mut bill = Map::new();
    let mut set = |key: &str, value: Value| {
        bill.insert(key.to_owned(), value);
    };
    set("id", json!(bill_id));
    set("entityId", json!(entity_id));
    set("billNumber", json!(bill_number));
    set("type", json!("standard"));
    set("status", json!("draft"));
    set("contactId", json!(contact_id));
    set("contactName", json!(contact_name));
    set("issueDate", json!(issue_date));
    set("dueDate", json!(due_date));
    set("currency", json!(base_currency));
    set("exchangeRate", json!(exchange_rate));
    set("subtotal", json!(totals.subtotal));
    set("discountTotal", json!(totals.discount_total));
    set("taxTotal", json!(totals.tax_total));
    set("total", json!(totals.total));
    set("balanceDue", json!(totals.balance_due));
    set("taxBreakdown", Value::Array(totals.tax_breakdown.clone()));
    set("amountPaid", json!("0"));
    set(
        "externalReference",
        parsed["number"]
            .as_str()
            .filter(|n| !n.is_empty())
            .map_or(Value::Null, |number| {
                json!(format!(
                    "{}/{number}",
                    parsed["series"].as_str().unwrap_or("1")
                ))
            }),
    );
    set(
        "reference",
        json!(format!(
            "NF-e {}",
            parsed["accessKey"].as_str().unwrap_or_default()
        )),
    );
    set(
        "internalNotes",
        if mismatch {
            json!(format!(
                "Total of the NF-e is R$ {}; the bill adds up to R$ {}. Check the taxes before approving.",
                js::to_fixed(nfe_total, 2),
                totals.total
            ))
        } else {
            Value::Null
        },
    );
    set("expenseAccountId", json!(args.expense_account_id));
    set("fiscalData", fiscal_data);
    set("approvalStatus", json!("pending"));
    set("createdBy", json!(caller.user()));
    set("createdAt", json!(now));
    set("updatedAt", json!(now));

    let item_records: Vec<Value> = lines
        .iter()
        .enumerate()
        .map(|(idx, line)| {
            let processed = totals.processed_items.get(idx);
            json!({
                "id": line.item.id,
                "entityId": entity_id,
                "billId": bill_id,
                "description": line.description,
                "quantity": line.item.quantity.clone().unwrap_or_else(|| "1".into()),
                "unitPrice": line.item.unit_price,
                "discountPercent": line.item.discount_percent.clone().unwrap_or_else(|| "0".into()),
                "taxRateId": processed.and_then(|p| p.tax_rate_id.clone()),
                "taxRate": processed.and_then(|p| p.tax_rate.clone()),
                "taxAmount": processed.map(|p| p.tax_amount.clone()),
                "lineTotal": processed.map(|p| p.line_total.clone()),
                "lineTotalWithTax": processed.map(|p| p.line_total_with_tax.clone()),
                "accountId": args.expense_account_id,
                "sortOrder": idx,
                "ncm": line.item.ncm,
                "cfop": line.item.cfop,
                "fiscalData": line.item.fiscal_data,
                "createdAt": now,
                "updatedAt": now,
            })
        })
        .collect();

    BILLS.insert_raw(db, BILLS.values(&bill)).await?;
    for record in &item_records {
        if let Value::Object(props) = record {
            BILL_ITEMS.insert_raw(db, BILL_ITEMS.values(props)).await?;
        }
    }
    let role = contact_role.unwrap_or_else(|| "none".into());
    if role == "none" || role == "customer" {
        sqlx::query("update parties set role = $1, updated_at = $2::timestamp where id = $3")
            .bind(if role == "none" { "supplier" } else { "both" })
            .bind(&now)
            .bind(&contact_id)
            .execute(db)
            .await?;
    }
    let mut props = Map::new();
    props.insert("status".into(), json!("imported"));
    props.insert("billId".into(), json!(bill_id));
    props.insert("updatedAt".into(), json!(now));
    let linked = patch(db, doc["id"].as_str().unwrap_or_default(), &props).await?;
    let mut bill_out = bill;
    bill_out.insert("items".into(), Value::Array(item_records));
    Ok((
        Value::Object(bill_out),
        linked,
        json!(totals.tax_warnings.unwrap_or_default()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cfops_and_keys() {
        assert_eq!(entry_cfop("6102").as_deref(), Some("2102"));
        assert_eq!(entry_cfop("1102").as_deref(), Some("1102"));
        assert_eq!(entry_cfop("9102"), None);
        assert_eq!(
            series_and_number("35261011222333000181550010000000091000000093"),
            ("1".to_owned(), "9".to_owned())
        );
    }
}
