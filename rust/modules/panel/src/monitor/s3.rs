//! The S3 API calls a raw export makes (PUT and DELETE of one object),
//! signed with AWS Signature Version 4 (`services/s3.ts`). Works with AWS
//! S3, Cloudflare R2, Google Cloud Storage (HMAC keys), MinIO and other
//! S3-compatible stores.
//!
//! Keys are URI-encoded once (S3's rule: unreserved characters and `/` stay,
//! everything else becomes `%XX`), and the request is sent with the same
//! encoded path it was signed with. The payload hash is the real SHA-256 of
//! the body. Requests go out on the outbound HTTP port the caller hands in:
//! the public-only client in production (the endpoint is the customer's), the
//! harness's bridge in conformance.

use std::fmt::Write as _;

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use super::schemas::is_public_hostname;

/// The access key pair an export signs with.
#[derive(Clone)]
pub(crate) struct Credentials {
    pub(crate) access_key_id: String,
    pub(crate) secret_access_key: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("access_key_id", &self.access_key_id)
            .finish_non_exhaustive()
    }
}

/// Where objects go (`S3Destination`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Destination {
    pub(crate) endpoint: Option<String>,
    pub(crate) region: String,
    pub(crate) bucket: String,
    pub(crate) path_style: bool,
}

/// The store refused a request (`S3Error`): its own short answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct S3Error {
    pub(crate) message: String,
    pub(crate) status: u16,
}

impl std::fmt::Display for S3Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub(crate) fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// `uriEncode(value)`: RFC 3986, only `A-Z a-z 0-9 - _ . ~` stay.
pub(crate) fn uri_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `encodeKey(key)`: each segment encoded, the slashes kept.
pub(crate) fn encode_key(key: &str) -> String {
    key.split('/').map(uri_encode).collect::<Vec<_>>().join("/")
}

/// `amzDates(now)`: `20130524T000000Z` and `20130524`.
fn amz_dates(now: i64) -> (String, String) {
    let iso = weldsuite_panel_domain::js::iso_string(now);
    let amz: String = iso
        .chars()
        .filter(|c| *c != '-' && *c != ':')
        .collect::<String>();
    // `20130524T000000.000Z` → drop the milliseconds.
    let amz = match amz.find('.') {
        Some(dot) => format!("{}{}", &amz[..dot], &amz[dot + 4..]),
        None => amz,
    };
    let stamp = amz[..8].to_owned();
    (amz, stamp)
}

/// What [`sign_request`] signs.
pub(crate) struct SignInput<'a> {
    pub(crate) method: &'a str,
    /// Absolute URL whose path is already encoded ([`encode_key`]).
    pub(crate) url: &'a str,
    pub(crate) headers: &'a [(&'a str, &'a str)],
    pub(crate) body: &'a [u8],
    pub(crate) credentials: &'a Credentials,
    pub(crate) region: &'a str,
    pub(crate) now: i64,
}

/// A URL's host, path and query pairs.
type UrlParts = (String, String, Vec<(String, String)>);

/// `(host, path, query pairs)` of an absolute URL, as `new URL()` reads them.
fn url_parts(url: &str) -> Option<UrlParts> {
    let parsed = url::Url::parse(url).ok()?;
    let host = match parsed.port() {
        Some(port) => format!("{}:{port}", parsed.host_str()?),
        None => parsed.host_str()?.to_owned(),
    };
    let pairs = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    Some((host, parsed.path().to_owned(), pairs))
}

