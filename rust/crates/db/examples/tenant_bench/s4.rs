//! S4: one process, thousands of workspace databases.
//!
//! `s4-setup` creates `ws_00000 … ws_NNNNN` from a one-table template and a
//! master `workspaces` table whose `database_url` points each workspace at
//! its database through `PgBouncer`. `s4` drives `Workspaces::tenant(ref)` +
//! one indexed lookup from `--active` concurrent loops: most picks fall in a
//! window of `--active` workspaces that slides through all of them
//! (`--rotate` per second), the rest are cold picks from anywhere. Once a
//! second it samples `PgBouncer` (`SHOW LISTS`) and Postgres
//! (`pg_stat_activity`).

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use sqlx::postgres::PgPoolOptions;
use sqlx::{AssertSqlSafe, Connection, PgConnection, PgPool, Row};
use weldsuite_db::{Keyring, WorkspaceConfig, Workspaces, master_pool};

use crate::args::Args;
use crate::stats::{Errors, Percentiles, Rng, Zipf, micros};

const MASTER_SCHEMA: &str = "
drop table if exists workspaces, workspace_licences, partners, workspace_database_moves cascade;
create table partners (id varchar(30) primary key, status varchar(20) not null default 'active');
create table workspaces (
    id varchar(255) primary key,
    clerk_org_id varchar(255) unique,
    database_url text,
    is_active boolean not null default true,
    billing_mode varchar(20) not null default 'direct',
    partner_id varchar(30)
);
create table workspace_licences (
    workspace_id varchar(255) not null unique,
    allowed_apps jsonb not null default '[]',
    status varchar(20) not null default 'active'
);
create table workspace_database_moves (
    workspace_id varchar(255) not null,
    status varchar(20) not null default 'queued'
);
";

const TEMPLATE_SCHEMA: &str = "
create table if not exists items (id int primary key, name text not null);
insert into items select g, 'item ' || g from generate_series(1, 100) g on conflict do nothing;
";

fn database_name(index: usize) -> String {
    format!("ws_{index:05}")
}

pub(crate) async fn setup(args: &Args) -> Result<(), Box<dyn Error>> {
    let direct = args.string("direct")?;
    let pooled_base = args.string("pooled-base")?;
    let tenants: usize = args.get("tenants", 2000)?;
    let parallel: usize = args.get("parallel", 8)?;

    let admin = PgPoolOptions::new()
        .max_connections(u32::try_from(parallel).unwrap_or(8))
        .connect(&direct)
        .await?;
    let existing: Vec<String> = sqlx::query_scalar("select datname from pg_database")
        .fetch_all(&admin)
        .await?;
    if !existing.iter().any(|name| name == "tenant_tpl") {
        sqlx::raw_sql("create database tenant_tpl")
            .execute(&admin)
            .await?;
    }
    let mut template = PgConnection::connect_with(
        &direct
            .parse::<sqlx::postgres::PgConnectOptions>()?
            .database("tenant_tpl"),
    )
    .await?;
    sqlx::raw_sql(TEMPLATE_SCHEMA)
        .execute(&mut template)
        .await?;
    template.close().await?;

    let started = Instant::now();
    let missing: Vec<String> = (0..tenants)
        .map(database_name)
        .filter(|name| !existing.contains(name))
        .collect();
    let missing = Arc::new(missing);
    let mut tasks = tokio::task::JoinSet::new();
    for worker in 0..parallel {
        let admin = admin.clone();
        let missing = Arc::clone(&missing);
        tasks.spawn(async move {
            for name in missing.iter().skip(worker).step_by(parallel) {
                // `name` is `ws_` and five digits from `database_name`, never
                // input, so it is safe to splice into DDL.
                let sql = format!("create database {name} template tenant_tpl strategy file_copy");
                sqlx::raw_sql(AssertSqlSafe(sql)).execute(&admin).await?;
            }
            Ok::<_, sqlx::Error>(())
        });
    }
    while let Some(result) = tasks.join_next().await {
        result??;
    }
    println!(
        "created {} databases in {:.1}s",
        missing.len(),
        started.elapsed().as_secs_f64()
    );

    sqlx::raw_sql(MASTER_SCHEMA).execute(&admin).await?;
    sqlx::query(
        "insert into workspaces (id, clerk_org_id, database_url)
         select 'ws_' || lpad(g::text, 5, '0'), 'org_' || g, $1 || 'ws_' || lpad(g::text, 5, '0')
         from generate_series(0, $2 - 1) g",
    )
    .bind(&pooled_base)
    .bind(i32::try_from(tenants)?)
    .execute(&admin)
    .await?;
    println!("seeded {tenants} workspaces pointing at {pooled_base}ws_NNNNN");
    Ok(())
}

