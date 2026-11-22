//! [`ClamdScanner`]: the `VirusScanner` port over clamd's TCP protocol
//! (`INSTREAM`), for the chart's `clamav` Deployment.
//!
//! One connection per file: `zINSTREAM\0`, the bytes as chunks of a 4-byte
//! big-endian length and the data, a zero-length chunk, then one reply
//! ending in a NUL: `stream: OK`, `stream: <signature> FOUND` or
//! `<reason> ERROR`. clamd closes the connection early when the stream
//! passes its `StreamMaxLength`, so a write that fails is followed by a read
//! of whatever it answered.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use weldsuite_ports::{BoxFuture, PortError, ScanVerdict, VirusScanner};

/// clamd's chunk size limit is its `StreamMaxLength`; any size below it works.
const CHUNK: usize = 64 * 1024;
/// A reply is one short line; anything longer is not clamd.
const MAX_REPLY: usize = 4096;

/// clamd at `host:port`.
#[derive(Debug, Clone)]
pub struct ClamdScanner {
    address: String,
    connect_timeout: Duration,
    scan_timeout: Duration,
}

impl ClamdScanner {
    /// `address` is `host:port` (the chart's `clamav` Service, port 3310).
    /// `scan_timeout` bounds one whole scan, connect included.
    pub fn new(address: impl Into<String>, scan_timeout: Duration) -> Self {
        Self {
            address: address.into(),
            connect_timeout: Duration::from_secs(5).min(scan_timeout),
            scan_timeout,
        }
    }

    async fn scan_once(&self, bytes: &[u8]) -> Result<ScanVerdict, PortError> {
        let mut stream =
            tokio::time::timeout(self.connect_timeout, TcpStream::connect(&self.address))
                .await
                .map_err(|_| {
                    PortError::backend(format!("clamd at {}: connect timed out", self.address))
                })?
                .map_err(|error| {
                    PortError::backend(format!("clamd at {}: {error}", self.address))
                })?;
        let written = write_stream(&mut stream, bytes).await;
        let reply = read_reply(&mut stream).await;
        match (written, reply) {
            (_, Ok(reply)) if !reply.is_empty() => parse_reply(&reply),
            (Err(error), _) | (Ok(()), Err(error)) => {
                Err(PortError::backend(format!("clamd: {error}")))
            }
            (Ok(()), Ok(_)) => Err(PortError::backend("clamd closed without a reply")),
        }
    }
}

async fn write_stream(stream: &mut TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    stream.write_all(b"zINSTREAM\0").await?;
    for chunk in bytes.chunks(CHUNK) {
        let len = u32::try_from(chunk.len()).unwrap_or(u32::MAX);
        stream.write_all(&len.to_be_bytes()).await?;
        stream.write_all(chunk).await?;
    }
    stream.write_all(&0u32.to_be_bytes()).await?;
    stream.flush().await
}

async fn read_reply(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut reply = Vec::new();
    let mut buf = [0u8; 512];
    loop {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        reply.extend_from_slice(&buf[..n]);
        if reply.contains(&0) || reply.len() >= MAX_REPLY {
            break;
        }
    }
    let end = reply.iter().position(|b| *b == 0).unwrap_or(reply.len());
    Ok(String::from_utf8_lossy(&reply[..end]).trim().to_owned())
}

/// One clamd reply as a verdict. A reply clamd would not send is an error,
/// not a verdict, so the file stays locked rather than marked clean.
pub(crate) fn parse_reply(reply: &str) -> Result<ScanVerdict, PortError> {
    let body = reply.strip_prefix("stream:").map_or(reply, str::trim);
    if body == "OK" {
        return Ok(ScanVerdict::Clean);
    }
    if let Some(signature) = body.strip_suffix(" FOUND") {
        let signature = signature.trim();
        return Ok(ScanVerdict::Infected {
            signature: if signature.is_empty() {
                "unknown".to_owned()
            } else {
                signature.to_owned()
            },
        });
    }
    if let Some(reason) = body.strip_suffix(" ERROR") {
        return Ok(ScanVerdict::Unscannable {
            reason: reason.trim().to_owned(),
        });
    }
    Err(PortError::backend(format!(
        "clamd: unexpected reply {reply:?}"
    )))
}