/// `signRequest(input)`: the headers to send: the caller's (names lowercased,
/// values trimmed), `host`, `x-amz-date`, `x-amz-content-sha256` and
/// `authorization`, in signed order.
pub(crate) fn sign_request(input: &SignInput<'_>) -> Vec<(String, String)> {
    let (host, path, query) = url_parts(input.url).unwrap_or_default();
    let (amz_date, date_stamp) = amz_dates(input.now);
    let payload_hash = sha256_hex(input.body);

    let mut headers: Vec<(String, String)> = Vec::new();
    let mut set = |name: String, value: String| {
        if let Some(existing) = headers.iter_mut().find(|(n, _)| *n == name) {
            existing.1 = value;
        } else {
            headers.push((name, value));
        }
    };
    for (name, value) in input.headers {
        let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
        set(name.to_lowercase(), collapsed);
    }
    set("host".to_owned(), host);
    set("x-amz-date".to_owned(), amz_date.clone());
    set("x-amz-content-sha256".to_owned(), payload_hash.clone());
    headers.sort_by(|a, b| a.0.cmp(&b.0));

    let canonical_headers = headers.iter().fold(String::new(), |mut out, (n, v)| {
        let _ = writeln!(out, "{n}:{v}");
        out
    });
    let signed_headers = headers
        .iter()
        .map(|(n, _)| n.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let mut pairs: Vec<(String, String)> = query
        .iter()
        .map(|(k, v)| (uri_encode(k), uri_encode(v)))
        .collect();
    pairs.sort_by(|a, b| {
        a.0.encode_utf16()
            .cmp(b.0.encode_utf16())
            .then_with(|| a.1.encode_utf16().cmp(b.1.encode_utf16()))
    });
    let canonical_query = pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    let path = if path.is_empty() {
        "/".to_owned()
    } else {
        path
    };
    let canonical_request = [
        input.method.to_uppercase(),
        path,
        canonical_query,
        canonical_headers,
        signed_headers.clone(),
        payload_hash,
    ]
    .join("\n");

    let scope = format!("{date_stamp}/{}/s3/aws4_request", input.region);
    let string_to_sign = [
        "AWS4-HMAC-SHA256".to_owned(),
        amz_date,
        scope.clone(),
        sha256_hex(canonical_request.as_bytes()),
    ]
    .join("\n");
    let k_date = hmac(
        format!("AWS4{}", input.credentials.secret_access_key).as_bytes(),
        &date_stamp,
    );
    let k_region = hmac(&k_date, input.region);
    let k_service = hmac(&k_region, "s3");
    let k_signing = hmac(&k_service, "aws4_request");
    let signature = hex::encode(hmac(&k_signing, &string_to_sign));
    headers.push((
        "authorization".to_owned(),
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            input.credentials.access_key_id
        ),
    ));
    headers
}

/// `objectUrl(dest, key)`: AWS S3 virtual-hosted by default, or the
/// destination's endpoint, path-style or virtual-hosted.
pub(crate) fn object_url(dest: &Destination, key: &str) -> String {
    let path = encode_key(key.trim_start_matches('/'));
    let Some(endpoint) = dest.endpoint.as_deref().filter(|e| !e.is_empty()) else {
        return if dest.path_style {
            format!(
                "https://s3.{}.amazonaws.com/{}/{path}",
                dest.region, dest.bucket
            )
        } else {
            format!(
                "https://{}.s3.{}.amazonaws.com/{path}",
                dest.bucket, dest.region
            )
        };
    };
    let Ok(parsed) = url::Url::parse(endpoint) else {
        return format!("{endpoint}/{}/{path}", dest.bucket);
    };
    let host = match parsed.port() {
        Some(port) => format!("{}:{port}", parsed.host_str().unwrap_or_default()),
        None => parsed.host_str().unwrap_or_default().to_owned(),
    };
    if dest.path_style {
        return format!("{}://{host}/{}/{path}", parsed.scheme(), dest.bucket);
    }
    format!("{}://{}.{host}/{path}", parsed.scheme(), dest.bucket)
}

/// `safeObjectUrl(dest, key)`: https, no credentials, a public DNS host name;
/// checked before any request leaves.
pub(crate) fn safe_object_url(dest: &Destination, key: &str) -> Result<String, S3Error> {
    let url = object_url(dest, key);
    let refuse = || S3Error {
        message: "The endpoint is not a public https host name".to_owned(),
        status: 400,
    };
    let parsed = url::Url::parse(&url).map_err(|_| refuse())?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !is_public_hostname(host)
    {
        return Err(refuse());
    }
    Ok(parsed.to_string())
}

/// `s3Failure(res)`: `Code: Message` from an S3 XML error, else the status.
fn failure(status: u16, body: &str) -> S3Error {
    let tag = |name: &str, max: usize| -> Option<String> {
        let open = format!("<{name}>");
        let start = body.find(&open)? + open.len();
        let end = body[start..].find('<')? + start;
        let inner = &body[start..end];
        (!inner.is_empty() && inner.chars().count() <= max).then(|| inner.to_owned())
    };
    let message = match (tag("Code", 100), tag("Message", 300)) {
        (Some(code), Some(message)) => format!("{code}: {message}"),
        (Some(code), None) => code,
        _ => format!("The store answered {status}"),
    };
    S3Error { message, status }
}

fn request(
    method: &str,
    url: &str,
    signed: Vec<(String, String)>,
    body: Option<Vec<u8>>,
) -> HttpRequest {
    let mut request = HttpRequest::empty(method, url);
    // Without `host`: the client sets it from the URL (the value signed).
    for (name, value) in signed.into_iter().filter(|(n, _)| n != "host") {
        request = request.header(&name, value);
    }
    request.body = body;
    request
}