struct Load {
    tenants: usize,
    active: usize,
    cold_fraction: f64,
    rotate_per_sec: u64,
    think_ms: usize,
    zipf: Option<Zipf>,
    started: Instant,
    measure_from: Instant,
    until: Instant,
}

#[derive(Default)]
struct WorkerResult {
    warm: Vec<u32>,
    cold: Vec<u32>,
    errors: Errors,
}

/// The pools `Workspaces` holds, mirrored: same LRU rule, so the count of
/// pools held and of pools opened can be reported without a hook in the
/// crate. Approximate under concurrency.
struct PoolMirror {
    cap: usize,
    pools: Mutex<(HashMap<usize, Instant>, u64)>,
}

impl PoolMirror {
    /// Records a use; true when this use opened a pool.
    fn touch(&self, index: usize, count: bool) -> bool {
        let mut guard = self.pools.lock().unwrap_or_else(PoisonError::into_inner);
        let (pools, opened) = &mut *guard;
        if let Some(last) = pools.get_mut(&index) {
            *last = Instant::now();
            return false;
        }
        if pools.len() >= self.cap
            && let Some(oldest) = pools.iter().min_by_key(|(_, at)| **at).map(|(i, _)| *i)
        {
            pools.remove(&oldest);
        }
        pools.insert(index, Instant::now());
        if count {
            *opened += 1;
        }
        true
    }

    fn held(&self) -> (usize, u64) {
        let guard = self.pools.lock().unwrap_or_else(PoisonError::into_inner);
        (guard.0.len(), guard.1)
    }
}

#[derive(Default, Clone, Copy)]
struct Sample {
    pools_pgbouncer: i64,
    clients: i64,
    servers: i64,
    backends: i64,
    waiting: i64,
}

