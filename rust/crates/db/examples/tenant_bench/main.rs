//! The S3 and S4 spikes of the Rust backend (`rust/docs/spikes.md`).
//!
//! ```text
//! cargo run --release -p weldsuite-db --example tenant_bench -- <command> --key=value ...
//!
//! s3       --direct=URL --pooled=URL [--clients=40] [--iterations=300]
//!          [--cache=100] [--persistent=true] [--distinct=250]
//! s4-setup --direct=URL --pooled-base=URL [--tenants=2000] [--parallel=8]
//! s4       --master=URL --admin=URL [--tenants=2000] [--active=300]
//!          [--dist=uniform|zipf] [--cold=0.05] [--rotate=5] [--think-ms=100]
//!          [--tenant-max-connections=N] [--max-tenant-pools=N] [--idle-timeout=SECS]
//!          [--duration=90] [--warmup=15]
//! ```
//!
//! A development tool: it creates databases and drops tables, so point it
//! only at a throwaway Postgres. As an example of `weldsuite-db`, CI keeps it
//! compiling (`--all-targets`), and the `weldsuite` binary and image never
//! include it.

mod args;
mod s3;
mod s4;
mod stats;

use std::error::Error;

use args::Args;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let mut raw = std::env::args().skip(1);
    let command = raw.next().unwrap_or_default();
    let args = Args::parse(raw)?;
    match command.as_str() {
        "s3" => s3::run(&args).await,
        "s4-setup" => s4::setup(&args).await,
        "s4" => s4::run(&args).await,
        _ => Err("usage: tenant-bench s3|s4-setup|s4 --key=value ...".into()),
    }
}
