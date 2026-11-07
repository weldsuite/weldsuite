//! The SMTP client delivery uses: one connection to one MX host, from the
//! node's source address, then one transaction per recipient (each has its
//! own VERP return path) on the same connection.
//!
//! TLS: STARTTLS whenever the server offers it. With [`TlsMode::Opportunistic`]
//! any certificate is accepted (RFC 7435: encryption without
//! authentication beats plaintext); with [`TlsMode::Required`] (an MTA-STS
//! `enforce` policy) the certificate must be valid for the MX name, and a
//! server without STARTTLS is a failure.

use std::fmt::Write as _;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::ServerName;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::TcpSocket;
use tokio_rustls::TlsConnector;

use super::{Reply, Stream, read_reply};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsMode {
    /// No STARTTLS (the retry after a failed opportunistic handshake).
    Off,
    Opportunistic,
    /// STARTTLS with a certificate valid for the MX host.
    Required,
}

/// How a connection ended up protected, for TLS-RPT.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsOutcome {
    Plain,
    Encrypted,
    Verified,
}

/// The two TLS client configurations.
#[derive(Clone)]
pub struct TlsConfigs {
    pub verified: Arc<rustls::ClientConfig>,
    pub opportunistic: Arc<rustls::ClientConfig>,
}

impl std::fmt::Debug for TlsConfigs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TlsConfigs")
    }
}

/// Settings shared by every connection.
#[derive(Debug, Clone)]
pub struct ClientSettings {
    /// The EHLO name; must be the source IP's PTR name.
    pub helo: String,
    pub source_ip: Option<Ipv4Addr>,
    pub port: u16,
    pub tls: TlsConfigs,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const DATA_TIMEOUT: Duration = Duration::from_secs(600);

/// Why a connection could not be set up. Every variant moves on to the next
/// MX (RFC 5321 §5.1) except a permanent greeting/EHLO refusal, which the
/// caller may treat as permanent once every MX said so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectError {
    /// Network failure or timeout.
    Network(String),
    /// The server refused at the greeting or EHLO.
    Refused(Reply),
    /// The TLS handshake failed; `required` tells whether TLS was mandatory.
    Tls { message: String, required: bool },
    /// STARTTLS required but not offered.
    NoStartTls,
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(message) => write!(f, "network: {message}"),
            Self::Refused(reply) => write!(f, "refused: {reply}"),
            Self::Tls { message, .. } => write!(f, "TLS: {message}"),
            Self::NoStartTls => f.write_str("STARTTLS required but not offered"),
        }
    }
}

/// One transaction's outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendOutcome {
    /// `250` after the data.
    Accepted(Reply),
    /// A 4xx or 5xx at MAIL, RCPT or after the data.
    Refused(Reply),
    /// The connection broke: the result is unknown, retry later.
    Broken(String),
}

/// What a message needs from the server.
#[derive(Debug, Clone, Copy, Default)]
pub struct Needs {
    pub eight_bit: bool,
    pub smtputf8: bool,
    pub size: usize,
}

/// An open connection.
pub struct Connection {
    reader: BufReader<Stream>,
    extensions: Vec<String>,
    pub tls: TlsOutcome,
    pub host: String,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection")
            .field("host", &self.host)
            .field("tls", &self.tls)
            .finish_non_exhaustive()
    }
}

fn network(error: impl std::fmt::Display) -> ConnectError {
    ConnectError::Network(error.to_string())
}