pub(crate) async fn run(args: &Args) -> Result<(), Box<dyn Error>> {
    let master_url = args.string("master")?;
    let admin_url = args.string("admin")?;
    let duration = Duration::from_secs(args.get("duration", 90)?);
    let warmup = Duration::from_secs(args.get("warmup", 15)?);
    let defaults = WorkspaceConfig::default();
    let config = WorkspaceConfig {
        tenant_max_connections: args
            .get("tenant-max-connections", defaults.tenant_max_connections)?,
        max_tenant_pools: args.get("max-tenant-pools", defaults.max_tenant_pools)?,
        idle_timeout: Duration::from_secs(
            args.get("idle-timeout", defaults.idle_timeout.as_secs())?,
        ),
        ..defaults
    };
    let dist = args.get("dist", "uniform".to_owned())?;
    let active: usize = args.get("active", 300)?;
    let started = Instant::now();
    let load = Arc::new(Load {
        tenants: args.get("tenants", 2000)?,
        active,
        cold_fraction: args.get("cold", 0.05)?,
        rotate_per_sec: args.get("rotate", 5)?,
        think_ms: args.get("think-ms", 100)?,
        zipf: (dist == "zipf").then(|| Zipf::new(u32::try_from(active).unwrap_or(u32::MAX))),
        started,
        measure_from: started + warmup,
        until: started + warmup + duration,
    });
    println!(
        "s4 tenants={} active={} dist={dist} cold={} rotate={}/s think={}ms tenant_max_connections={} \
         max_tenant_pools={} idle_timeout={}s warmup={}s duration={}s",
        load.tenants,
        load.active,
        load.cold_fraction,
        load.rotate_per_sec,
        load.think_ms,
        config.tenant_max_connections,
        config.max_tenant_pools,
        config.idle_timeout.as_secs(),
        warmup.as_secs(),
        duration.as_secs()
    );

    let mirror = Arc::new(PoolMirror {
        cap: config.max_tenant_pools,
        pools: Mutex::new((HashMap::new(), 0)),
    });
    let master = master_pool(&master_url, 10)?;
    let monitor = PgPoolOptions::new()
        .max_connections(1)
        .connect(&master_url)
        .await?;
    let workspaces = Arc::new(Workspaces::new(master, Keyring::default(), config));

    let samples = Arc::new(Mutex::new(Vec::<Sample>::new()));
    let monitor_task = {
        let samples = Arc::clone(&samples);
        let load = Arc::clone(&load);
        let mirror = Arc::clone(&mirror);
        tokio::spawn(
            async move { sample_loop(&admin_url, &monitor, &load, &mirror, &samples).await },
        )
    };

    let mut tasks = tokio::task::JoinSet::new();
    for worker in 0..load.active {
        let workspaces = Arc::clone(&workspaces);
        let load = Arc::clone(&load);
        let mirror = Arc::clone(&mirror);
        tasks.spawn(async move { worker_loop(worker, &workspaces, &load, &mirror).await });
    }
    let mut all = WorkerResult::default();
    while let Some(result) = tasks.join_next().await {
        let result = result?;
        all.warm.extend(result.warm);
        all.cold.extend(result.cold);
        all.errors.merge(result.errors);
    }
    monitor_task.abort();
    report(all, &mirror, &samples, duration);
    Ok(())
}

fn report(
    mut all: WorkerResult,
    mirror: &PoolMirror,
    samples: &Mutex<Vec<Sample>>,
    duration: Duration,
) {
    let requests = all.warm.len() + all.cold.len();
    let mut every: Vec<u32> = all.warm.iter().chain(all.cold.iter()).copied().collect();
    let (held, opened) = mirror.held();
    let samples = samples
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let peak = |f: fn(&Sample) -> i64| samples.iter().map(f).max().unwrap_or(0);
    let last = samples.last().copied().unwrap_or_default();
    println!(
        "  requests={requests} ({:.0}/s) errors={}",
        f64::from(u32::try_from(requests).unwrap_or(u32::MAX)) / duration.as_secs_f64(),
        all.errors.total()
    );
    println!("  all : {}", Percentiles::of(&mut every));
    println!("  warm: {}", Percentiles::of(&mut all.warm));
    println!("  cold: {}", Percentiles::of(&mut all.cold));
    println!("  pools held (mirror) {held}, opened during measurement {opened}");
    println!(
        "  pgbouncer pools peak {} last {} | client conns peak {} last {} | server conns peak {} last {} | waiting peak {}",
        peak(|s| s.pools_pgbouncer),
        last.pools_pgbouncer,
        peak(|s| s.clients),
        last.clients,
        peak(|s| s.servers),
        last.servers,
        peak(|s| s.waiting),
    );
    println!(
        "  postgres tenant backends peak {} last {}",
        peak(|s| s.backends),
        last.backends
    );
    print!("{}", all.errors);
}

