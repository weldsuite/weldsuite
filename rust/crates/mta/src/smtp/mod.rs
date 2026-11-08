//! SMTP (RFC 5321) both ways: [`server`] for submission and the bounce MX,
//! [`client`] for delivery. [`Reply`] and the line I/O are shared.

pub mod client;
pub mod server;

use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, BufReader, ReadBuf};

/// A byte stream an SMTP session runs over: TCP, or TLS after STARTTLS.
pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// A boxed [`Io`] that is itself [`Io`].
pub struct Stream(pub Box<dyn Io>);

impl AsyncRead for Stream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.0).poll_read(cx, buf)
    }
}

impl AsyncWrite for Stream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut *self.0).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.0).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.0).poll_shutdown(cx)
    }
}

/// Reads one line (up to and including LF) of at most `max` bytes. `None`
/// at end of stream; an over-long line is an error.
pub(crate) async fn read_line(
    reader: &mut BufReader<Stream>,
    max: usize,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut line = Vec::with_capacity(128);
    let limit = u64::try_from(max).unwrap_or(u64::MAX);
    let read = (&mut *reader)
        .take(limit)
        .read_until(b'\n', &mut line)
        .await?;
    if read == 0 {
        return Ok(None);
    }
    if !line.ends_with(b"\n") {
        if line.len() >= max {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "line too long",
            ));
        }
        return Ok(None);
    }
    Ok(Some(line))
}

/// An SMTP reply: code and text lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub code: u16,
    pub lines: Vec<String>,
}

impl Reply {
    pub fn new(code: u16, text: impl Into<String>) -> Self {
        Self {
            code,
            lines: vec![text.into()],
        }
    }

    pub fn is_positive(&self) -> bool {
        (200..400).contains(&self.code)
    }

    pub fn is_transient(&self) -> bool {
        (400..500).contains(&self.code)
    }

    pub fn is_permanent(&self) -> bool {
        self.code >= 500
    }

    /// The text, lines joined with a space.
    pub fn text(&self) -> String {
        self.lines.join(" ")
    }

    /// `550 5.1.1 user unknown`: code and text on one line, for logs and
    /// events (at most 500 characters).
    pub fn summary(&self) -> String {
        let mut out = format!("{} {}", self.code, self.text());
        if out.len() > 500 {
            let mut end = 500;
            while !out.is_char_boundary(end) {
                end -= 1;
            }
            out.truncate(end);
        }
        out
    }

    /// The enhanced status code (RFC 3463) the text starts with, if any.
    pub fn enhanced(&self) -> Option<(u8, u16, u16)> {
        let first = self.lines.first()?.split_whitespace().next()?;
        let mut parts = first.split('.');
        let class: u8 = parts.next()?.parse().ok()?;
        let subject: u16 = parts.next()?.parse().ok()?;
        let detail: u16 = parts.next()?.parse().ok()?;
        (parts.next().is_none() && matches!(class, 2 | 4 | 5)).then_some((class, subject, detail))
    }

    /// The wire form: `250-…` continuation lines and a final `250 …`.
    pub fn to_wire(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let last = self.lines.len().saturating_sub(1);
        for (index, line) in self.lines.iter().enumerate() {
            let separator = if index == last { ' ' } else { '-' };
            out.extend_from_slice(format!("{}{separator}{line}\r\n", self.code).as_bytes());
        }
        if self.lines.is_empty() {
            out.extend_from_slice(format!("{}\r\n", self.code).as_bytes());
        }
        out
    }
}

impl std::fmt::Display for Reply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.summary())
    }
}

/// Reads a (possibly multi-line) reply.
pub(crate) async fn read_reply(reader: &mut BufReader<Stream>) -> std::io::Result<Reply> {
    let mut lines = Vec::new();
    let mut code = 0;
    loop {
        let Some(line) = read_line(reader, 4096).await? else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "connection closed",
            ));
        };
        let line = String::from_utf8_lossy(&line);
        let line = line.trim_end_matches(['\r', '\n']);
        let parsed: Option<u16> = line.get(..3).and_then(|c| c.parse().ok());
        let Some(this) = parsed.filter(|c| (200..600).contains(c)) else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "not an SMTP reply: {}",
                    line.chars().take(80).collect::<String>()
                ),
            ));
        };
        if code != 0 && this != code {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "reply codes differ between lines",
            ));
        }
        code = this;
        lines.push(line.get(4..).unwrap_or("").to_owned());
        if line.as_bytes().get(3) != Some(&b'-') {
            return Ok(Reply { code, lines });
        }
        if lines.len() > 100 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "reply too long",
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reader(bytes: &'static [u8]) -> BufReader<Stream> {
        BufReader::new(Stream(Box::new(tokio::io::join(bytes, tokio::io::sink()))))
    }

    #[tokio::test]
    async fn reads_multi_line_replies() {
        let mut r = reader(b"250-mx.example.com hi\r\n250-PIPELINING\r\n250 STARTTLS\r\n550 5.1.1 no such user\r\n");
        let reply = read_reply(&mut r).await.expect("reply");
        assert_eq!(reply.code, 250);
        assert_eq!(
            reply.lines,
            vec!["mx.example.com hi", "PIPELINING", "STARTTLS"]
        );
        let reply = read_reply(&mut r).await.expect("reply");
        assert!(reply.is_permanent());
        assert_eq!(reply.enhanced(), Some((5, 1, 1)));
        assert_eq!(reply.summary(), "550 5.1.1 no such user");
    }

    #[tokio::test]
    async fn refuses_garbage_and_mixed_codes() {
        assert!(read_reply(&mut reader(b"hello\r\n")).await.is_err());
        assert!(
            read_reply(&mut reader(b"250-a\r\n251 b\r\n"))
                .await
                .is_err()
        );
        assert!(read_reply(&mut reader(b"")).await.is_err());
    }

    #[test]
    fn writes_replies() {
        let reply = Reply {
            code: 250,
            lines: vec!["a".into(), "b".into()],
        };
        assert_eq!(reply.to_wire(), b"250-a\r\n250 b\r\n");
        assert_eq!(Reply::new(354, "go").to_wire(), b"354 go\r\n");
        assert_eq!(Reply::new(250, "2.0.0 ok").enhanced(), Some((2, 0, 0)));
        assert_eq!(Reply::new(250, "ok").enhanced(), None);
    }

    #[tokio::test]
    async fn limits_line_length() {
        let mut r = reader(b"0123456789\r\n");
        assert!(read_line(&mut r, 5).await.is_err());
    }
}
