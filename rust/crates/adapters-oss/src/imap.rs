//! IMAP for the WeldReach warmup network ([`weldsuite_ports::ImapConnector`]):
//! `async-imap` over TCP and rustls (`@weldsuite/imap` speaks it over
//! `cloudflare:sockets` on Global). Implicit TLS on port 993 only, LOGIN,
//! server certificates checked by the platform verifier, a timeout on every
//! command. Every failure is an [`ImapError`]: a LOGIN answered `NO` is
//! `auth` (it needs a person), a refused or dropped connection `connect`, a
//! server that does not answer in time `timeout`.

use std::collections::BTreeSet;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_imap::error::Error as RawError;
use async_imap::types::{Name, NameAttribute};
use futures_util::TryStreamExt;
use rustls::pki_types::ServerName;
use rustls_platform_verifier::BuilderVerifierExt;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use weldsuite_ports::imap::{IMAPS_PORT, bracketed_message_id, pick_special_use};
use weldsuite_ports::{
    BoxFuture, ImapConfig, ImapConnector, ImapError, ImapErrorKind, ImapSession, MailboxInfo,
    PortError, SelectResult, SpecialUse,
};

type Stream = TlsStream<TcpStream>;
type RawSession = async_imap::Session<Stream>;

/// How long LOGOUT may take before the socket is simply dropped.
const LOGOUT_TIMEOUT: Duration = Duration::from_secs(5);

/// Opens IMAP sessions over TLS.
#[derive(Clone)]
pub struct AsyncImapConnector {
    tls: TlsConnector,
    imaps_port_only: bool,
}

impl std::fmt::Debug for AsyncImapConnector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AsyncImapConnector")
            .field("imaps_port_only", &self.imaps_port_only)
            .finish_non_exhaustive()
    }
}

impl AsyncImapConnector {
    /// Certificates checked against the platform's roots (as lettre does
    /// for SMTP), port 993 only.
    pub fn new() -> Result<Self, PortError> {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(PortError::backend)?
            .with_platform_verifier()
            .map_err(PortError::backend)?
            .with_no_client_auth();
        Ok(Self::with_tls_config(Arc::new(config)))
    }

    /// With the caller's TLS settings (a test server's certificate).
    pub fn with_tls_config(config: Arc<rustls::ClientConfig>) -> Self {
        Self {
            tls: TlsConnector::from(config),
            imaps_port_only: true,
        }
    }

    /// Accept any port (a test server on a high port); still implicit TLS.
    #[must_use]
    pub fn any_port(mut self) -> Self {
        self.imaps_port_only = false;
        self
    }

    async fn open(&self, config: &ImapConfig) -> Result<Box<dyn ImapSession>, ImapError> {
        check_config(config, self.imaps_port_only)?;
        let address = format!("{}:{}", config.host, config.port);
        let limit = config.command_timeout;
        let connect_error = |detail: String| {
            ImapError::new(
                ImapErrorKind::Connect,
                format!("Could not connect to {address}: {detail}"),
            )
        };
        let tcp = timed(limit, "CONNECT", TcpStream::connect(address.as_str()))
            .await?
            .map_err(|error| connect_error(error.to_string()))?;
        let server_name = ServerName::try_from(config.host.clone())
            .map_err(|error| connect_error(error.to_string()))?;
        let tls = timed(limit, "CONNECT", self.tls.connect(server_name, tcp))
            .await?
            .map_err(|error| connect_error(error.to_string()))?;

        let mut client = async_imap::Client::new(tls);
        let greeting = timed(limit, "GREETING", client.read_response())
            .await?
            .map_err(|error| connect_error(error.to_string()))?;
        let Some(greeting) = greeting else {
            return Err(connect_error("the server closed the connection".to_owned()));
        };
        if let async_imap::imap_proto::Response::Data {
            status: async_imap::imap_proto::Status::Bye,
            outcome,
        } = greeting.parsed()
        {
            return Err(connect_error(format!(
                "BYE {}",
                outcome.information.as_deref().unwrap_or_default()
            )));
        }

        let login = timed(
            limit,
            "LOGIN",
            client.login(&config.username, &config.password),
        )
        .await?;
        let mut session = match login {
            Ok(session) => session,
            Err((error, _client)) => return Err(login_error(error)),
        };
        let capabilities = timed(limit, "CAPABILITY", session.capabilities())
            .await?
            .map_err(|error| command_error("CAPABILITY", error))?;
        let capabilities: BTreeSet<String> = capabilities
            .iter()
            .filter_map(|capability| match capability {
                async_imap::types::Capability::Atom(atom) => Some(atom.to_uppercase()),
                async_imap::types::Capability::Imap4rev1 => Some("IMAP4REV1".to_owned()),
                async_imap::types::Capability::Auth(_) => None,
            })
            .collect();
        Ok(Box::new(AsyncImapSession {
            session,
            capabilities,
            timeout: limit,
            mailboxes: None,
        }))
    }
}

