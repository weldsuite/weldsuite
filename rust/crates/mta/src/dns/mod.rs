//! A DNS stub resolver: asks one recursive resolver (the cluster's, from
//! `/etc/resolv.conf`, or `MTA_RESOLVER`) over UDP, and again over TCP when
//! the answer is truncated. Answers are cached for their TTL (at most an
//! hour), failures for a few seconds.
//!
//! What delivery needs on top: [`Resolver::mx`] with the null MX (RFC 7505)
//! and the implicit MX (RFC 5321 §5.1) rules.

pub mod wire;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};

use self::wire::{Rcode, Record, Response};

/// Why a lookup gave no usable answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DnsError {
    /// The name does not exist (NXDOMAIN): permanent.
    NoSuchName,
    /// The resolver failed, timed out or answered garbage: try again later.
    Temporary(String),
}

impl std::fmt::Display for DnsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoSuchName => f.write_str("no such domain"),
            Self::Temporary(message) => write!(f, "DNS lookup failed: {message}"),
        }
    }
}

impl std::error::Error for DnsError {}

/// Where mail for a domain goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MxAnswer {
    /// The exchanges, best preference first (ties in random order).
    Hosts(Vec<String>),
    /// `MX 0 .`: the domain accepts no mail.
    NullMx,
}

type CacheKey = (String, u16);
/// When the entry expires, and the answer.
type CacheEntry = (Instant, Result<Vec<Record>, DnsError>);

/// The resolver. Cheap to share (`Arc`).
#[derive(Debug)]
pub struct Resolver {
    server: SocketAddr,
    timeout: Duration,
    cache: Mutex<HashMap<CacheKey, CacheEntry>>,
}

const CACHE_LIMIT: usize = 20_000;
const MAX_TTL: u32 = 3600;
const NEGATIVE_TTL: Duration = Duration::from_secs(60);
const FAILURE_TTL: Duration = Duration::from_secs(5);

