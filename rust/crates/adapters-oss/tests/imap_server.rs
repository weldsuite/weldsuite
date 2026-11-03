//! `AsyncImapConnector` against a real IMAP server. Runs when
//! `WELDSUITE_TEST_IMAPS` (implicit TLS, `host:port`) and
//! `WELDSUITE_TEST_IMAP_PLAIN` (the same server without TLS, for setting up
//! folders and messages) are set, e.g. `GreenMail`:
//!
//! ```text
//! docker run -d -p 3993:3993 -p 3143:3143 \
//!   -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 \
//!     -Dgreenmail.users=warm1:secret1@alpha.test -Dgreenmail.users.login=local_part" \
//!   greenmail/standalone:2.1.3
//! WELDSUITE_TEST_IMAPS=127.0.0.1:3993 WELDSUITE_TEST_IMAP_PLAIN=127.0.0.1:3143 \
//!   cargo test -p weldsuite-adapters-oss --test imap_server
//! ```
//!
//! The server's certificate is self-signed, so the test trusts any
//! certificate (its own verifier below); the adapter checks them against
//! the platform's roots.

use std::sync::Arc;
use std::time::Duration;

use futures_util::TryStreamExt;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use weldsuite_adapters_oss::AsyncImapConnector;
use weldsuite_ports::{ImapConfig, ImapConnector, ImapErrorKind, ImapSession, SpecialUse};

const USER: &str = "warm1";
const PASSWORD: &str = "secret1";

#[derive(Debug)]
struct AnyCertificate(Arc<rustls::crypto::CryptoProvider>);