impl ImapConnector for AsyncImapConnector {
    fn connect<'a>(
        &'a self,
        config: &'a ImapConfig,
    ) -> BoxFuture<'a, Result<Box<dyn ImapSession>, ImapError>> {
        Box::pin(self.open(config))
    }
}

/// `checkConfig(config)`.
fn check_config(config: &ImapConfig, imaps_port_only: bool) -> Result<(), ImapError> {
    if imaps_port_only && config.port != IMAPS_PORT {
        return Err(ImapError::new(
            ImapErrorKind::Connect,
            format!(
                "Port {} is not supported: IMAP is spoken over implicit TLS on port {IMAPS_PORT} only",
                config.port
            ),
        ));
    }
    if config.host.trim().is_empty() {
        return Err(ImapError::new(
            ImapErrorKind::Connect,
            "No IMAP server host given",
        ));
    }
    if config.username.contains('\0') || config.password.contains('\0') {
        return Err(ImapError::new(
            ImapErrorKind::Auth,
            "IMAP credentials cannot contain NUL characters",
        )
        .with_command("LOGIN"));
    }
    Ok(())
}

/// A command with the session's timeout.
async fn timed<T>(
    limit: Duration,
    command: &str,
    future: impl Future<Output = T>,
) -> Result<T, ImapError> {
    tokio::time::timeout(limit, future).await.map_err(|_| {
        ImapError::new(
            ImapErrorKind::Timeout,
            format!("{command}: no reply within {} ms", limit.as_millis()),
        )
        .with_command(command)
    })
}

/// `loginError(result)`: NO is `auth`, BAD a `command` error.
fn login_error(error: RawError) -> ImapError {
    match error {
        RawError::No(text) => ImapError::new(
            ImapErrorKind::Auth,
            format!("IMAP login rejected: NO {text}").trim().to_owned(),
        )
        .with_command("LOGIN")
        .with_response(text),
        RawError::Bad(text) => ImapError::new(
            ImapErrorKind::Command,
            format!("IMAP login rejected: BAD {text}").trim().to_owned(),
        )
        .with_command("LOGIN")
        .with_response(text),
        other => command_error("LOGIN", other),
    }
}

/// An `async-imap` error as the TypeScript client reports it.
fn command_error(command: &str, error: RawError) -> ImapError {
    let (kind, message, response) = match error {
        RawError::No(text) => (
            ImapErrorKind::Command,
            format!("{command} failed: NO {text}"),
            Some(text),
        ),
        RawError::Bad(text) => (
            ImapErrorKind::Command,
            format!("{command} failed: BAD {text}"),
            Some(text),
        ),
        RawError::Io(error) => (
            ImapErrorKind::Connect,
            format!("{command}: connection failed: {error}"),
            None,
        ),
        RawError::ConnectionLost => (
            ImapErrorKind::Connect,
            format!("{command}: the connection was closed"),
            None,
        ),
        RawError::Validate(error) => (ImapErrorKind::Command, format!("{command}: {error}"), None),
        other => (ImapErrorKind::Protocol, format!("{command}: {other}"), None),
    };
    let error = ImapError::new(kind, message.trim().to_owned()).with_command(command);
    match response {
        Some(text) => error.with_response(text),
        None => error,
    }
}

/// `compressUids(uids)`: ascending runs as ranges, `1:3,7`.
fn compress_uids(uids: &[u32]) -> String {
    let mut sorted: Vec<u32> = uids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut parts: Vec<String> = Vec::new();
    let mut index = 0;
    while index < sorted.len() {
        let start = sorted[index];
        let mut end = start;
        while index + 1 < sorted.len() && sorted[index + 1] == end + 1 {
            index += 1;
            end = sorted[index];
        }
        parts.push(if start == end {
            start.to_string()
        } else {
            format!("{start}:{end}")
        });
        index += 1;
    }
    parts.join(",")
}

/// A quoted IMAP string.
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn flag_list(flags: &[&str]) -> String {
    format!("({})", flags.join(" "))
}

