//! The `data.welddata-enrich` job (the `WELDDATA_ENRICH` Workflow) against
//! the real tenant schema (built from the journaled migrations by
//! `scripts/rust-test-db.ts`): each action writes its cells as the
//! Workflow does, Findymail and the company websites answered by fakes.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use weldsuite_data::{ActionKeys, TenantDatabases, WebPages, WelddataEnrichJob};
use weldsuite_db::{PgPool, master_pool};
use weldsuite_ports::{
    BoxFuture, DynOutboundHttp, HttpRequest, HttpResponse, Job, JobContext, JobError, OutboundHttp,
    PortError, StepFn, StepRetry,
};

/// Runs each step once, as a job's first attempt does.
struct Once;

impl JobContext for Once {
    fn key(&self) -> &'static str {
        "test"
    }

    fn run_step<'s>(
        &'s self,
        _name: &'s str,
        _retry: StepRetry,
        step: &'s StepFn<'s>,
    ) -> BoxFuture<'s, Result<Value, JobError>> {
        step()
    }
}

/// Findymail: an email for Ada, nothing for anyone else.
#[derive(Default)]
struct Findymail {
    calls: Mutex<Vec<Value>>,
}

impl DynOutboundHttp for Findymail {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
        let body: Value = serde_json::from_slice(request.body.as_deref().unwrap_or_default())
            .unwrap_or(Value::Null);
        self.calls
            .lock()
            .expect("calls")
            .push(json!({ "url": request.url, "body": body }));
        let answer = if body["name"] == "Ada Lovelace" {
            json!({ "contact": { "name": "Ada Lovelace", "email": "ada@engines.test" } })
        } else {
            json!({ "contact": null })
        };
        Box::pin(std::future::ready(Ok(HttpResponse {
            status: 200,
            body: answer.to_string().into_bytes(),
        })))
    }
}

/// Company websites by URL.
struct Sites(HashMap<String, String>);

impl WebPages for Sites {
    fn fetch<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(std::future::ready(self.0.get(url).cloned()))
    }
}

async fn seed(db: &PgPool) {
    sqlx::raw_sql(
        r#"delete from welddata_cells where column_id like 'wdcol_job_%';
          delete from welddata_columns where id like 'wdcol_job_%';
          delete from welddata_leads where id like 'wdlead_job_%';
          delete from welddata_lists where id = 'wdlist_job';
          insert into welddata_lists (id, kind, name) values ('wdlist_job', 'person', 'Job');
          insert into welddata_leads (id, list_id, kind, name, domain, company_name, deleted_at) values
            ('wdlead_job_ada', 'wdlist_job', 'person', 'Ada Lovelace', 'https://engines.test/about', 'Engines', null),
            ('wdlead_job_bob', 'wdlist_job', 'person', 'Bob', null, null, null),
            ('wdlead_job_gone', 'wdlist_job', 'person', 'Gone', 'gone.test', null, now());
          insert into welddata_columns (id, list_id, name, type, config, sort_order) values
            ('wdcol_job_email', 'wdlist_job', 'Email', 'email_finder', '{"type":"email_finder","provider":"findymail"}', 0),
            ('wdcol_job_phone', 'wdlist_job', 'Phone', 'phone_finder', '{"type":"phone_finder","source":"website"}', 1),
            ('wdcol_job_ai', 'wdlist_job', 'Summary', 'ai', '{"type":"ai","prompt":"About {{email}} at {{companyName}}"}', 2),
            ('wdcol_job_magic', 'wdlist_job', 'Magic', 'magic', null, 3);
          insert into welddata_cells (id, column_id, lead_id, status) values
            ('wdcell_job_pending', 'wdcol_job_email', 'wdlead_job_ada', 'pending');"#,
    )
    .execute(db)
    .await
    .expect("seed");
}

async fn run(job: &WelddataEnrichJob, column: &str, leads: &[&str]) {
    let payload = json!({
        "workspaceId": "org_job",
        "userId": "user_job",
        "listId": "wdlist_job",
        "columnId": column,
        "leadIds": leads,
    });
    job.run(&Once, payload).await.expect("job");
}

