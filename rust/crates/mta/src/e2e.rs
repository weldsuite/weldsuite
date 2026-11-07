//! End to end, against a real Postgres (`WELDSUITE_TEST_DATABASE_URL`, as
//! the other database tests; skipped without it): a throwaway database,
//! the whole MTA (`run::run`), a fake DNS server and a fake receiving MX on
//! localhost.
//!
//! 1. Submission: auth picks the pool, an unregistered sender domain is
//!    refused, a registered one is queued.
//! 2. Delivery: MX lookup, the VERP return path, a DKIM signature that
//!    verifies, the `delivered` event in the outbox.
//! 3. A permanent refusal: a hard bounce, the event, and the recipient
//!    suppressed at the next submission.
//! 4. The return path: a DSN to the VERP address of a delivered recipient
//!    turns it into a late hard bounce.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use sqlx::Connection as _;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::dns::wire;
use crate::store::Store;

const KEY_B64: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

struct Scratch {
    admin_url: String,
    name: String,
    url: String,
}

impl Scratch {
    async fn create() -> Option<Self> {
        let admin_url = std::env::var("WELDSUITE_TEST_DATABASE_URL").ok()?;
        let name = format!("mta_e2e_{}", crate::crypto::random_hex(6));
        let mut admin = sqlx::PgConnection::connect(&admin_url)
            .await
            .expect("admin connection");
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE DATABASE {name}")))
            .execute(&mut admin)
            .await
            .expect("create database");
        let base = admin_url
            .rsplit_once('/')
            .map_or(admin_url.as_str(), |(base, _)| base);
        let url = format!("{base}/{name}");
        Some(Self {
            admin_url,
            name,
            url,
        })
    }

    async fn drop_it(self) {
        if let Ok(mut admin) = sqlx::PgConnection::connect(&self.admin_url).await {
            let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
                "DROP DATABASE IF EXISTS {} WITH (FORCE)",
                self.name
            )))
            .execute(&mut admin)
            .await;
        }
    }
}

/// What the fake MX accepted: (MAIL FROM, RCPT TO, data) per message.
type Received = Arc<Mutex<Vec<(String, String, Vec<u8>)>>>;

/// A receiving MX: refuses `nobody@`, accepts the rest, keeps what it got.
async fn fake_mx(received: Received) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                return;
            };
            let received = Arc::clone(&received);
            tokio::spawn(async move {
                let (read, mut write) = socket.into_split();
                let mut read = BufReader::new(read);
                let _ = write.write_all(b"220 mx.example.test ESMTP\r\n").await;
                let (mut from, mut to, mut data, mut in_data) =
                    (String::new(), String::new(), Vec::new(), false);
                let mut line = String::new();
                loop {
                    line.clear();
                    if read.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    if in_data {
                        if line == ".\r\n" {
                            in_data = false;
                            received.lock().expect("lock").push((
                                from.clone(),
                                to.clone(),
                                std::mem::take(&mut data),
                            ));
                            let _ = write.write_all(b"250 2.0.0 accepted\r\n").await;
                        } else {
                            let content = line.strip_prefix('.').unwrap_or(&line);
                            data.extend_from_slice(content.as_bytes());
                        }
                        continue;
                    }
                    let upper = line.to_ascii_uppercase();
                    let reply: &[u8] = if upper.starts_with("EHLO") {
                        b"250-mx.example.test\r\n250-8BITMIME\r\n250 SIZE 100000000\r\n"
                    } else if upper.starts_with("MAIL FROM:") {
                        from = line[10..]
                            .trim()
                            .trim_start_matches('<')
                            .split('>')
                            .next()
                            .unwrap_or("")
                            .to_owned();
                        b"250 2.1.0 ok\r\n"
                    } else if upper.starts_with("RCPT TO:") {
                        to = line[8..]
                            .trim()
                            .trim_start_matches('<')
                            .split('>')
                            .next()
                            .unwrap_or("")
                            .to_owned();
                        if to.starts_with("nobody@") {
                            b"550 5.1.1 no such user\r\n"
                        } else {
                            b"250 2.1.5 ok\r\n"
                        }
                    } else if upper.starts_with("DATA") {
                        in_data = true;
                        b"354 go\r\n"
                    } else if upper.starts_with("QUIT") {
                        b"221 bye\r\n"
                    } else {
                        b"250 ok\r\n"
                    };
                    let _ = write.write_all(reply).await;
                }
            });
        }
    });
    port
}