fn attribute_text(attribute: &NameAttribute<'_>) -> String {
    match attribute {
        NameAttribute::NoInferiors => "\\Noinferiors".to_owned(),
        NameAttribute::NoSelect => "\\Noselect".to_owned(),
        NameAttribute::Marked => "\\Marked".to_owned(),
        NameAttribute::Unmarked => "\\Unmarked".to_owned(),
        NameAttribute::All => "\\All".to_owned(),
        NameAttribute::Archive => "\\Archive".to_owned(),
        NameAttribute::Drafts => "\\Drafts".to_owned(),
        NameAttribute::Flagged => "\\Flagged".to_owned(),
        NameAttribute::Junk => "\\Junk".to_owned(),
        NameAttribute::Sent => "\\Sent".to_owned(),
        NameAttribute::Trash => "\\Trash".to_owned(),
        NameAttribute::Extension(text) => text.to_string(),
        other => format!("{other:?}"),
    }
}

fn mailbox_info(name: &Name) -> MailboxInfo {
    MailboxInfo::new(
        name.name(),
        name.delimiter(),
        name.attributes().iter().map(attribute_text).collect(),
    )
}

struct AsyncImapSession {
    session: RawSession,
    capabilities: BTreeSet<String>,
    timeout: Duration,
    mailboxes: Option<Vec<MailboxInfo>>,
}

impl AsyncImapSession {
    async fn list(&mut self, pattern: &str) -> Result<Vec<MailboxInfo>, RawError> {
        let names: Vec<Name> = self
            .session
            .list(Some(""), Some(pattern))
            .await?
            .try_collect()
            .await?;
        Ok(names.iter().map(mailbox_info).collect())
    }

    /// LIST with the SPECIAL-USE return option when advertised; plain LIST
    /// when the server refuses it.
    async fn list_all(&mut self) -> Result<Vec<MailboxInfo>, ImapError> {
        let limit = self.timeout;
        if self.capabilities.contains("SPECIAL-USE") {
            match timed(limit, "LIST", self.list("\"*\" RETURN (SPECIAL-USE)")).await? {
                Ok(mailboxes) => return Ok(mailboxes),
                Err(RawError::No(_) | RawError::Bad(_)) => {}
                Err(error) => return Err(command_error("LIST", error)),
            }
        }
        timed(limit, "LIST", self.list("\"*\""))
            .await?
            .map_err(|error| command_error("LIST", error))
    }

    async fn store(&mut self, set: &str, item: &str) -> Result<(), ImapError> {
        let limit = self.timeout;
        timed(limit, "UID STORE", async {
            let fetched: Vec<_> = self
                .session
                .uid_store(set, item)
                .await?
                .try_collect()
                .await?;
            drop(fetched);
            Ok::<_, RawError>(())
        })
        .await?
        .map_err(|error| command_error("UID STORE", error))
    }

    /// Marks the UIDs `\Deleted` and expunges them (`UID EXPUNGE` touches
    /// only those; a plain `EXPUNGE` also removes any other message already
    /// flagged `\Deleted`).
    async fn delete_and_expunge(&mut self, set: &str) -> Result<(), ImapError> {
        self.store(set, "+FLAGS.SILENT (\\Deleted)").await?;
        let limit = self.timeout;
        if self.capabilities.contains("UIDPLUS") {
            timed(limit, "UID EXPUNGE", async {
                let gone: Vec<_> = self.session.uid_expunge(set).await?.try_collect().await?;
                drop(gone);
                Ok::<_, RawError>(())
            })
            .await?
            .map_err(|error| command_error("UID EXPUNGE", error))
        } else {
            timed(limit, "EXPUNGE", async {
                let gone: Vec<_> = self.session.expunge().await?.try_collect().await?;
                drop(gone);
                Ok::<_, RawError>(())
            })
            .await?
            .map_err(|error| command_error("EXPUNGE", error))
        }
    }
}

