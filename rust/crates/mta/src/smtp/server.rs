//! The SMTP server side: one [`Session`] per connection, driven by a
//! [`Policy`] that decides what to accept. Submission and the bounce MX are
//! two policies over the same session.
//!
//! - ESMTP with `PIPELINING`, `8BITMIME`, `SMTPUTF8`, `SIZE`,
//!   `ENHANCEDSTATUSCODES`, `AUTH PLAIN LOGIN` (when the policy wants it)
//!   and `STARTTLS` (when it has a certificate).
//! - Commands buffered before `STARTTLS` are an injection attempt
//!   (CVE-2011-0411): the session ends.
//! - `DATA` is dot-unstuffed and bare LFs become CRLF; a message over the
//!   limit is read to its end and refused with `552`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::TlsAcceptor;

use super::{Reply, Stream, read_line};
use crate::BoxFuture;
use crate::message::valid_address;

/// What a session knows when the policy is asked.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub peer: SocketAddr,
    pub helo: Option<String>,
    pub tls: bool,
    /// The authenticated user's pool (submission).
    pub pool: Option<String>,
}

/// A transaction the policy is asked to accept at the end of `DATA`.
#[derive(Debug, Clone)]
pub struct Transaction {
    /// The reverse path; empty for the null sender `<>`.
    pub mail_from: String,
    pub recipients: Vec<String>,
    /// The message, CRLF line endings, dot-unstuffed.
    pub message: Vec<u8>,
}

/// Decides what a session accepts.
pub trait Policy: Send + Sync + 'static {
    /// The name in the greeting and the EHLO reply.
    fn hostname(&self) -> &str;
    fn max_message_bytes(&self) -> usize;
    /// The certificate for STARTTLS, if the listener offers it.
    fn tls(&self) -> Option<TlsAcceptor>;
    /// Whether `MAIL` needs `AUTH` first (submission).
    fn auth_required(&self) -> bool;
    /// The pool for a user and password, or `None`.
    fn authenticate(&self, user: &str, password: &str) -> Option<String>;
    fn mail<'a>(&'a self, session: &'a SessionInfo, from: &'a str) -> BoxFuture<'a, Reply>;
    fn rcpt<'a>(
        &'a self,
        session: &'a SessionInfo,
        from: &'a str,
        to: &'a str,
    ) -> BoxFuture<'a, Reply>;
    fn data<'a>(
        &'a self,
        session: &'a SessionInfo,
        transaction: Transaction,
    ) -> BoxFuture<'a, Reply>;
}

const MAX_RECIPIENTS: usize = 100;
const MAX_ERRORS: u32 = 10;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(300);
const DATA_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, PartialEq, Eq)]
enum Flow {
    Continue,
    Close,
    StartTls,
}

/// One connection.
pub struct Session<P: Policy> {
    policy: Arc<P>,
    info: SessionInfo,
    reader: BufReader<Stream>,
    mail_from: Option<String>,
    recipients: Vec<String>,
    errors: u32,
}

impl<P: Policy> Session<P> {
    /// Serves `socket` until it closes, QUIT, or too many errors.
    pub async fn serve(policy: Arc<P>, socket: TcpStream, peer: SocketAddr) {
        let _ = socket.set_nodelay(true);
        let mut session = Self {
            policy,
            info: SessionInfo {
                peer,
                helo: None,
                tls: false,
                pool: None,
            },
            reader: BufReader::new(Stream(Box::new(socket))),
            mail_from: None,
            recipients: Vec::new(),
            errors: 0,
        };
        if let Err(error) = session.run().await {
            tracing::debug!(%peer, %error, "SMTP session ended");
        }
    }

    async fn write(&mut self, reply: &Reply) -> std::io::Result<()> {
        let stream = self.reader.get_mut();
        stream.write_all(&reply.to_wire()).await?;
        stream.flush().await
    }