async fn dns() -> SocketAddr {
    crate::dns::tests::fake_server(|name, qtype| match (name, qtype) {
        ("example.test", wire::TYPE_MX) => (
            0,
            vec![(
                "example.test".into(),
                wire::TYPE_MX,
                wire::tests::mx_rdata(10, "mx.example.test"),
            )],
        ),
        ("mx.example.test", wire::TYPE_A) => (
            0,
            vec![("mx.example.test".into(), wire::TYPE_A, vec![127, 0, 0, 1])],
        ),
        _ => (0, vec![]),
    })
    .await
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .expect("free port")
}

/// The code of the next (possibly multi-line) reply.
async fn code(read: &mut BufReader<tokio::net::tcp::OwnedReadHalf>) -> u16 {
    let mut line = String::new();
    loop {
        line.clear();
        read.read_line(&mut line).await.expect("read");
        if line.as_bytes().get(3) != Some(&b'-') {
            return line[..3].parse().expect("code");
        }
    }
}

/// Sends one message through submission; returns every reply code.
async fn submit(
    addr: SocketAddr,
    user: &str,
    password: &str,
    from: &str,
    to: &[&str],
    body: &str,
) -> Vec<u16> {
    let stream = TcpStream::connect(addr).await.expect("connect");
    let (read, mut write) = stream.into_split();
    let mut read = BufReader::new(read);
    let mut codes = Vec::new();
    codes.push(code(&mut read).await);
    let plain = base64::engine::general_purpose::STANDARD.encode(format!("\0{user}\0{password}"));
    let mut commands = vec![
        "EHLO client.test".to_owned(),
        format!("AUTH PLAIN {plain}"),
        format!("MAIL FROM:<{from}>"),
    ];
    commands.extend(to.iter().map(|t| format!("RCPT TO:<{t}>")));
    for command in commands {
        write
            .write_all(format!("{command}\r\n").as_bytes())
            .await
            .expect("write");
        codes.push(code(&mut read).await);
    }
    // DATA only when a recipient was accepted.
    if codes.len() > 4 && codes[4..].contains(&250) {
        write.write_all(b"DATA\r\n").await.expect("write");
        codes.push(code(&mut read).await);
        write
            .write_all(format!("{body}\r\n.\r\n").as_bytes())
            .await
            .expect("write");
        codes.push(code(&mut read).await);
    }
    let _ = write.write_all(b"QUIT\r\n").await;
    codes
}

async fn wait_for<F: std::future::Future<Output = bool>>(mut check: impl FnMut() -> F) {
    for _ in 0..100 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting");
}

/// The listener ports the test MTA is configured with.
struct Ports {
    submission: u16,
    api: u16,
    inbound: u16,
    mx: u16,
}

/// The MTA's configuration: both pools, `acme.eu`'s bounce domain, the fake
/// DNS server and MX.
fn config(database_url: &str, ports: &Ports, resolver: SocketAddr) -> Config {
    let mut vars: BTreeMap<String, String> = BTreeMap::new();
    for (k, v) in [
        ("MTA_DATABASE_URL", database_url),
        ("MTA_KEY", KEY_B64),
        ("MTA_API_SECRET", "api-secret"),
        ("MTA_SUBMISSION_PASSWORD_SYSTEM", "sys-pw"),
        ("MTA_SUBMISSION_PASSWORD_CUSTOMER", "cust-pw"),
        ("MTA_POOLS", "system,customer"),
        ("MTA_HOSTNAME", "mail1-customer.eu.test"),
        ("MTA_SOURCE_IP", "127.0.0.1"),
        ("MTA_BOUNCE_DOMAIN", "bounces.eu.test"),
        ("MTA_WARMUP_SCHEDULE", "off"),
        ("MTA_ALLOW_PRIVATE_DESTINATIONS", "true"),
    ] {
        vars.insert(k.into(), v.into());
    }
    vars.insert(
        "MTA_SUBMISSION_ADDR".into(),
        format!("127.0.0.1:{}", ports.submission),
    );
    vars.insert("MTA_API_ADDR".into(), format!("127.0.0.1:{}", ports.api));
    vars.insert(
        "MTA_INBOUND_ADDR".into(),
        format!("127.0.0.1:{}", ports.inbound),
    );
    vars.insert("MTA_RESOLVER".into(), resolver.to_string());
    vars.insert("MTA_DELIVERY_PORT".into(), ports.mx.to_string());
    Config::from_lookup(&|n| vars.get(n).cloned(), vars.keys().map(String::as_str)).expect("config")
}