fn connection(error: &impl std::fmt::Display) -> S3Error {
    S3Error {
        message: error.to_string(),
        status: 0,
    }
}

/// `putObject(dest, credentials, key, body, headers)`.
pub(crate) async fn put_object(
    http: &OutboundHttp,
    dest: &Destination,
    credentials: &Credentials,
    key: &str,
    body: Vec<u8>,
    headers: &[(&str, &str)],
    now: i64,
) -> Result<(), S3Error> {
    let url = safe_object_url(dest, key)?;
    let signed = sign_request(&SignInput {
        method: "PUT",
        url: &url,
        headers,
        body: &body,
        credentials,
        region: &dest.region,
        now,
    });
    let response = http
        .send(request("PUT", &url, signed, Some(body)))
        .await
        .map_err(|error| connection(&error))?;
    if !response.ok() {
        return Err(failure(response.status, &response.text()));
    }
    Ok(())
}

/// `deleteObject(dest, credentials, key)`: a missing object counts as deleted.
pub(crate) async fn delete_object(
    http: &OutboundHttp,
    dest: &Destination,
    credentials: &Credentials,
    key: &str,
    now: i64,
) -> Result<(), S3Error> {
    let url = safe_object_url(dest, key)?;
    let signed = sign_request(&SignInput {
        method: "DELETE",
        url: &url,
        headers: &[],
        body: b"",
        credentials,
        region: &dest.region,
        now,
    });
    let response = http
        .send(request("DELETE", &url, signed, None))
        .await
        .map_err(|error| connection(&error))?;
    if !response.ok() && response.status != 404 {
        return Err(failure(response.status, &response.text()));
    }
    Ok(())
}