impl Resolver {
    pub fn new(server: SocketAddr) -> Self {
        Self {
            server,
            timeout: Duration::from_secs(5),
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// The first `nameserver` of `/etc/resolv.conf`, else 127.0.0.1:53.
    pub fn system() -> Self {
        let server = std::fs::read_to_string("/etc/resolv.conf")
            .ok()
            .and_then(|text| first_nameserver(&text))
            .unwrap_or(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 53));
        Self::new(server)
    }

    pub fn server(&self) -> SocketAddr {
        self.server
    }

    /// The records of `qtype` at `name` (CNAMEs skipped). An existing name
    /// without such records is `Ok(vec![])`.
    pub async fn lookup(&self, name: &str, qtype: u16) -> Result<Vec<Record>, DnsError> {
        let key = (name.trim_end_matches('.').to_ascii_lowercase(), qtype);
        if let Some(hit) = self.cached(&key) {
            return hit;
        }
        let result = self.query(&key.0, qtype).await;
        let ttl = match &result {
            Ok((_, ttl)) if *ttl > 0 => Duration::from_secs(u64::from((*ttl).min(MAX_TTL))),
            Ok(_) | Err(DnsError::NoSuchName) => NEGATIVE_TTL,
            Err(DnsError::Temporary(_)) => FAILURE_TTL,
        };
        let records = result.map(|(records, _)| records);
        self.store(key, ttl, records.clone());
        records
    }

    fn cached(&self, key: &CacheKey) -> Option<Result<Vec<Record>, DnsError>> {
        let cache = self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        cache
            .get(key)
            .filter(|(expires, _)| *expires > Instant::now())
            .map(|(_, value)| value.clone())
    }

    fn store(&self, key: CacheKey, ttl: Duration, value: Result<Vec<Record>, DnsError>) {
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if cache.len() >= CACHE_LIMIT {
            let now = Instant::now();
            cache.retain(|_, (expires, _)| *expires > now);
            if cache.len() >= CACHE_LIMIT {
                cache.clear();
            }
        }
        cache.insert(key, (Instant::now() + ttl, value));
    }

    async fn query(&self, name: &str, qtype: u16) -> Result<(Vec<Record>, u32), DnsError> {
        let mut last = DnsError::Temporary("no answer".into());
        for _ in 0..2 {
            match self.query_once(name, qtype).await {
                Ok(response) => return interpret(response, qtype),
                Err(error) => last = error,
            }
        }
        Err(last)
    }

    async fn query_once(&self, name: &str, qtype: u16) -> Result<Response, DnsError> {
        let mut id_bytes = [0u8; 2];
        let _ = aws_lc_rs::rand::fill(&mut id_bytes);
        let id = u16::from_be_bytes(id_bytes);
        let query =
            wire::build_query(id, name, qtype).map_err(|e| DnsError::Temporary(e.to_string()))?;
        let response = tokio::time::timeout(self.timeout, self.udp(&query, id))
            .await
            .map_err(|_| DnsError::Temporary("timed out".into()))??;
        if !response.truncated {
            return Ok(response);
        }
        tokio::time::timeout(self.timeout, self.tcp(&query, id))
            .await
            .map_err(|_| DnsError::Temporary("timed out over TCP".into()))?
    }

    async fn udp(&self, query: &[u8], id: u16) -> Result<Response, DnsError> {
        let bind: SocketAddr = if self.server.is_ipv4() {
            (Ipv4Addr::UNSPECIFIED, 0).into()
        } else {
            (std::net::Ipv6Addr::UNSPECIFIED, 0).into()
        };
        let socket = UdpSocket::bind(bind).await.map_err(|e| temporary(&e))?;
        socket
            .connect(self.server)
            .await
            .map_err(|e| temporary(&e))?;
        socket.send(query).await.map_err(|e| temporary(&e))?;
        let mut buf = vec![0u8; 4096];
        loop {
            let len = socket.recv(&mut buf).await.map_err(|e| temporary(&e))?;
            // A datagram with another id is not ours (spoofing or a late
            // answer): keep waiting until the timeout.
            if let Ok(response) = wire::parse_response(&buf[..len])
                && response.id == id
            {
                return Ok(response);
            }
        }
    }

    async fn tcp(&self, query: &[u8], id: u16) -> Result<Response, DnsError> {
        let mut stream = TcpStream::connect(self.server)
            .await
            .map_err(|e| temporary(&e))?;
        let len =
            u16::try_from(query.len()).map_err(|_| DnsError::Temporary("query too long".into()))?;
        let mut framed = len.to_be_bytes().to_vec();
        framed.extend_from_slice(query);
        stream.write_all(&framed).await.map_err(|e| temporary(&e))?;
        let mut len = [0u8; 2];
        stream
            .read_exact(&mut len)
            .await
            .map_err(|e| temporary(&e))?;
        let mut buf = vec![0u8; usize::from(u16::from_be_bytes(len))];
        stream
            .read_exact(&mut buf)
            .await
            .map_err(|e| temporary(&e))?;
        let response =
            wire::parse_response(&buf).map_err(|e| DnsError::Temporary(e.to_string()))?;
        if response.id != id {
            return Err(DnsError::Temporary("answer for another query".into()));
        }
        Ok(response)
    }

    /// Where mail for `domain` goes (RFC 5321 §5.1, RFC 7505).
    pub async fn mx(&self, domain: &str) -> Result<MxAnswer, DnsError> {
        let records = self.lookup(domain, wire::TYPE_MX).await?;
        let mut mx: Vec<(u16, String)> = records
            .into_iter()
            .filter_map(|record| match record {
                Record::Mx {
                    preference,
                    exchange,
                } => Some((preference, exchange)),
                _ => None,
            })
            .collect();
        if mx.is_empty() {
            // No MX: the domain itself, if it has an address.
            let addresses = self.ipv4(domain).await?;
            return if addresses.is_empty() {
                Err(DnsError::NoSuchName)
            } else {
                Ok(MxAnswer::Hosts(vec![domain.to_ascii_lowercase()]))
            };
        }
        if mx.len() == 1 && mx[0].1.is_empty() {
            return Ok(MxAnswer::NullMx);
        }
        mx.retain(|(_, host)| !host.is_empty());
        shuffle(&mut mx);
        mx.sort_by_key(|(preference, _)| *preference);
        Ok(MxAnswer::Hosts(
            mx.into_iter().map(|(_, host)| host).collect(),
        ))
    }

    pub async fn ipv4(&self, host: &str) -> Result<Vec<Ipv4Addr>, DnsError> {
        match self.lookup(host, wire::TYPE_A).await {
            Ok(records) => Ok(records
                .into_iter()
                .filter_map(|record| match record {
                    Record::A(ip) => Some(ip),
                    _ => None,
                })
                .collect()),
            Err(DnsError::NoSuchName) => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }

    /// The TXT records at `name`; a missing name is no records.
    pub async fn txt(&self, name: &str) -> Result<Vec<String>, DnsError> {
        match self.lookup(name, wire::TYPE_TXT).await {
            Ok(records) => Ok(records
                .into_iter()
                .filter_map(|record| match record {
                    Record::Txt(text) => Some(text),
                    _ => None,
                })
                .collect()),
            Err(DnsError::NoSuchName) => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }

    /// The PTR name of `ip`, when it has one.
    pub async fn ptr(&self, ip: Ipv4Addr) -> Result<Option<String>, DnsError> {
        match self.lookup(&wire::reverse_name(ip), wire::TYPE_PTR).await {
            Ok(records) => Ok(records.into_iter().find_map(|record| match record {
                Record::Ptr(name) => Some(name),
                _ => None,
            })),
            Err(DnsError::NoSuchName) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

fn temporary(error: &std::io::Error) -> DnsError {
    DnsError::Temporary(error.to_string())
}

/// `NoError` answers with their smallest TTL; NXDOMAIN; failures.
fn interpret(response: Response, qtype: u16) -> Result<(Vec<Record>, u32), DnsError> {
    match response.rcode {
        Rcode::NoError => {
            let mut ttl = u32::MAX;
            let mut records = Vec::new();
            for answer in response.answers {
                let matches = matches!(
                    (&answer.record, qtype),
                    (Record::A(_), wire::TYPE_A)
                        | (Record::Aaaa(_), wire::TYPE_AAAA)
                        | (Record::Mx { .. }, wire::TYPE_MX)
                        | (Record::Txt(_), wire::TYPE_TXT)
                        | (Record::Ptr(_), wire::TYPE_PTR)
                );
                if matches {
                    ttl = ttl.min(answer.ttl);
                    records.push(answer.record);
                }
            }
            Ok((records, if ttl == u32::MAX { 0 } else { ttl }))
        }
        Rcode::NxDomain => Err(DnsError::NoSuchName),
        Rcode::Failure(code) => Err(DnsError::Temporary(format!(
            "resolver answered rcode {code}"
        ))),
    }
}

fn first_nameserver(text: &str) -> Option<SocketAddr> {
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        (parts.next()? == "nameserver")
            .then(|| parts.next())
            .flatten()
            .and_then(|ip| ip.parse::<IpAddr>().ok())
            .map(|ip| SocketAddr::new(ip, 53))
    })
}

/// Fisher–Yates with the system RNG (spreads load over equal-preference MXs;
/// the sort after it is stable).
fn shuffle<T>(items: &mut [T]) {
    for i in (1..items.len()).rev() {
        let mut bytes = [0u8; 4];
        let _ = aws_lc_rs::rand::fill(&mut bytes);
        let j = (u32::from_be_bytes(bytes) as usize) % (i + 1);
        items.swap(i, j);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::wire::tests::{mx_rdata, response, txt_rdata};
    use super::*;

    /// A UDP DNS server answering from `answers(name, qtype)`; returns its
    /// address.
    pub(crate) async fn fake_server(
        answers: impl Fn(&str, u16) -> (u16, Vec<(String, u16, Vec<u8>)>) + Send + 'static,
    ) -> SocketAddr {
        let socket = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
        let addr = socket.local_addr().expect("addr");
        tokio::spawn(async move {
            let mut buf = vec![0u8; 1500];
            while let Ok((len, peer)) = socket.recv_from(&mut buf).await {
                let query = &buf[..len];
                let id = u16::from_be_bytes([query[0], query[1]]);
                let (name, end) = super::wire::tests_read_name(query, 12);
                let qtype = u16::from_be_bytes([query[end], query[end + 1]]);
                let (rcode, records) = answers(&name, qtype);
                let borrowed: Vec<(&str, u16, Vec<u8>)> = records
                    .iter()
                    .map(|(n, t, d)| (n.as_str(), *t, d.clone()))
                    .collect();
                let data = response(id, rcode, (&name, qtype), &borrowed);
                let _ = socket.send_to(&data, peer).await;
            }
        });
        addr
    }

    #[tokio::test]
    async fn resolves_mx_null_mx_and_implicit_mx() {
        let server = fake_server(|name, qtype| match (name, qtype) {
            ("example.com", wire::TYPE_MX) => (
                0,
                vec![
                    (
                        "example.com".into(),
                        wire::TYPE_MX,
                        mx_rdata(20, "b.example.com"),
                    ),
                    (
                        "example.com".into(),
                        wire::TYPE_MX,
                        mx_rdata(10, "a.example.com"),
                    ),
                ],
            ),
            ("null.example", wire::TYPE_MX) => (
                0,
                vec![("null.example".into(), wire::TYPE_MX, mx_rdata(0, ""))],
            ),
            ("bare.example", wire::TYPE_A) => (
                0,
                vec![("bare.example".into(), wire::TYPE_A, vec![192, 0, 2, 7])],
            ),
            ("_mta-sts.example.com", wire::TYPE_TXT) => (
                0,
                vec![(
                    "_mta-sts.example.com".into(),
                    wire::TYPE_TXT,
                    txt_rdata(&["v=STSv1; id=1"]),
                )],
            ),
            ("gone.example", _) => (3, vec![]),
            _ => (0, vec![]),
        })
        .await;
        let resolver = Resolver::new(server);
        assert_eq!(
            resolver.mx("example.com").await,
            Ok(MxAnswer::Hosts(vec![
                "a.example.com".into(),
                "b.example.com".into()
            ]))
        );
        assert_eq!(resolver.mx("null.example").await, Ok(MxAnswer::NullMx));
        assert_eq!(
            resolver.mx("bare.example").await,
            Ok(MxAnswer::Hosts(vec!["bare.example".into()]))
        );
        assert_eq!(resolver.mx("gone.example").await, Err(DnsError::NoSuchName));
        assert_eq!(
            resolver.mx("empty.example").await,
            Err(DnsError::NoSuchName)
        );
        assert_eq!(
            resolver.txt("_mta-sts.example.com").await,
            Ok(vec!["v=STSv1; id=1".to_owned()])
        );
        assert_eq!(resolver.txt("gone.example").await, Ok(vec![]));
    }

    #[test]
    fn reads_resolv_conf() {
        let text =
            "# generated\nsearch svc.cluster.local\nnameserver 10.96.0.10\nnameserver 1.1.1.1\n";
        assert_eq!(
            first_nameserver(text),
            Some("10.96.0.10:53".parse().expect("addr"))
        );
        assert_eq!(first_nameserver("search x\n"), None);
    }
}
