//! The DNS host port: where customer zones and their records live. Global
//! and these editions use Cloudflare's API (`crate::cloudflare`, the
//! `@weldsuite/cloudflare-zones` twin); another provider plugs in by
//! implementing [`DnsHost`].
//!
//! Errors keep `@weldsuite/cloudflare-zones`' `CloudflareZoneError` kinds,
//! messages and codes, since the routes answer with them.

use std::fmt;
use std::sync::Arc;

use serde_json::Value;
use weldsuite_ports::BoxFuture;

/// `CloudflareZoneError['kind']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ZoneErrorKind {
    InAnotherAccount,
    AuthFailed,
    InvalidDomain,
    Unknown,
}

/// `CloudflareZoneError`.
#[derive(Debug, Clone)]
pub(crate) struct ZoneError {
    pub(crate) kind: ZoneErrorKind,
    pub(crate) message: String,
    /// The provider's error codes.
    pub(crate) codes: Vec<i64>,
    pub(crate) status: Option<u16>,
}

impl fmt::Display for ZoneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "CloudflareZoneError {:?}: {}", self.kind, self.message)
    }
}

/// A zone as created or read.
#[derive(Debug, Clone)]
pub(crate) struct Zone {
    pub(crate) zone_id: String,
    pub(crate) nameservers: Vec<String>,
    pub(crate) status: String,
}

/// `CloudflareDnsRecord`, flattened.
#[derive(Debug, Clone)]
pub(crate) struct DnsRecord {
    pub(crate) id: String,
    /// The type when the client can edit it (A, AAAA, CNAME, MX, TXT, CAA,
    /// SRV, NS), else `None`.
    pub(crate) editable_type: Option<String>,
    pub(crate) name: String,
    /// The value as users type it (TXT unquoted; SRV and CAA in zone-file form).
    pub(crate) content: String,
    pub(crate) ttl: Value,
    pub(crate) priority: Value,
    pub(crate) comment: Value,
    /// The structured `data` (SRV, CAA), `Null` without it.
    pub(crate) data: Value,
}

/// `CreateDnsRecordInput`.
#[derive(Debug, Clone)]
pub(crate) struct RecordInput {
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) content: String,
    pub(crate) ttl: Option<f64>,
    pub(crate) priority: Option<f64>,
    pub(crate) comment: Option<String>,
}

/// What a create did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Created {
    Created,
    /// The record was already there.
    Duplicate,
}

/// A DNS hosting provider.
pub(crate) trait DnsHost: Send + Sync {
    /// `createCloudflareZone`.
    fn create_zone<'a>(&'a self, account: &'a str, domain: &'a str)
    -> BoxFuture<'a, Result<Zone, ZoneError>>;
    /// `getCloudflareZone`: `None` when the zone no longer exists.
    fn get_zone<'a>(&'a self, zone_id: &'a str) -> BoxFuture<'a, Result<Option<Zone>, ZoneError>>;
    /// `deleteCloudflareZone`: a failure is logged, never returned.
    fn delete_zone<'a>(&'a self, zone_id: &'a str) -> BoxFuture<'a, ()>;
    /// `listDnsRecordsInZone`: every record, every page.
    fn list_records<'a>(&'a self, zone_id: &'a str)
    -> BoxFuture<'a, Result<Vec<DnsRecord>, ZoneError>>;
    /// `createDnsRecordInZone`.
    fn create_record<'a>(
        &'a self,
        zone_id: &'a str,
        record: &'a RecordInput,
    ) -> BoxFuture<'a, Result<Created, ZoneError>>;
    /// `updateDnsRecordInZone`.
    fn update_record<'a>(
        &'a self,
        zone_id: &'a str,
        record_id: &'a str,
        record: &'a RecordInput,
    ) -> BoxFuture<'a, Result<(), ZoneError>>;
    /// `deleteDnsRecordInZone`: a record already gone is no error.
    fn delete_record<'a>(
        &'a self,
        zone_id: &'a str,
        record_id: &'a str,
    ) -> BoxFuture<'a, Result<(), ZoneError>>;
}

/// The DNS host a request uses.
pub(crate) type Dns = Arc<dyn DnsHost>;