impl ServerCertVerifier for AnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn connector() -> AsyncImapConnector {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .expect("protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyCertificate(provider)))
        .with_no_client_auth();
    AsyncImapConnector::with_tls_config(Arc::new(config)).any_port()
}

fn config(address: &str, password: &str) -> ImapConfig {
    let (host, port) = address.rsplit_once(':').expect("host:port");
    let mut config = ImapConfig::new(host, port.parse().expect("port"), USER, password);
    config.command_timeout = Duration::from_secs(10);
    config
}

fn message(id: &str) -> String {
    format!(
        "From: Ann <ann@beta.test>\r\nTo: Warm <warm1@alpha.test>\r\nSubject: Quick question\r\nMessage-ID: <{id}>\r\nDate: Tue, 3 Nov 2026 10:00:00 +0000\r\n\r\nHi there.\r\n"
    )
}

/// Folders and messages over plain IMAP, with async-imap itself.
async fn set_up(plain: &str, run: &str) {
    let tcp = tokio::net::TcpStream::connect(plain)
        .await
        .expect("plain IMAP");
    let mut client = async_imap::Client::new(tcp);
    client.read_response().await.expect("greeting");
    let mut session = client
        .login(USER, PASSWORD)
        .await
        .map_err(|(e, _)| e)
        .expect("login");
    for folder in ["Junk", "Trash"] {
        // Already there from an earlier run: fine.
        let _ = session.create(folder).await;
    }
    for (folder, id) in [
        ("Junk", format!("junk-{run}@beta.test")),
        ("INBOX", format!("inbox-{run}@beta.test")),
    ] {
        session
            .append(folder, None, None, message(&id).as_bytes())
            .await
            .expect("append");
    }
    session.logout().await.expect("logout");
}

async fn flags_of(plain: &str, folder: &str, id: &str) -> Vec<String> {
    let tcp = tokio::net::TcpStream::connect(plain)
        .await
        .expect("plain IMAP");
    let mut client = async_imap::Client::new(tcp);
    client.read_response().await.expect("greeting");
    let mut session = client
        .login(USER, PASSWORD)
        .await
        .map_err(|(e, _)| e)
        .expect("login");
    session.select(folder).await.expect("select");
    let uids = session
        .uid_search(format!("HEADER Message-ID \"<{id}>\""))
        .await
        .expect("search");
    let mut flags = Vec::new();
    for uid in uids {
        let fetched: Vec<_> = session
            .uid_fetch(uid.to_string(), "FLAGS")
            .await
            .expect("fetch")
            .try_collect()
            .await
            .expect("fetched");
        for fetch in &fetched {
            flags.extend(fetch.flags().map(|flag| format!("{flag:?}")));
        }
    }
    session.logout().await.expect("logout");
    flags
}

/// A wrong password, a port other than 993, nothing listening.
async fn refusals(imap: &AsyncImapConnector, imaps: &str) {
    // A wrong password is a rejected login, not a transient failure.
    let refused = imap
        .connect(&config(imaps, "wrong"))
        .await
        .err()
        .expect("refused");
    assert!(refused.auth_failed(), "{refused:?}");
    assert_eq!(refused.command.as_deref(), Some("LOGIN"));

    // Port 993 only, unless the connector says otherwise.
    let strict = AsyncImapConnector::new().expect("connector");
    let off_port = strict
        .connect(&config(imaps, PASSWORD))
        .await
        .err()
        .expect("port");
    assert_eq!(off_port.kind, ImapErrorKind::Connect);

    let closed = imap
        .connect(&config("127.0.0.1:1", PASSWORD))
        .await
        .err()
        .expect("closed");
    assert_eq!(closed.kind, ImapErrorKind::Connect);
}

const NONE: Vec<u32> = Vec::new();

/// Find it in Junk (by name: no SPECIAL-USE here), rescue it into INBOX,
/// open and flag it.
async fn engage(session: &mut dyn ImapSession, junk_id: &str) {
    session.select("INBOX").await.expect("inbox");
    assert_eq!(
        session.search_by_message_id(junk_id).await.expect("search"),
        NONE
    );
    let junk = session
        .find_special_use(SpecialUse::Junk)
        .await
        .expect("list")
        .expect("a junk folder");
    assert_eq!(junk, "Junk");
    let selected = session.select(&junk).await.expect("junk");
    assert!(selected.exists >= 1);
    let in_junk = session.search_by_message_id(junk_id).await.expect("search");
    assert_eq!(in_junk.len(), 1);

    session
        .move_messages(&in_junk, "INBOX")
        .await
        .expect("moved");
    assert_eq!(
        session.search_by_message_id(junk_id).await.expect("search"),
        NONE
    );
    session.select("INBOX").await.expect("inbox");
    let rescued = session
        .search_by_message_id(&format!("<{junk_id}>"))
        .await
        .expect("search");
    assert_eq!(rescued.len(), 1);
    session
        .add_flags(&rescued, &["\\Seen", "\\Flagged"])
        .await
        .expect("flags");

    // An unknown folder is a command error; the session stays usable.
    let missing = session.select("No Such Folder").await.expect_err("missing");
    assert_eq!(missing.kind, ImapErrorKind::Command);
    session.select("INBOX").await.expect("inbox");
}

/// Cleanup: move to Trash, then delete it there.
async fn clean_up(session: &mut dyn ImapSession, inbox_id: &str) {
    let trash = session
        .find_special_use(SpecialUse::Trash)
        .await
        .expect("list")
        .expect("trash");
    let old = session
        .search_by_message_id(inbox_id)
        .await
        .expect("search");
    session.move_messages(&old, &trash).await.expect("trashed");
    session.select(&trash).await.expect("trash");
    let trashed = session
        .search_by_message_id(inbox_id)
        .await
        .expect("search");
    assert_eq!(trashed.len(), 1);
    session.delete_messages(&trashed).await.expect("deleted");
    assert_eq!(
        session
            .search_by_message_id(inbox_id)
            .await
            .expect("search"),
        NONE
    );
}

#[tokio::test]
async fn a_warmup_engagement_against_a_real_server() {
    let (Ok(imaps), Ok(plain)) = (
        std::env::var("WELDSUITE_TEST_IMAPS"),
        std::env::var("WELDSUITE_TEST_IMAP_PLAIN"),
    ) else {
        eprintln!("skipped: WELDSUITE_TEST_IMAPS / WELDSUITE_TEST_IMAP_PLAIN not set");
        return;
    };
    let run = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos()
        .to_string();
    set_up(&plain, &run).await;
    let imap = connector();
    refusals(&imap, &imaps).await;

    let mut session = imap
        .connect(&config(&imaps, PASSWORD))
        .await
        .expect("session");
    let junk_id = format!("junk-{run}@beta.test");
    engage(session.as_mut(), &junk_id).await;
    clean_up(session.as_mut(), &format!("inbox-{run}@beta.test")).await;
    session.logout().await;

    let flags = flags_of(&plain, "INBOX", &junk_id).await;
    assert!(flags.iter().any(|f| f == "Seen"), "{flags:?}");
    assert!(flags.iter().any(|f| f == "Flagged"), "{flags:?}");
}