async fn cell(db: &PgPool, column: &str, lead: &str) -> Option<Value> {
    sqlx::query_scalar(
        "select jsonb_build_object('status', status, 'value', value, 'data', data, 'error', error,
                                   'ran', ran_at is not null)
         from welddata_cells where column_id = $1 and lead_id = $2",
    )
    .bind(column)
    .bind(lead)
    .fetch_optional(db)
    .await
    .expect("cell")
}

#[tokio::test]
async fn a_column_run_writes_each_leads_cell() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 4).expect("tenant pool");
    seed(&db).await;
    let pool = db.clone();
    let tenants: TenantDatabases = Arc::new(move |_| {
        let pool = pool.clone();
        Box::pin(async move { Ok(pool) })
    });
    let findymail = Arc::new(Findymail::default());
    let job = WelddataEnrichJob {
        tenants,
        http: OutboundHttp(findymail.clone()),
        pages: Arc::new(Sites(HashMap::from([
            (
                "https://engines.test/".to_owned(),
                "<html><body>Welcome</body></html>".to_owned(),
            ),
            (
                "https://engines.test/contact".to_owned(),
                r#"<a href="tel:+31201234567">Call us</a>"#.to_owned(),
            ),
        ]))),
        keys: ActionKeys {
            findymail_api_key: Some("fm-key".to_owned()),
            prospeo_api_key: None,
        },
    };

    // Email finder: Ada's address; Bob has no domain; the deleted lead is skipped.
    run(
        &job,
        "wdcol_job_email",
        &["wdlead_job_ada", "wdlead_job_bob", "wdlead_job_gone"],
    )
    .await;
    assert_eq!(
        cell(&db, "wdcol_job_email", "wdlead_job_ada").await,
        Some(json!({
            "status": "done", "value": "ada@engines.test", "error": null, "ran": true,
            "data": { "provider": "findymail", "found": true },
        }))
    );
    assert_eq!(
        cell(&db, "wdcol_job_email", "wdlead_job_bob").await,
        Some(json!({
            "status": "error", "value": null, "data": null, "ran": true,
            "error": "No company domain on this lead to find an email against",
        }))
    );
    assert_eq!(cell(&db, "wdcol_job_email", "wdlead_job_gone").await, None);
    assert_eq!(
        *findymail.calls.lock().expect("calls"),
        vec![json!({
            "url": "https://app.findymail.com/api/search/name",
            "body": { "name": "Ada Lovelace", "domain": "engines.test" },
        })]
    );

    // Phone finder: the contact page's tel: link; Bob has neither domain nor company.
    run(
        &job,
        "wdcol_job_phone",
        &["wdlead_job_ada", "wdlead_job_bob"],
    )
    .await;
    assert_eq!(
        cell(&db, "wdcol_job_phone", "wdlead_job_ada").await,
        Some(json!({
            "status": "done", "value": "+31201234567", "error": null, "ran": true,
            "data": { "source": "website", "found": true, "url": "https://engines.test/contact" },
        }))
    );
    assert_eq!(
        cell(&db, "wdcol_job_phone", "wdlead_job_bob")
            .await
            .map(|c| c["error"].clone()),
        Some(json!(
            "No company domain or name on this lead to find a phone number from"
        ))
    );

    // AI is stubbed: done and empty, the prompt resolved from Ada's email cell.
    run(&job, "wdcol_job_ai", &["wdlead_job_ada"]).await;
    assert_eq!(
        cell(&db, "wdcol_job_ai", "wdlead_job_ada").await,
        Some(json!({
            "status": "done", "value": "", "error": null, "ran": true,
            "data": { "unavailable": true, "promptResolved": true },
        }))
    );

    // A type no action handles.
    run(&job, "wdcol_job_magic", &["wdlead_job_ada"]).await;
    assert_eq!(
        cell(&db, "wdcol_job_magic", "wdlead_job_ada")
            .await
            .map(|c| c["error"].clone()),
        Some(json!("Unknown action type: magic"))
    );

    // A column of another list (or gone) runs nothing.
    run(&job, "wdcol_job_missing", &["wdlead_job_ada"]).await;
    assert_eq!(cell(&db, "wdcol_job_missing", "wdlead_job_ada").await, None);
}