impl Connection {
    /// Connects to `ip`, reads the greeting, EHLOs and starts TLS per `mode`.
    pub async fn open(
        settings: &ClientSettings,
        host: &str,
        ip: Ipv4Addr,
        mode: TlsMode,
    ) -> Result<Self, ConnectError> {
        let socket = TcpSocket::new_v4().map_err(network)?;
        if let Some(source) = settings.source_ip {
            socket
                .bind(SocketAddr::V4(SocketAddrV4::new(source, 0)))
                .map_err(network)?;
        }
        let target = SocketAddr::V4(SocketAddrV4::new(ip, settings.port));
        let stream = tokio::time::timeout(CONNECT_TIMEOUT, socket.connect(target))
            .await
            .map_err(|_| ConnectError::Network("connect timed out".into()))?
            .map_err(network)?;
        let _ = stream.set_nodelay(true);
        let mut connection = Self {
            reader: BufReader::new(Stream(Box::new(stream))),
            extensions: Vec::new(),
            tls: TlsOutcome::Plain,
            host: host.to_owned(),
        };
        let greeting = connection.reply().await.map_err(network)?;
        if !greeting.is_positive() {
            return Err(ConnectError::Refused(greeting));
        }
        connection.ehlo(&settings.helo).await?;
        let offered = connection.has("STARTTLS");
        match mode {
            TlsMode::Off => {}
            TlsMode::Opportunistic if !offered => {}
            TlsMode::Required if !offered => return Err(ConnectError::NoStartTls),
            TlsMode::Opportunistic | TlsMode::Required => {
                let required = mode == TlsMode::Required;
                let config = if required {
                    Arc::clone(&settings.tls.verified)
                } else {
                    Arc::clone(&settings.tls.opportunistic)
                };
                connection.start_tls(config, required).await?;
                connection.ehlo(&settings.helo).await?;
            }
        }
        Ok(connection)
    }

    async fn reply(&mut self) -> std::io::Result<Reply> {
        tokio::time::timeout(COMMAND_TIMEOUT, read_reply(&mut self.reader))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "reply timed out"))?
    }

    async fn command(&mut self, line: &str) -> std::io::Result<Reply> {
        let stream = self.reader.get_mut();
        stream.write_all(line.as_bytes()).await?;
        stream.write_all(b"\r\n").await?;
        stream.flush().await?;
        self.reply().await
    }

    async fn ehlo(&mut self, helo: &str) -> Result<(), ConnectError> {
        let reply = self
            .command(&format!("EHLO {helo}"))
            .await
            .map_err(network)?;
        if reply.is_positive() {
            self.extensions = reply
                .lines
                .iter()
                .skip(1)
                .map(|line| line.to_ascii_uppercase())
                .collect();
            return Ok(());
        }
        // Old servers: HELO, no extensions.
        let reply = self
            .command(&format!("HELO {helo}"))
            .await
            .map_err(network)?;
        if reply.is_positive() {
            self.extensions.clear();
            Ok(())
        } else {
            Err(ConnectError::Refused(reply))
        }
    }

    fn has(&self, extension: &str) -> bool {
        self.extensions
            .iter()
            .any(|line| line.split_whitespace().next() == Some(extension))
    }

    /// The server's `SIZE` limit, when it announced one.
    fn size_limit(&self) -> Option<usize> {
        self.extensions.iter().find_map(|line| {
            let mut parts = line.split_whitespace();
            (parts.next() == Some("SIZE"))
                .then(|| parts.next()?.parse().ok())
                .flatten()
                .filter(|&size: &usize| size > 0)
        })
    }

    async fn start_tls(
        &mut self,
        config: Arc<rustls::ClientConfig>,
        required: bool,
    ) -> Result<(), ConnectError> {
        let tls_error = |message: String| ConnectError::Tls { message, required };
        let reply = self.command("STARTTLS").await.map_err(network)?;
        if reply.code != 220 {
            return Err(tls_error(format!("STARTTLS refused: {reply}")));
        }
        let name = ServerName::try_from(self.host.clone())
            .map_err(|_| tls_error(format!("bad server name {}", self.host)))?;
        let placeholder = BufReader::new(Stream(Box::new(tokio::io::join(
            tokio::io::empty(),
            tokio::io::sink(),
        ))));
        let plain = std::mem::replace(&mut self.reader, placeholder).into_inner();
        let tls = tokio::time::timeout(
            COMMAND_TIMEOUT,
            TlsConnector::from(config).connect(name, plain),
        )
        .await
        .map_err(|_| tls_error("handshake timed out".into()))?
        .map_err(|error| tls_error(error.to_string()))?;
        self.reader = BufReader::new(Stream(Box::new(tls)));
        self.tls = if required {
            TlsOutcome::Verified
        } else {
            TlsOutcome::Encrypted
        };
        Ok(())
    }

    /// One transaction: `MAIL FROM`, one `RCPT TO`, `DATA`. `wire` is the
    /// dot-stuffed message with its terminating `.\r\n`.
    pub async fn send(
        &mut self,
        mail_from: &str,
        to: &str,
        wire: &[u8],
        needs: Needs,
    ) -> SendOutcome {
        if needs.smtputf8 && !self.has("SMTPUTF8") {
            return SendOutcome::Refused(Reply::new(
                553,
                "5.6.7 the server does not take internationalized addresses",
            ));
        }
        if let Some(limit) = self.size_limit()
            && needs.size > limit
        {
            return SendOutcome::Refused(Reply::new(
                552,
                format!("5.3.4 message larger than the server's {limit} bytes"),
            ));
        }
        let mut mail = format!("MAIL FROM:<{mail_from}>");
        if self.has("SIZE") {
            // Writing to a String cannot fail.
            let _ = write!(mail, " SIZE={}", needs.size);
        }
        if needs.eight_bit && self.has("8BITMIME") {
            mail.push_str(" BODY=8BITMIME");
        }
        if needs.smtputf8 {
            mail.push_str(" SMTPUTF8");
        }
        match self.command(&mail).await {
            Ok(reply) if reply.is_positive() => {}
            Ok(reply) => {
                let _ = self.command("RSET").await;
                return SendOutcome::Refused(reply);
            }
            Err(error) => return SendOutcome::Broken(error.to_string()),
        }
        match self.command(&format!("RCPT TO:<{to}>")).await {
            Ok(reply) if reply.is_positive() => {}
            Ok(reply) => {
                let _ = self.command("RSET").await;
                return SendOutcome::Refused(reply);
            }
            Err(error) => return SendOutcome::Broken(error.to_string()),
        }
        match self.command("DATA").await {
            Ok(reply) if reply.code == 354 => {}
            Ok(reply) => {
                let _ = self.command("RSET").await;
                return SendOutcome::Refused(reply);
            }
            Err(error) => return SendOutcome::Broken(error.to_string()),
        }
        let written = tokio::time::timeout(DATA_TIMEOUT, async {
            let stream = self.reader.get_mut();
            stream.write_all(wire).await?;
            stream.flush().await?;
            read_reply(&mut self.reader).await
        })
        .await;
        match written {
            Ok(Ok(reply)) if reply.is_positive() => SendOutcome::Accepted(reply),
            Ok(Ok(reply)) => SendOutcome::Refused(reply),
            Ok(Err(error)) => SendOutcome::Broken(error.to_string()),
            Err(_) => SendOutcome::Broken("timed out after the data".into()),
        }
    }

    pub async fn quit(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(5), self.command("QUIT")).await;
    }
}