/// Step 1: auth picks the pool, and a sender domain must be registered for
/// that pool.
async fn check_pools_and_sender_domains(submission: SocketAddr) {
    let refused = submit(
        submission,
        "customer",
        "wrong",
        "anna@acme.eu",
        &["bob@example.test"],
        "x",
    )
    .await;
    assert_eq!(refused[2], 535);
    let refused = submit(
        submission,
        "customer",
        "cust-pw",
        "anna@other.eu",
        &["bob@example.test"],
        "x",
    )
    .await;
    assert_eq!(refused[3], 550, "unregistered sender domain");
    let refused = submit(
        submission,
        "system",
        "sys-pw",
        "anna@acme.eu",
        &["bob@example.test"],
        "x",
    )
    .await;
    assert_eq!(refused[3], 550, "acme.eu is for the customer pool only");
}

/// Step 2: bob is delivered (VERP return path, DKIM that verifies), nobody
/// bounces, both events reach the outbox. Returns bob's return path.
async fn check_delivery(
    submission: SocketAddr,
    store: &Store,
    received: &Received,
    public_key: &str,
    body: &str,
) -> String {
    let accepted = submit(
        submission,
        "customer",
        "cust-pw",
        "anna@acme.eu",
        &["bob@example.test", "nobody@example.test"],
        body,
    )
    .await;
    assert_eq!(accepted.last(), Some(&250), "{accepted:?}");
    wait_for(|| async {
        let stats = store.stats().await.expect("stats");
        stats["pools"]["customer"]["delivered"] == 1 && stats["pools"]["customer"]["bounced"] == 1
    })
    .await;
    let (mail_from, to, data) = received.lock().expect("lock")[0].clone();
    assert_eq!(to, "bob@example.test");
    assert!(
        mail_from.starts_with("b+r") && mail_from.ends_with("@bounces.eu.test"),
        "{mail_from}"
    );
    let text = String::from_utf8_lossy(&data).into_owned();
    assert!(text.contains("X-WeldSuite-Mta-Id: r"));
    assert!(text.contains("Feedback-ID: customer:acme.eu:weldsuite"));
    // The signature verifies once our per-recipient header is set aside.
    let signed = text
        .split_once("\r\n")
        .map(|(_, rest)| rest)
        .expect("headers");
    crate::dkim::verify(signed.as_bytes(), public_key).expect("DKIM verifies");

    let events: Vec<String> =
        sqlx::query_scalar("SELECT event->>'type' FROM mta_outbox ORDER BY id")
            .fetch_all(store.pool())
            .await
            .expect("outbox");
    assert!(events.contains(&"cf.email.sending.message.delivered".to_owned()));
    assert!(events.contains(&"cf.email.sending.message.bounced".to_owned()));
    mail_from
}

/// A DSN reporting bob's mailbox gone.
const LATE_DSN: &str = "From: MAILER-DAEMON@example.test\r\nContent-Type: multipart/report; report-type=delivery-status; boundary=\"z\"\r\n\r\n\
--z\r\nContent-Type: text/plain\r\n\r\nsorry\r\n--z\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; mx.example.test\r\n\r\n\
Final-Recipient: rfc822; bob@example.test\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 5.1.1 mailbox gone\r\n\r\n--z--";

/// Sends `LATE_DSN` to the bounce MX at `mail_from` (and to an address
/// that is not a return path); returns the reply codes, space-separated.
async fn send_late_dsn(inbound_port: u16, mail_from: &str) -> String {
    let stream = TcpStream::connect(("127.0.0.1", inbound_port))
        .await
        .expect("bounce MX");
    let (read, mut write) = stream.into_split();
    let mut read = BufReader::new(read);
    let mut line = String::new();
    let mut last = String::new();
    read.read_line(&mut line).await.expect("greeting");
    for command in [
        "HELO mx.example.test".to_owned(),
        "MAIL FROM:<>".into(),
        format!("RCPT TO:<{mail_from}>"),
        "RCPT TO:<anna@bounces.eu.test>".into(),
        "DATA".into(),
        format!("{LATE_DSN}\r\n."),
    ] {
        write
            .write_all(format!("{command}\r\n").as_bytes())
            .await
            .expect("write");
        line.clear();
        read.read_line(&mut line).await.expect("reply");
        last.push_str(&line[..3]);
        last.push(' ');
    }
    last
}

