//! The 30-day trash purge job against the real tenant schema (built from the
//! journaled migrations by `scripts/rust-test-db.ts`): it deletes a file
//! still trashed at the moment it was started for, with its objects, and
//! leaves a restored or re-trashed file alone.
//!
//! Runs when `WELDSUITE_TEST_TENANT_URL` is set; otherwise it returns early.

use std::sync::Arc;

use serde_json::{Value, json};
use weldsuite_core_files::{TRASH_PURGE_JOB, TrashPurge, TrashPurgeJob};
use weldsuite_db::master_pool;
use weldsuite_ports::{
    BoxFuture, DynFileStore, FileStore, FileStores, Job, JobContext, JobError, MemoryFileStore,
    PutOptions, StepFn, StepRetry,
};

const TRASHED_AT: &str = "2026-09-29T07:00:00.123Z";

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

fn payload(id: &str, deleted_at: &str) -> Value {
    serde_json::to_value(TrashPurge {
        workspace_id: "org_tp".to_owned(),
        file_id: id.to_owned(),
        file_key: format!("workspaces/org_tp/drive/{id}.pdf"),
        deleted_at: deleted_at.to_owned(),
        purge_at: "2026-10-29T07:00:00.123Z".to_owned(),
    })
    .expect("json")
}

#[tokio::test]
async fn purges_only_files_still_trashed_since_the_job_started() {
    let Ok(tenant_url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
        eprintln!("WELDSUITE_TEST_TENANT_URL not set; skipping");
        return;
    };
    let db = master_pool(&tenant_url, 2).expect("tenant pool");
    sqlx::raw_sql(
        r"delete from files where id like 'file_tp_%';
          insert into files (id, file_name, mime_type, file_size, storage_path, file_key, deleted_at) values
            ('file_tp_a', 'a.pdf', 'application/pdf', 1, 'workspaces/org_tp/drive/file_tp_a.pdf',
             'workspaces/org_tp/drive/file_tp_a.pdf', '2026-09-29T07:00:00.123'),
            ('file_tp_b', 'b.pdf', 'application/pdf', 1, 'workspaces/org_tp/drive/file_tp_b.pdf',
             'workspaces/org_tp/drive/file_tp_b.pdf', '2026-10-01T09:00:00.000'),
            ('file_tp_c', 'c.pdf', 'application/pdf', 1, 'workspaces/org_tp/drive/file_tp_c.pdf',
             'workspaces/org_tp/drive/file_tp_c.pdf', null);",
    )
    .execute(&db)
    .await
    .expect("seed");

    let private = Arc::new(MemoryFileStore::default());
    let public = Arc::new(MemoryFileStore::default());
    for id in ["file_tp_a", "file_tp_b", "file_tp_c"] {
        let key = format!("workspaces/org_tp/drive/{id}.pdf");
        private
            .put(&key, b"pdf".to_vec(), &PutOptions::default())
            .await
            .expect("put");
    }
    public
        .put(
            "workspaces/org_tp/drive/file_tp_a.pdf",
            b"old".to_vec(),
            &PutOptions::default(),
        )
        .await
        .expect("put");

    let pool = db.clone();
    let job = TrashPurgeJob::new(
        Arc::new(move |reference: String| {
            let pool = pool.clone();
            Box::pin(async move {
                assert_eq!(reference, "org_tp");
                Ok(pool)
            })
        }),
        Some(FileStores {
            private: Arc::clone(&private) as Arc<dyn DynFileStore>,
            public: Some(Arc::clone(&public) as Arc<dyn DynFileStore>),
        }),
    );
    assert_eq!(job.name(), TRASH_PURGE_JOB);

    // Still trashed since the job was started: gone, objects included.
    job.run(&Once, payload("file_tp_a", TRASHED_AT))
        .await
        .expect("ran");
    // Trashed again later (another job handles it), and restored: kept.
    job.run(&Once, payload("file_tp_b", TRASHED_AT))
        .await
        .expect("ran");
    job.run(&Once, payload("file_tp_c", TRASHED_AT))
        .await
        .expect("ran");
    // Already gone: nothing to do.
    job.run(&Once, payload("file_tp_a", TRASHED_AT))
        .await
        .expect("ran");
    assert!(
        job.run(&Once, json!({ "fileId": "file_tp_a" }))
            .await
            .is_err(),
        "a payload without its fields fails the job"
    );

    let left: Vec<String> =
        sqlx::query_scalar("select id from files where id like 'file_tp_%' order by id")
            .fetch_all(&db)
            .await
            .expect("rows");
    assert_eq!(left, ["file_tp_b", "file_tp_c"]);
    assert_eq!(
        private.keys(),
        [
            "workspaces/org_tp/drive/file_tp_b.pdf",
            "workspaces/org_tp/drive/file_tp_c.pdf"
        ]
    );
    assert_eq!(public.keys(), Vec::<String>::new());

    sqlx::raw_sql("delete from files where id like 'file_tp_%'")
        .execute(&db)
        .await
        .expect("clean up");
}