    async fn run(&mut self) -> std::io::Result<()> {
        let greeting = Reply::new(220, format!("{} ESMTP WeldSuite", self.policy.hostname()));
        self.write(&greeting).await?;
        loop {
            let line = tokio::time::timeout(COMMAND_TIMEOUT, read_line(&mut self.reader, 4096))
                .await
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "idle"))?;
            let line = match line {
                Ok(Some(line)) => line,
                Ok(None) => return Ok(()),
                Err(error) => {
                    let _ = self.write(&Reply::new(500, "5.5.2 line too long")).await;
                    return Err(error);
                }
            };
            let command = String::from_utf8_lossy(&line)
                .trim_end_matches(['\r', '\n'])
                .to_owned();
            let (reply, flow) = self.command(&command).await?;
            if let Some(reply) = reply {
                if reply.code >= 500 {
                    self.errors += 1;
                }
                self.write(&reply).await?;
            }
            match flow {
                Flow::Continue if self.errors >= MAX_ERRORS => {
                    self.write(&Reply::new(421, "4.7.0 too many errors"))
                        .await?;
                    return Ok(());
                }
                Flow::Continue => {}
                Flow::Close => return Ok(()),
                Flow::StartTls => self.start_tls().await?,
            }
        }
    }

    async fn start_tls(&mut self) -> std::io::Result<()> {
        if !self.reader.buffer().is_empty() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data pipelined after STARTTLS",
            ));
        }
        let Some(acceptor) = self.policy.tls() else {
            return Ok(());
        };
        let placeholder = BufReader::new(Stream(Box::new(tokio::io::join(
            tokio::io::empty(),
            tokio::io::sink(),
        ))));
        let plain = std::mem::replace(&mut self.reader, placeholder).into_inner();
        let tls = acceptor.accept(plain).await?;
        self.reader = BufReader::new(Stream(Box::new(tls)));
        self.info.tls = true;
        self.info.helo = None;
        self.reset();
        Ok(())
    }

    fn reset(&mut self) {
        self.mail_from = None;
        self.recipients.clear();
    }

    fn ehlo_reply(&self, name: &str) -> Reply {
        let mut lines = vec![
            format!("{} greets {name}", self.policy.hostname()),
            "PIPELINING".into(),
            format!("SIZE {}", self.policy.max_message_bytes()),
            "8BITMIME".into(),
            "SMTPUTF8".into(),
            "ENHANCEDSTATUSCODES".into(),
        ];
        if self.policy.tls().is_some() && !self.info.tls {
            lines.push("STARTTLS".into());
        }
        if self.policy.auth_required() {
            lines.push("AUTH PLAIN LOGIN".into());
        }
        Reply { code: 250, lines }
    }

    async fn command(&mut self, line: &str) -> std::io::Result<(Option<Reply>, Flow)> {
        let (verb, rest) = line.split_once(' ').unwrap_or((line, ""));
        let rest = rest.trim();
        let reply = match verb.to_ascii_uppercase().as_str() {
            "EHLO" | "HELO" if rest.is_empty() => Reply::new(501, "5.5.4 a name, please"),
            "EHLO" => {
                self.info.helo = Some(rest.to_owned());
                self.reset();
                self.ehlo_reply(rest)
            }
            "HELO" => {
                self.info.helo = Some(rest.to_owned());
                self.reset();
                Reply::new(250, self.policy.hostname().to_owned())
            }
            "STARTTLS" if self.info.tls || self.policy.tls().is_none() => {
                Reply::new(502, "5.5.1 TLS not available")
            }
            "STARTTLS" => {
                return Ok((
                    Some(Reply::new(220, "2.0.0 ready to start TLS")),
                    Flow::StartTls,
                ));
            }
            "AUTH" => self.auth(rest).await?,
            "MAIL" => self.mail(rest).await,
            "RCPT" => self.rcpt(rest).await,
            "DATA" => return self.data().await.map(|reply| (Some(reply), Flow::Continue)),
            "RSET" => {
                self.reset();
                Reply::new(250, "2.0.0 ok")
            }
            "NOOP" => Reply::new(250, "2.0.0 ok"),
            "VRFY" => Reply::new(252, "2.5.2 cannot verify, send some mail"),
            "QUIT" => return Ok((Some(Reply::new(221, "2.0.0 bye")), Flow::Close)),
            "BDAT" | "EXPN" | "TURN" | "ETRN" => Reply::new(502, "5.5.1 not implemented"),
            _ => Reply::new(500, "5.5.2 unknown command"),
        };
        Ok((Some(reply), Flow::Continue))
    }

    async fn auth(&mut self, rest: &str) -> std::io::Result<Reply> {
        if !self.policy.auth_required() {
            return Ok(Reply::new(502, "5.5.1 AUTH not available"));
        }
        if self.info.pool.is_some() {
            return Ok(Reply::new(503, "5.5.1 already authenticated"));
        }
        if self.info.helo.is_none() {
            return Ok(Reply::new(503, "5.5.1 EHLO first"));
        }
        let (mechanism, initial) = rest.split_once(' ').unwrap_or((rest, ""));
        let credentials = match mechanism.to_ascii_uppercase().as_str() {
            "PLAIN" => {
                let encoded = if initial.is_empty() {
                    self.write(&Reply::new(334, "")).await?;
                    self.read_auth_line().await?
                } else {
                    initial.to_owned()
                };
                decode_plain(&encoded)
            }
            "LOGIN" => {
                self.write(&Reply::new(334, "VXNlcm5hbWU6")).await?;
                let user = self.read_auth_line().await?;
                self.write(&Reply::new(334, "UGFzc3dvcmQ6")).await?;
                let password = self.read_auth_line().await?;
                decode_text(&user).zip(decode_text(&password))
            }
            _ => return Ok(Reply::new(504, "5.5.4 mechanism not supported")),
        };
        let pool =
            credentials.and_then(|(user, password)| self.policy.authenticate(&user, &password));
        let Some(pool) = pool else {
            // Slow down guessing.
            tokio::time::sleep(Duration::from_secs(1)).await;
            return Ok(Reply::new(535, "5.7.8 authentication failed"));
        };
        self.info.pool = Some(pool);
        Ok(Reply::new(235, "2.7.0 authenticated"))
    }

    async fn read_auth_line(&mut self) -> std::io::Result<String> {
        let line = tokio::time::timeout(COMMAND_TIMEOUT, read_line(&mut self.reader, 4096))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "idle"))??
            .unwrap_or_default();
        Ok(String::from_utf8_lossy(&line).trim().to_owned())
    }

    async fn mail(&mut self, rest: &str) -> Reply {
        if self.info.helo.is_none() {
            return Reply::new(503, "5.5.1 EHLO first");
        }
        if self.policy.auth_required() && self.info.pool.is_none() {
            return Reply::new(530, "5.7.0 authentication required");
        }
        if self.mail_from.is_some() {
            return Reply::new(503, "5.5.1 nested MAIL");
        }
        let Some((address, params)) = path_argument(rest, "FROM:") else {
            return Reply::new(501, "5.5.4 syntax: MAIL FROM:<address>");
        };
        if !address.is_empty() && !valid_address(&address) {
            return Reply::new(553, "5.1.7 bad sender address");
        }
        for param in params.split_whitespace() {
            let (key, value) = param.split_once('=').unwrap_or((param, ""));
            if key.eq_ignore_ascii_case("SIZE")
                && value
                    .parse::<usize>()
                    .is_ok_and(|size| size > self.policy.max_message_bytes())
            {
                return Reply::new(552, "5.3.4 message too big");
            }
        }
        let reply = self.policy.mail(&self.info, &address).await;
        if reply.is_positive() {
            self.mail_from = Some(address);
        }
        reply
    }

    async fn rcpt(&mut self, rest: &str) -> Reply {
        let Some(from) = self.mail_from.clone() else {
            return Reply::new(503, "5.5.1 MAIL first");
        };
        let Some((address, _)) = path_argument(rest, "TO:") else {
            return Reply::new(501, "5.5.4 syntax: RCPT TO:<address>");
        };
        if !valid_address(&address) {
            return Reply::new(553, "5.1.3 bad recipient address");
        }
        if self.recipients.len() >= MAX_RECIPIENTS {
            return Reply::new(452, "4.5.3 too many recipients");
        }
        let reply = self.policy.rcpt(&self.info, &from, &address).await;
        if reply.is_positive() {
            self.recipients.push(address);
        }
        reply
    }

    async fn data(&mut self) -> std::io::Result<Reply> {
        let Some(mail_from) = self.mail_from.clone() else {
            return Ok(Reply::new(503, "5.5.1 MAIL first"));
        };
        if self.recipients.is_empty() {
            return Ok(Reply::new(554, "5.5.1 no valid recipients"));
        }
        self.write(&Reply::new(354, "end data with <CR><LF>.<CR><LF>"))
            .await?;
        let max = self.policy.max_message_bytes();
        let body = tokio::time::timeout(DATA_TIMEOUT, read_data(&mut self.reader, max))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "data timeout"))??;
        let recipients = std::mem::take(&mut self.recipients);
        self.mail_from = None;
        let Some(message) = body else {
            return Ok(Reply::new(552, "5.3.4 message too big"));
        };
        let transaction = Transaction {
            mail_from,
            recipients,
            message,
        };
        Ok(self.policy.data(&self.info, transaction).await)
    }
}

