//! Spike S6 of the ORM plan: the baseline for `size_all`, the same program
//! with one entity.
//!
//! ```text
//! cargo build --release -p weldsuite-schema --example size_one
//! ```

use sea_orm::EntityTrait;
use weldsuite_schema::tenant::people;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let url = std::env::args().nth(1).unwrap_or_default();
    let pool = sqlx::PgPool::connect_lazy(&url).expect("database URL");
    let db = weldsuite_db::orm(&pool);
    let rows = people::Entity::find().all(&db).await.unwrap_or_default();
    println!("{}", serde_json::to_string(&rows).unwrap_or_default());
}