async fn worker_loop(
    worker: usize,
    workspaces: &Workspaces,
    load: &Load,
    mirror: &PoolMirror,
) -> WorkerResult {
    let mut rng = Rng::new(worker as u64 + 1);
    let mut result = WorkerResult::default();
    // Spread the first requests over the first think time.
    tokio::time::sleep(Duration::from_millis(rng.below(load.think_ms + 1) as u64)).await;
    loop {
        let now = Instant::now();
        if now >= load.until {
            return result;
        }
        let elapsed_ms = u64::try_from(now.duration_since(load.started).as_millis()).unwrap_or(0);
        let offset = usize::try_from(elapsed_ms * load.rotate_per_sec / 1000).unwrap_or(0);
        let cold_pick = rng.unit() < load.cold_fraction;
        let index = if cold_pick {
            rng.below(load.tenants)
        } else {
            let rank = match &load.zipf {
                Some(zipf) => zipf.sample(&mut rng),
                None => rng.below(load.active),
            };
            (offset + rank) % load.tenants
        };
        let item = i32::try_from(rng.below(100) + 1).unwrap_or(1);
        let measuring = now >= load.measure_from;

        let begun = Instant::now();
        let outcome = query(workspaces, index, item).await;
        let latency = micros(begun.elapsed());
        match outcome {
            Ok(()) => {
                let opened = mirror.touch(index, measuring);
                if measuring {
                    if opened {
                        &mut result.cold
                    } else {
                        &mut result.warm
                    }
                    .push(latency);
                }
            }
            Err(error) => {
                if measuring {
                    result.errors.add(&error.to_string());
                }
            }
        }
        let think = rng.below(2 * load.think_ms + 1);
        tokio::time::sleep(Duration::from_millis(think as u64)).await;
    }
}

async fn query(
    workspaces: &Workspaces,
    index: usize,
    item: i32,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let tenant = workspaces.tenant(&database_name(index)).await?;
    let row: Option<(i32, String)> = sqlx::query_as("select id, name from items where id = $1")
        .bind(item)
        .fetch_optional(&tenant.db)
        .await?;
    match row {
        Some((id, _)) if id == item => Ok(()),
        _ => Err("wrong row".into()),
    }
}

async fn sample_loop(
    admin_url: &str,
    monitor: &PgPool,
    load: &Load,
    mirror: &PoolMirror,
    samples: &Mutex<Vec<Sample>>,
) {
    let mut admin: Option<PgConnection> = None;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut n = 0u64;
    loop {
        tick.tick().await;
        n += 1;
        if admin.is_none() {
            admin = PgConnection::connect(admin_url).await.ok();
        }
        let mut sample = Sample::default();
        if let Some(conn) = admin.as_mut() {
            match show_lists(conn).await {
                Ok(lists) => {
                    let get = |key: &str| lists.get(key).copied().unwrap_or(0);
                    sample.pools_pgbouncer = get("pools");
                    sample.clients = get("used_clients");
                    sample.servers = get("used_servers");
                }
                Err(_) => admin = None,
            }
        }
        if let Some(conn) = admin.as_mut() {
            sample.waiting = show_pools_waiting(conn).await.unwrap_or(0);
        }
        sample.backends = sqlx::query_scalar(
            "select count(*) from pg_stat_activity where datname like 'ws\\_%' and backend_type = 'client backend'",
        )
        .fetch_one(monitor)
        .await
        .unwrap_or(-1);
        if Instant::now() >= load.measure_from {
            samples
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(sample);
        }
        if n.is_multiple_of(10) {
            let (held, opened) = mirror.held();
            println!(
                "  t={:>3}s pools(mirror)={held} opened={opened} pgb_pools={} clients={} servers={} waiting={} pg_backends={}",
                load.started.elapsed().as_secs(),
                sample.pools_pgbouncer,
                sample.clients,
                sample.servers,
                sample.waiting,
                sample.backends
            );
        }
    }
}

/// `SHOW LISTS` on the `PgBouncer` admin console (simple protocol, text
/// values).
async fn show_lists(conn: &mut PgConnection) -> Result<HashMap<String, i64>, sqlx::Error> {
    let rows = sqlx::raw_sql("SHOW LISTS").fetch_all(&mut *conn).await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let key: String = row.try_get_unchecked(0).ok()?;
            let value: String = row.try_get_unchecked(1).ok()?;
            Some((key, value.parse().ok()?))
        })
        .collect())
}

/// Clients waiting for a server connection, over all pools.
async fn show_pools_waiting(conn: &mut PgConnection) -> Result<i64, sqlx::Error> {
    let rows = sqlx::raw_sql("SHOW POOLS").fetch_all(&mut *conn).await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let value: String = row.try_get_unchecked("cl_waiting").ok()?;
            value.parse::<i64>().ok()
        })
        .sum())
}