impl ImapSession for AsyncImapSession {
    fn list_mailboxes(&mut self) -> BoxFuture<'_, Result<Vec<MailboxInfo>, ImapError>> {
        Box::pin(async move {
            let mailboxes: Vec<MailboxInfo> = self
                .list_all()
                .await?
                .into_iter()
                .filter(|mailbox| !mailbox.name.is_empty())
                .collect();
            self.mailboxes = Some(mailboxes.clone());
            Ok(mailboxes)
        })
    }

    fn find_special_use(
        &mut self,
        use_: SpecialUse,
    ) -> BoxFuture<'_, Result<Option<String>, ImapError>> {
        Box::pin(async move {
            let mailboxes = match self.mailboxes.clone() {
                Some(mailboxes) => mailboxes,
                None => self.list_mailboxes().await?,
            };
            Ok(pick_special_use(&mailboxes, use_))
        })
    }

    fn select<'a>(
        &'a mut self,
        mailbox: &'a str,
    ) -> BoxFuture<'a, Result<SelectResult, ImapError>> {
        Box::pin(async move {
            let selected = timed(self.timeout, "SELECT", self.session.select(mailbox))
                .await?
                .map_err(|error| command_error("SELECT", error))?;
            Ok(SelectResult {
                exists: selected.exists,
                uid_validity: selected.uid_validity,
            })
        })
    }

    fn search_by_message_id<'a>(
        &'a mut self,
        message_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u32>, ImapError>> {
        Box::pin(async move {
            let value = bracketed_message_id(message_id)?;
            // A Message-ID is ASCII. TypeScript sends anything else as a
            // UTF-8 literal, which async-imap's SEARCH cannot; such an id
            // (never one WeldReach generates) is refused instead.
            if !value.bytes().all(|b| (0x20..0x7f).contains(&b)) {
                return Err(ImapError::new(
                    ImapErrorKind::Command,
                    "UID SEARCH: a Message-ID must be printable ASCII",
                )
                .with_command("UID SEARCH"));
            }
            let query = format!("HEADER Message-ID {}", quote(&value));
            let found = timed(self.timeout, "UID SEARCH", self.session.uid_search(query))
                .await?
                .map_err(|error| command_error("UID SEARCH", error))?;
            let mut uids: Vec<u32> = found.into_iter().collect();
            uids.sort_unstable();
            Ok(uids)
        })
    }

    fn add_flags<'a>(
        &'a mut self,
        uids: &'a [u32],
        flags: &'a [&'a str],
    ) -> BoxFuture<'a, Result<(), ImapError>> {
        Box::pin(async move {
            if uids.is_empty() || flags.is_empty() {
                return Ok(());
            }
            let item = format!("+FLAGS.SILENT {}", flag_list(flags));
            self.store(&compress_uids(uids), &item).await
        })
    }

    fn move_messages<'a>(
        &'a mut self,
        uids: &'a [u32],
        destination: &'a str,
    ) -> BoxFuture<'a, Result<(), ImapError>> {
        Box::pin(async move {
            if uids.is_empty() {
                return Ok(());
            }
            let set = compress_uids(uids);
            if self.capabilities.contains("MOVE") {
                return timed(
                    self.timeout,
                    "UID MOVE",
                    self.session.uid_mv(&set, destination),
                )
                .await?
                .map_err(|error| command_error("UID MOVE", error));
            }
            timed(
                self.timeout,
                "UID COPY",
                self.session.uid_copy(&set, destination),
            )
            .await?
            .map_err(|error| command_error("UID COPY", error))?;
            self.delete_and_expunge(&set).await
        })
    }

    fn delete_messages<'a>(&'a mut self, uids: &'a [u32]) -> BoxFuture<'a, Result<(), ImapError>> {
        Box::pin(async move {
            if uids.is_empty() {
                return Ok(());
            }
            self.delete_and_expunge(&compress_uids(uids)).await
        })
    }

    fn logout(self: Box<Self>) -> BoxFuture<'static, ()> {
        let mut session = self.session;
        Box::pin(async move {
            // LOGOUT and close; a server that does not answer is dropped.
            let _ = tokio::time::timeout(LOGOUT_TIMEOUT, session.logout()).await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uid_sets_are_compressed() {
        assert_eq!(compress_uids(&[3, 1, 2, 7, 9, 8, 12]), "1:3,7:9,12");
        assert_eq!(compress_uids(&[5]), "5");
        assert_eq!(compress_uids(&[4, 4]), "4");
    }

    #[test]
    fn strings_are_quoted() {
        assert_eq!(quote("<a\"b\\c>"), "\"<a\\\"b\\\\c>\"");
    }

    #[test]
    fn the_config_is_checked_before_connecting() {
        let mut config = ImapConfig::new("imap.example.com", 143, "u", "p");
        let error = check_config(&config, true).expect_err("143");
        assert_eq!(error.kind, ImapErrorKind::Connect);
        config.port = 993;
        assert!(check_config(&config, true).is_ok());
        config.password = "a\0b".to_owned();
        assert!(check_config(&config, true).expect_err("nul").auth_failed());
        config.password = "p".to_owned();
        config.host = " ".to_owned();
        assert_eq!(
            check_config(&config, true).expect_err("host").kind,
            ImapErrorKind::Connect
        );
    }

    #[test]
    fn a_rejected_login_is_auth_and_a_bad_one_a_command_error() {
        let no = login_error(RawError::No("[AUTHENTICATIONFAILED] nope".to_owned()));
        assert!(no.auth_failed());
        assert_eq!(no.response.as_deref(), Some("[AUTHENTICATIONFAILED] nope"));
        let bad = login_error(RawError::Bad("syntax".to_owned()));
        assert_eq!(bad.kind, ImapErrorKind::Command);
        assert_eq!(
            command_error("SELECT", RawError::ConnectionLost).kind,
            ImapErrorKind::Connect
        );
    }
}
