//! The spike's proofs: tables, writing, replace files, upkeep, queries and
//! the compiler's SQL corpus, on Iceberg in a temp dir with the SQL catalog
//! on Postgres (`WELDSUITE_TEST_DATABASE_URL`; skipped without it).

mod corpus;
mod fixture;
mod lake;
mod queries;