/// `gzip(text)`.
pub(crate) fn gzip(text: &str) -> Vec<u8> {
    use std::io::Write as _;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = encoder.write_all(text.as_bytes());
    encoder.finish().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use weldsuite_ports::{BoxFuture, DynOutboundHttp, HttpResponse, PortError};

    use super::*;

    fn credentials() -> Credentials {
        Credentials {
            access_key_id: "AKIAIOSFODNN7EXAMPLE".to_owned(),
            secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_owned(),
        }
    }

    const NOW: i64 = 1_369_353_600_000; // 2013-05-24T00:00:00Z
    const EMPTY_SHA: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> &'a str {
        headers
            .iter()
            .find(|(n, _)| n == name)
            .map_or("", |(_, v)| v.as_str())
    }

    // `s3.test.ts`: signRequest against AWS's published examples.
    #[test]
    fn matches_aws_get_object_example() {
        let creds = credentials();
        let headers = sign_request(&SignInput {
            method: "GET",
            url: "https://examplebucket.s3.amazonaws.com/test.txt",
            headers: &[("Range", "bytes=0-9")],
            body: b"",
            credentials: &creds,
            region: "us-east-1",
            now: NOW,
        });
        assert_eq!(header(&headers, "x-amz-content-sha256"), EMPTY_SHA);
        assert_eq!(header(&headers, "x-amz-date"), "20130524T000000Z");
        assert_eq!(
            header(&headers, "authorization"),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn matches_aws_put_object_example() {
        let body = b"Welcome to Amazon S3.";
        assert_eq!(
            sha256_hex(body),
            "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072"
        );
        let creds = credentials();
        let url = format!(
            "https://examplebucket.s3.amazonaws.com/{}",
            encode_key("test$file.text")
        );
        let headers = sign_request(&SignInput {
            method: "PUT",
            url: &url,
            headers: &[
                ("Date", "Fri, 24 May 2013 00:00:00 GMT"),
                ("x-amz-storage-class", "REDUCED_REDUNDANCY"),
            ],
            body,
            credentials: &creds,
            region: "us-east-1",
            now: NOW,
        });
        assert_eq!(
            header(&headers, "authorization"),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        );
    }

    #[test]
    fn matches_aws_get_bucket_lifecycle_example() {
        let creds = credentials();
        let headers = sign_request(&SignInput {
            method: "GET",
            url: "https://examplebucket.s3.amazonaws.com/?lifecycle",
            headers: &[],
            body: b"",
            credentials: &creds,
            region: "us-east-1",
            now: NOW,
        });
        assert!(header(&headers, "authorization").contains(
            "Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"
        ));
    }

    // addressing.
    #[test]
    fn encodes_each_key_segment_once_and_keeps_the_slashes() {
        assert_eq!(
            encode_key("a b/dt=2026-11-14/x:y*(1).gz"),
            "a%20b/dt%3D2026-11-14/x%3Ay%2A%281%29.gz"
        );
    }

    fn dest(endpoint: Option<&str>, region: &str, bucket: &str, path_style: bool) -> Destination {
        Destination {
            endpoint: endpoint.map(str::to_owned),
            region: region.to_owned(),
            bucket: bucket.to_owned(),
            path_style,
        }
    }

    #[test]
    fn uses_virtual_hosted_aws_hosts_by_default() {
        let s3 = dest(None, "eu-west-1", "acme", false);
        assert_eq!(
            object_url(&s3, "weldpanel/events/a.gz"),
            "https://acme.s3.eu-west-1.amazonaws.com/weldpanel/events/a.gz"
        );
        assert_eq!(
            object_url(&dest(None, "eu-west-1", "acme", true), "/a.gz"),
            "https://s3.eu-west-1.amazonaws.com/acme/a.gz"
        );
    }

    #[test]
    fn uses_the_endpoint_for_other_stores() {
        let r2 = dest(
            Some("https://acc.r2.cloudflarestorage.com"),
            "auto",
            "raw",
            true,
        );
        assert_eq!(
            object_url(&r2, "x/y.gz"),
            "https://acc.r2.cloudflarestorage.com/raw/x/y.gz"
        );
        let gcs = dest(Some("https://storage.googleapis.com"), "auto", "raw", false);
        assert_eq!(
            object_url(&gcs, "y.gz"),
            "https://raw.storage.googleapis.com/y.gz"
        );
    }

    struct Recorder(Mutex<Vec<HttpRequest>>, u16, &'static str);

    impl DynOutboundHttp for Recorder {
        fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, PortError>> {
            self.0.lock().expect("lock").push(request);
            let response = HttpResponse::new(self.1, self.2.as_bytes().to_vec());
            Box::pin(async move { Ok(response) })
        }
    }

    #[tokio::test]
    async fn only_sends_to_a_public_https_host_name() {
        let minio = |endpoint: &str| dest(Some(endpoint), "us-east-1", "raw", true);
        assert_eq!(
            safe_object_url(&minio("https://minio.example.com"), "a.gz").as_deref(),
            Ok("https://minio.example.com/raw/a.gz")
        );
        for endpoint in [
            "https://10.0.0.5",
            "https://localhost",
            "https://store.internal",
            "https://app-api.weldsuite.org",
            "https://[::1]",
        ] {
            let refused = safe_object_url(&minio(endpoint), "a.gz").expect_err(endpoint);
            assert!(refused.message.contains("public https host name"));
        }
        let recorder = Arc::new(Recorder(Mutex::default(), 200, ""));
        let http = OutboundHttp(recorder.clone());
        let creds = Credentials {
            access_key_id: "AKID".to_owned(),
            secret_access_key: "secret".to_owned(),
        };
        assert!(
            put_object(
                &http,
                &minio("https://169.254.169.254"),
                &creds,
                "a.gz",
                Vec::new(),
                &[],
                NOW
            )
            .await
            .is_err()
        );
        assert!(recorder.0.lock().expect("lock").is_empty());
    }

    // putObject / deleteObject.
    #[tokio::test]
    async fn sends_the_signed_request_without_a_host_header_and_reports_the_store_error() {
        let creds = credentials();
        let s3 = dest(None, "us-east-1", "acme", false);
        let refusing = Arc::new(Recorder(
            Mutex::default(),
            403,
            "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>",
        ));
        let http = OutboundHttp(refusing.clone());
        let error = put_object(&http, &s3, &creds, "a.txt", vec![1], &[], NOW)
            .await
            .expect_err("refused");
        assert_eq!(error.message, "AccessDenied: Access Denied");
        let sent = refusing.0.lock().expect("lock").remove(0);
        assert_eq!(sent.url, "https://acme.s3.us-east-1.amazonaws.com/a.txt");
        assert!(sent.headers.iter().all(|(n, _)| n != "host"));
        assert!(sent.headers.iter().any(
            |(n, v)| n == "authorization" && v.starts_with("AWS4-HMAC-SHA256 Credential=AKIA")
        ));
        // A missing object counts as deleted.
        let missing = OutboundHttp(Arc::new(Recorder(Mutex::default(), 404, "")));
        assert!(
            delete_object(&missing, &s3, &creds, "a.txt", NOW)
                .await
                .is_ok()
        );
    }
}