#[tokio::test(flavor = "multi_thread")]
async fn submits_delivers_bounces_and_takes_late_bounces() {
    let Some(scratch) = Scratch::create().await else {
        eprintln!("WELDSUITE_TEST_DATABASE_URL not set: skipped");
        return;
    };
    let received = Arc::new(Mutex::new(Vec::new()));
    let mx_port = fake_mx(Arc::clone(&received)).await;
    let resolver = dns().await;
    let ports = Ports {
        submission: free_port(),
        api: free_port(),
        inbound: free_port(),
        mx: mx_port,
    };
    let config = config(&scratch.url, &ports, resolver);
    let keys = config.base.keys.clone();

    let store = Store::connect(&scratch.url, 4).expect("store");
    store.migrate().await.expect("migrate");
    let (domain, _) = crate::domains::register(&store, &keys, "acme.eu", &["customer".into()])
        .await
        .expect("register");

    let shutdown = CancellationToken::new();
    let mta = tokio::spawn(crate::run::run(config, shutdown.clone()));
    let submission: SocketAddr = format!("127.0.0.1:{}", ports.submission)
        .parse()
        .expect("addr");
    wait_for(|| async { TcpStream::connect(submission).await.is_ok() }).await;

    // 1. Pools and sender domains.
    check_pools_and_sender_domains(submission).await;

    // 2. Delivery.
    let body =
        "From: Anna <anna@acme.eu>\r\nTo: bob@example.test\r\nSubject: Hello\r\n\r\nHi Bob\r\n";
    let mail_from = check_delivery(submission, &store, &received, &domain.public_key, body).await;

    // 3. The hard bounce is suppressed now.
    let suppressed = submit(
        submission,
        "customer",
        "cust-pw",
        "anna@acme.eu",
        &["nobody@example.test"],
        body,
    )
    .await;
    assert_eq!(suppressed[4], 550);

    // 4. A late DSN for bob.
    let recipient_id = mail_from
        .trim_start_matches("b+")
        .split('-')
        .next()
        .expect("id")
        .to_owned();
    let last = send_late_dsn(ports.inbound, &mail_from).await;
    assert_eq!(last.trim(), "250 250 250 550 354 250");
    let status: String = sqlx::query_scalar("SELECT status FROM mta_recipients WHERE id = $1")
        .bind(&recipient_id)
        .fetch_one(store.pool())
        .await
        .expect("recipient");
    assert_eq!(status, "bounced");
    assert!(
        store
            .is_suppressed("customer", "bob@example.test")
            .await
            .expect("suppressed")
    );

    shutdown.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(60), mta).await;
    store.pool().close().await;
    scratch.drop_it().await;
}

/// A worker whose lease ran out records nothing: no status change, no
/// event, no suppression; the worker that owns it now does.
#[tokio::test(flavor = "multi_thread")]
async fn a_stale_lease_records_nothing() {
    let Some(scratch) = Scratch::create().await else {
        eprintln!("WELDSUITE_TEST_DATABASE_URL not set: skipped");
        return;
    };
    let store = Store::connect(&scratch.url, 4).expect("store");
    store.migrate().await.expect("migrate");
    store
        .enqueue(
            "customer",
            "a@acme.eu",
            "a@acme.eu",
            b"Subject: x\r\n\r\nx\r\n",
            &["bob@example.test".into()],
        )
        .await
        .expect("enqueue");
    let pools = vec!["customer".to_owned()];
    let claimed = store
        .claim(&pools, "worker-a", 10, Duration::from_secs(60))
        .await
        .expect("claim")
        .remove(0);
    // Worker A's lease lapses and worker B takes the row.
    sqlx::query("UPDATE mta_recipients SET lease_until = now() - interval '1 second'")
        .execute(store.pool())
        .await
        .expect("expire");
    let again = store
        .claim(&pools, "worker-b", 10, Duration::from_secs(60))
        .await
        .expect("claim");
    assert_eq!(again.len(), 1);

    let bounced = crate::store::Outcome::Bounced {
        response: "550 5.1.1 gone".into(),
        hard: true,
    };
    assert!(
        !store
            .renew(&claimed.id, "worker-a", Duration::from_secs(60))
            .await
            .expect("renew")
    );
    assert!(
        !store
            .finish(&claimed, "worker-a", "a@acme.eu", &bounced)
            .await
            .expect("finish")
    );
    let events: i64 = sqlx::query_scalar("SELECT count(*) FROM mta_outbox")
        .fetch_one(store.pool())
        .await
        .expect("count");
    assert_eq!(events, 0);
    assert!(
        !store
            .is_suppressed("customer", "bob@example.test")
            .await
            .expect("suppressed")
    );

    let delivered = crate::store::Outcome::Delivered {
        response: "250 ok".into(),
    };
    assert!(
        store
            .finish(&again[0], "worker-b", "a@acme.eu", &delivered)
            .await
            .expect("finish")
    );
    // A second outcome for a final recipient is refused too.
    assert!(
        !store
            .finish(&again[0], "worker-b", "a@acme.eu", &bounced)
            .await
            .expect("finish")
    );
    let events: i64 = sqlx::query_scalar("SELECT count(*) FROM mta_outbox")
        .fetch_one(store.pool())
        .await
        .expect("count");
    assert_eq!(events, 1);

    store.pool().close().await;
    scratch.drop_it().await;
}