/// Reads `DATA` to the terminating dot. `None` when it outgrew `max` (still
/// read to the end, so the session can go on).
async fn read_data(reader: &mut BufReader<Stream>, max: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut out = Vec::with_capacity(8192);
    let mut too_big = false;
    loop {
        let Some(line) = read_line(reader, 1 << 20).await? else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "connection closed in DATA",
            ));
        };
        if line == b".\r\n" || line == b".\n" {
            break;
        }
        if too_big {
            continue;
        }
        let content = line.strip_prefix(b".").unwrap_or(&line);
        let content = content.strip_suffix(b"\n").unwrap_or(content);
        let content = content.strip_suffix(b"\r").unwrap_or(content);
        out.extend_from_slice(content);
        out.extend_from_slice(b"\r\n");
        if out.len() > max {
            too_big = true;
            out = Vec::new();
        }
    }
    Ok((!too_big).then_some(out))
}

/// `FROM:<a@b> SIZE=1` → (`a@b`, `SIZE=1`). The angle brackets may be
/// missing (lenient), the colon may be followed by a space.
fn path_argument(rest: &str, keyword: &str) -> Option<(String, String)> {
    let upper = rest.to_ascii_uppercase();
    if !upper.starts_with(keyword) {
        return None;
    }
    let rest = rest[keyword.len()..].trim_start();
    if let Some(inner) = rest.strip_prefix('<') {
        let close = inner.find('>')?;
        let address = inner[..close].trim();
        // A source route (`<@a,@b:x@y>`) keeps only the mailbox.
        let address = address
            .rsplit_once(':')
            .map_or(address, |(_, mailbox)| mailbox);
        return Some((address.to_owned(), inner[close + 1..].trim().to_owned()));
    }
    let (address, params) = rest.split_once(' ').unwrap_or((rest, ""));
    Some((address.to_owned(), params.trim().to_owned()))
}