/// Accepts any certificate but still checks the handshake signature: the
/// opportunistic TLS of RFC 7435.
#[derive(Debug)]
struct AnyCertificate(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
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
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

impl TlsConfigs {
    /// Verified: the platform's roots. Opportunistic: any certificate.
    pub fn new() -> Result<Self, rustls::Error> {
        use rustls_platform_verifier::BuilderVerifierExt;
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let verified = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
            .with_safe_default_protocol_versions()?
            .with_platform_verifier()?
            .with_no_client_auth();
        let opportunistic = Self::any_certificate(provider)?;
        Ok(Self {
            verified: Arc::new(verified),
            opportunistic,
        })
    }

    fn any_certificate(
        provider: Arc<rustls::crypto::CryptoProvider>,
    ) -> Result<Arc<rustls::ClientConfig>, rustls::Error> {
        let config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
            .with_safe_default_protocol_versions()?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AnyCertificate(provider)))
            .with_no_client_auth();
        Ok(Arc::new(config))
    }

    /// Both configurations accept any certificate (tests).
    pub fn insecure() -> Result<Self, rustls::Error> {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let any = Self::any_certificate(provider)?;
        Ok(Self {
            verified: Arc::clone(&any),
            opportunistic: any,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    use super::*;

    /// A scripted server: answers each command by its first word.
    async fn server(rcpt_reply: &'static str, log: Arc<Mutex<Vec<String>>>) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("accept");
            let (read, mut write) = socket.into_split();
            let mut read = BufReader::new(read);
            write.write_all(b"220 mx.test ESMTP\r\n").await.expect("w");
            let mut in_data = false;
            let mut line = String::new();
            loop {
                line.clear();
                if read.read_line(&mut line).await.expect("r") == 0 {
                    return;
                }
                if in_data {
                    if line == ".\r\n" {
                        in_data = false;
                        write
                            .write_all(b"250 2.0.0 ok queued\r\n")
                            .await
                            .expect("w");
                    } else {
                        log.lock()
                            .expect("lock")
                            .push(format!("DATA {}", line.trim_end()));
                    }
                    continue;
                }
                log.lock().expect("lock").push(line.trim_end().to_owned());
                let reply: &[u8] = match line.split_whitespace().next().unwrap_or("") {
                    "EHLO" => b"250-mx.test\r\n250-SIZE 1000\r\n250-8BITMIME\r\n250 PIPELINING\r\n",
                    "MAIL" | "RSET" => b"250 2.1.0 ok\r\n",
                    "RCPT" => rcpt_reply.as_bytes(),
                    "DATA" => {
                        in_data = true;
                        b"354 go\r\n"
                    }
                    "QUIT" => b"221 bye\r\n",
                    _ => b"502 no\r\n",
                };
                write.write_all(reply).await.expect("w");
            }
        });
        port
    }

    fn settings(port: u16) -> ClientSettings {
        ClientSettings {
            helo: "mail1-customer.eu.test".into(),
            source_ip: None,
            port,
            tls: TlsConfigs::insecure().expect("tls"),
        }
    }

    #[tokio::test]
    async fn delivers_one_message() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let port = server("250 2.1.5 ok\r\n", Arc::clone(&log)).await;
        let mut connection = Connection::open(
            &settings(port),
            "mx.test",
            Ipv4Addr::LOCALHOST,
            TlsMode::Opportunistic,
        )
        .await
        .expect("open");
        assert_eq!(connection.tls, TlsOutcome::Plain);
        let wire = crate::message::dot_stuff(b"Subject: x\r\n\r\n.hi\r\n");
        let outcome = connection
            .send(
                "b+r1-t@bounces.test",
                "bob@example.com",
                &wire,
                Needs {
                    eight_bit: true,
                    smtputf8: false,
                    size: 20,
                },
            )
            .await;
        assert!(matches!(outcome, SendOutcome::Accepted(_)));
        connection.quit().await;
        let log = log.lock().expect("lock").clone();
        assert_eq!(log[0], "EHLO mail1-customer.eu.test");
        assert_eq!(
            log[1],
            "MAIL FROM:<b+r1-t@bounces.test> SIZE=20 BODY=8BITMIME"
        );
        assert_eq!(log[2], "RCPT TO:<bob@example.com>");
        assert!(log.contains(&"DATA ..hi".to_owned()));
    }

    #[tokio::test]
    async fn reports_refusals_and_size_limits() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let port = server("550 5.1.1 no such user\r\n", Arc::clone(&log)).await;
        let mut connection = Connection::open(
            &settings(port),
            "mx.test",
            Ipv4Addr::LOCALHOST,
            TlsMode::Opportunistic,
        )
        .await
        .expect("open");
        let wire = crate::message::dot_stuff(b"x\r\n");
        let too_big = connection
            .send(
                "a@b.test",
                "c@d.test",
                &wire,
                Needs {
                    size: 5000,
                    ..Needs::default()
                },
            )
            .await;
        assert!(matches!(too_big, SendOutcome::Refused(ref r) if r.code == 552));
        let refused = connection
            .send(
                "a@b.test",
                "c@d.test",
                &wire,
                Needs {
                    size: 3,
                    ..Needs::default()
                },
            )
            .await;
        assert!(matches!(refused, SendOutcome::Refused(ref r) if r.enhanced() == Some((5, 1, 1))));
    }

    #[tokio::test]
    async fn required_tls_needs_starttls() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let port = server("250 ok\r\n", log).await;
        let error = Connection::open(
            &settings(port),
            "mx.test",
            Ipv4Addr::LOCALHOST,
            TlsMode::Required,
        )
        .await
        .expect_err("no STARTTLS");
        assert_eq!(error, ConnectError::NoStartTls);
    }
}