impl VirusScanner for ClamdScanner {
    fn scan<'a>(&'a self, bytes: &'a [u8]) -> BoxFuture<'a, Result<ScanVerdict, PortError>> {
        Box::pin(async move {
            tokio::time::timeout(self.scan_timeout, self.scan_once(bytes))
                .await
                .map_err(|_| {
                    PortError::backend(format!("clamd at {}: scan timed out", self.address))
                })?
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn replies() {
        assert_eq!(parse_reply("stream: OK").ok(), Some(ScanVerdict::Clean));
        assert_eq!(
            parse_reply("stream: Win.Test.EICAR_HDB-1 FOUND").ok(),
            Some(ScanVerdict::Infected {
                signature: "Win.Test.EICAR_HDB-1".to_owned()
            })
        );
        assert_eq!(
            parse_reply("INSTREAM size limit exceeded. ERROR").ok(),
            Some(ScanVerdict::Unscannable {
                reason: "INSTREAM size limit exceeded.".to_owned()
            })
        );
        assert!(parse_reply("PONG").is_err());
    }

    /// A fake clamd that reads the INSTREAM frames and answers by content.
    async fn fake_clamd() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr").to_string();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut command = [0u8; 10];
                    if socket.read_exact(&mut command).await.is_err() || &command != b"zINSTREAM\0"
                    {
                        return;
                    }
                    let mut data = Vec::new();
                    loop {
                        let mut len = [0u8; 4];
                        if socket.read_exact(&mut len).await.is_err() {
                            return;
                        }
                        let len = u32::from_be_bytes(len) as usize;
                        if len == 0 {
                            break;
                        }
                        let mut chunk = vec![0u8; len];
                        if socket.read_exact(&mut chunk).await.is_err() {
                            return;
                        }
                        data.extend_from_slice(&chunk);
                    }
                    let eicar = weldsuite_ports::EICAR;
                    let reply: &[u8] = if data.windows(eicar.len()).any(|w| w == eicar) {
                        b"stream: Eicar-Signature FOUND\0"
                    } else {
                        b"stream: OK\0"
                    };
                    let _ = socket.write_all(reply).await;
                });
            }
        });
        address
    }

    #[tokio::test]
    async fn scans_over_the_protocol() {
        let scanner = ClamdScanner::new(fake_clamd().await, Duration::from_secs(5));
        let mut infected = vec![b'x'; 200_000];
        infected.extend_from_slice(weldsuite_ports::EICAR);
        assert_eq!(
            scanner.scan(&infected).await.ok(),
            Some(ScanVerdict::Infected {
                signature: "Eicar-Signature".to_owned()
            })
        );
        assert_eq!(
            scanner.scan(b"a plain file").await.ok(),
            Some(ScanVerdict::Clean)
        );
    }

    #[tokio::test]
    async fn an_unreachable_clamd_is_an_error() {
        // Bind and drop: nothing listens on this port afterwards.
        let address = {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            listener.local_addr().expect("addr").to_string()
        };
        let scanner = ClamdScanner::new(address, Duration::from_secs(2));
        assert!(scanner.scan(b"x").await.is_err());
    }

    /// Against a real clamd at `CLAMD_TEST_ADDRESS` (`host:port`), e.g.
    /// `docker run -p 3310:3310 clamav/clamav:1.4`; skipped without it.
    #[tokio::test]
    async fn a_real_clamd_finds_eicar() {
        let Ok(address) = std::env::var("CLAMD_TEST_ADDRESS") else {
            eprintln!("skipped: CLAMD_TEST_ADDRESS is not set");
            return;
        };
        let scanner = ClamdScanner::new(address, Duration::from_secs(60));
        let verdict = scanner
            .scan(weldsuite_ports::EICAR)
            .await
            .expect("clamd answers");
        assert!(
            matches!(verdict, ScanVerdict::Infected { .. }),
            "{verdict:?}"
        );
        // Bigger than one chunk, clean.
        let clean = vec![b'a'; 3 * CHUNK + 17];
        assert_eq!(scanner.scan(&clean).await.ok(), Some(ScanVerdict::Clean));
    }
}