fn decode_text(encoded: &str) -> Option<String> {
    let bytes = B64.decode(encoded.trim()).ok()?;
    String::from_utf8(bytes).ok()
}

/// `\0user\0password` (the authorization identity is ignored).
fn decode_plain(encoded: &str) -> Option<(String, String)> {
    let text = decode_text(encoded)?;
    let mut parts = text.split('\0');
    let _authzid = parts.next()?;
    let user = parts.next()?.to_owned();
    let password = parts.next()?.to_owned();
    Some((user, password))
}

/// Accepts connections on `listener` until `shutdown`, at most
/// `max_sessions` at once (the rest get `421`).
pub async fn listen<P: Policy>(
    listener: tokio::net::TcpListener,
    policy: Arc<P>,
    max_sessions: usize,
    shutdown: tokio_util::sync::CancellationToken,
) {
    let limit = Arc::new(tokio::sync::Semaphore::new(max_sessions));
    loop {
        let accepted = tokio::select! {
            () = shutdown.cancelled() => return,
            accepted = listener.accept() => accepted,
        };
        let (mut socket, peer) = match accepted {
            Ok(pair) => pair,
            Err(error) => {
                tracing::warn!(%error, "accept failed");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let Ok(permit) = Arc::clone(&limit).try_acquire_owned() else {
            tokio::spawn(async move {
                let _ = socket
                    .write_all(&Reply::new(421, "4.7.0 too busy, try later").to_wire())
                    .await;
            });
            continue;
        };
        let policy = Arc::clone(&policy);
        tokio::spawn(async move {
            Session::serve(policy, socket, peer).await;
            drop(permit);
        });
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Mutex;

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{TcpListener, TcpStream};

    use super::*;

    pub(crate) struct Recorder {
        pub(crate) accepted: Mutex<Vec<Transaction>>,
        pub(crate) auth: bool,
    }

    impl Policy for Recorder {
        fn hostname(&self) -> &'static str {
            "mta.test"
        }
        fn max_message_bytes(&self) -> usize {
            200
        }
        fn tls(&self) -> Option<TlsAcceptor> {
            None
        }
        fn auth_required(&self) -> bool {
            self.auth
        }
        fn authenticate(&self, user: &str, password: &str) -> Option<String> {
            (user == "customer" && password == "pw").then(|| "customer".to_owned())
        }
        fn mail<'a>(&'a self, _: &'a SessionInfo, _: &'a str) -> BoxFuture<'a, Reply> {
            Box::pin(async { Reply::new(250, "2.1.0 ok") })
        }
        fn rcpt<'a>(&'a self, _: &'a SessionInfo, _: &'a str, to: &'a str) -> BoxFuture<'a, Reply> {
            Box::pin(async move {
                if to.starts_with("gone@") {
                    Reply::new(550, "5.1.1 recipient suppressed")
                } else {
                    Reply::new(250, "2.1.5 ok")
                }
            })
        }
        fn data<'a>(&'a self, _: &'a SessionInfo, t: Transaction) -> BoxFuture<'a, Reply> {
            Box::pin(async move {
                self.accepted.lock().expect("lock").push(t);
                Reply::new(250, "2.0.0 queued")
            })
        }
    }

    async fn start(auth: bool) -> (Arc<Recorder>, SocketAddr) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let policy = Arc::new(Recorder {
            accepted: Mutex::new(Vec::new()),
            auth,
        });
        tokio::spawn(listen(
            listener,
            Arc::clone(&policy),
            4,
            tokio_util::sync::CancellationToken::new(),
        ));
        (policy, addr)
    }

    async fn talk(addr: SocketAddr, script: &[&str]) -> Vec<String> {
        let stream = TcpStream::connect(addr).await.expect("connect");
        let (read, mut write) = stream.into_split();
        let mut read = BufReader::new(read);
        let mut replies = Vec::new();
        let mut line = String::new();
        read.read_line(&mut line).await.expect("greeting");
        replies.push(line.trim_end().to_owned());
        for command in script {
            write.write_all(command.as_bytes()).await.expect("write");
            loop {
                line.clear();
                if read.read_line(&mut line).await.expect("read") == 0 {
                    return replies;
                }
                if line.as_bytes().get(3) != Some(&b'-') {
                    replies.push(line.trim_end().to_owned());
                    break;
                }
            }
        }
        replies
    }

    #[tokio::test]
    async fn runs_an_authenticated_transaction() {
        let (policy, addr) = start(true).await;
        let plain = B64.encode("\0customer\0pw");
        let replies = talk(
            addr,
            &[
                "EHLO client.test\r\n",
                "MAIL FROM:<a@acme.eu>\r\n",
                &format!("AUTH PLAIN {plain}\r\n"),
                "MAIL FROM:<a@acme.eu> SIZE=100\r\n",
                "RCPT TO:<gone@example.com>\r\n",
                "RCPT TO:<b@example.com>\r\n",
                "DATA\r\n",
                "Subject: x\r\n\r\n..dot\nbare lf\r\n.\r\n",
                "QUIT\r\n",
            ],
        )
        .await;
        let codes: Vec<&str> = replies.iter().map(|r| &r[..3]).collect();
        assert_eq!(
            codes,
            [
                "220", "250", "530", "235", "250", "550", "250", "354", "250", "221"
            ]
        );
        let accepted = policy.accepted.lock().expect("lock");
        assert_eq!(accepted[0].recipients, vec!["b@example.com"]);
        assert_eq!(
            accepted[0].message,
            b"Subject: x\r\n\r\n.dot\r\nbare lf\r\n"
        );
    }

    #[tokio::test]
    async fn refuses_wrong_passwords_and_big_messages() {
        let (policy, addr) = start(true).await;
        let bad = B64.encode("\0customer\0nope");
        let good = B64.encode("\0customer\0pw");
        let big = format!("{}\r\n.\r\n", "x".repeat(300));
        let replies = talk(
            addr,
            &[
                "EHLO c\r\n",
                &format!("AUTH PLAIN {bad}\r\n"),
                &format!("AUTH PLAIN {good}\r\n"),
                "MAIL FROM:<a@acme.eu> SIZE=99999\r\n",
                "MAIL FROM:<a@acme.eu>\r\n",
                "RCPT TO:<b@example.com>\r\n",
                "DATA\r\n",
                &big,
                "NOOP\r\n",
            ],
        )
        .await;
        let codes: Vec<&str> = replies.iter().map(|r| &r[..3]).collect();
        assert_eq!(
            codes,
            [
                "220", "250", "535", "235", "552", "250", "250", "354", "552", "250"
            ]
        );
        assert!(policy.accepted.lock().expect("lock").is_empty());
    }

    #[tokio::test]
    async fn accepts_the_null_sender_without_auth() {
        let (policy, addr) = start(false).await;
        let replies = talk(
            addr,
            &[
                "HELO mx.example.com\r\n",
                "MAIL FROM:<>\r\n",
                "RCPT TO:<b+abc-def@bounces.test>\r\n",
                "DATA\r\n",
                "x\r\n.\r\n",
            ],
        )
        .await;
        assert_eq!(replies.last().map(|r| &r[..3]), Some("250"));
        assert_eq!(policy.accepted.lock().expect("lock")[0].mail_from, "");
    }

    #[test]
    fn parses_paths() {
        assert_eq!(
            path_argument("FROM:<a@b.eu> SIZE=10", "FROM:"),
            Some(("a@b.eu".into(), "SIZE=10".into()))
        );
        assert_eq!(
            path_argument("from: <>", "FROM:"),
            Some((String::new(), String::new()))
        );
        assert_eq!(
            path_argument("TO:<@relay.eu:x@y.eu>", "TO:"),
            Some(("x@y.eu".into(), String::new()))
        );
        assert_eq!(
            path_argument("TO:x@y.eu", "TO:"),
            Some(("x@y.eu".into(), String::new()))
        );
        assert_eq!(path_argument("XX:<a@b.eu>", "FROM:"), None);
    }
}
