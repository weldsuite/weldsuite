//! Spike S6 of the ORM plan (`rust/docs/spikes.md`): a binary that queries
//! and serializes every entity, to measure what the entities add to a release
//! build. `size_one` is the baseline with one entity.
//!
//! ```text
//! cargo build --release -p weldsuite-schema --features all-tables --example size_all
//! ```

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = std::env::args().skip(1);
    let url = args.next().unwrap_or_default();
    let pool = sqlx::PgPool::connect_lazy(&url).expect("database URL");
    let db = weldsuite_db::orm(&pool);
    for table in args {
        let tenant = Box::pin(weldsuite_schema::tenant::rows_json(&db, &table)).await;
        let master = Box::pin(weldsuite_schema::master::rows_json(&db, &table)).await;
        println!(
            "{table}: {:?} {:?}",
            tenant.map(|r| r.map(|r| r.len())),
            master.map(|r| r.map(|r| r.len()))
        );
    }
}
