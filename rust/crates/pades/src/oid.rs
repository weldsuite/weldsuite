//! The object identifiers PAdES, CMS, X.509, RFC 3161, OCSP and the eIDAS
//! QC statements (ETSI EN 319 412-5) use.

// Digests.
pub const SHA1: &str = "1.3.14.3.2.26";
pub const SHA256: &str = "2.16.840.1.101.3.4.2.1";
pub const SHA384: &str = "2.16.840.1.101.3.4.2.2";
pub const SHA512: &str = "2.16.840.1.101.3.4.2.3";

// Keys and signature algorithms.
pub const RSA_ENCRYPTION: &str = "1.2.840.113549.1.1.1";
pub const RSASSA_PSS: &str = "1.2.840.113549.1.1.10";
pub const SHA256_WITH_RSA: &str = "1.2.840.113549.1.1.11";
pub const SHA384_WITH_RSA: &str = "1.2.840.113549.1.1.12";
pub const SHA512_WITH_RSA: &str = "1.2.840.113549.1.1.13";
pub const EC_PUBLIC_KEY: &str = "1.2.840.10045.2.1";
pub const CURVE_P256: &str = "1.2.840.10045.3.1.7";
pub const CURVE_P384: &str = "1.3.132.0.34";
pub const ECDSA_SHA256: &str = "1.2.840.10045.4.3.2";
pub const ECDSA_SHA384: &str = "1.2.840.10045.4.3.3";
pub const ECDSA_SHA512: &str = "1.2.840.10045.4.3.4";

// CMS.
pub const DATA: &str = "1.2.840.113549.1.7.1";
pub const SIGNED_DATA: &str = "1.2.840.113549.1.7.2";
pub const TST_INFO: &str = "1.2.840.113549.1.9.16.1.4";
pub const CONTENT_TYPE: &str = "1.2.840.113549.1.9.3";
pub const MESSAGE_DIGEST: &str = "1.2.840.113549.1.9.4";
pub const SIGNING_TIME: &str = "1.2.840.113549.1.9.5";
pub const SIGNING_CERTIFICATE: &str = "1.2.840.113549.1.9.16.2.12";
pub const SIGNING_CERTIFICATE_V2: &str = "1.2.840.113549.1.9.16.2.47";
pub const SIGNATURE_TIMESTAMP: &str = "1.2.840.113549.1.9.16.2.14";

// Names.
pub const COMMON_NAME: &str = "2.5.4.3";
pub const SURNAME: &str = "2.5.4.4";
pub const SERIAL_NUMBER: &str = "2.5.4.5";
pub const COUNTRY: &str = "2.5.4.6";
pub const LOCALITY: &str = "2.5.4.7";
pub const ORGANIZATION: &str = "2.5.4.10";
pub const ORGANIZATIONAL_UNIT: &str = "2.5.4.11";
pub const GIVEN_NAME: &str = "2.5.4.42";
pub const ORGANIZATION_IDENTIFIER: &str = "2.5.4.97";
pub const EMAIL_ADDRESS: &str = "1.2.840.113549.1.9.1";

// Extensions.
pub const SUBJECT_KEY_ID: &str = "2.5.29.14";
pub const KEY_USAGE: &str = "2.5.29.15";
pub const BASIC_CONSTRAINTS: &str = "2.5.29.19";
pub const CRL_DISTRIBUTION_POINTS: &str = "2.5.29.31";
pub const CERTIFICATE_POLICIES: &str = "2.5.29.32";
pub const AUTHORITY_KEY_ID: &str = "2.5.29.35";
pub const EXT_KEY_USAGE: &str = "2.5.29.37";
pub const AUTHORITY_INFO_ACCESS: &str = "1.3.6.1.5.5.7.1.1";
pub const QC_STATEMENTS: &str = "1.3.6.1.5.5.7.1.3";
pub const AD_OCSP: &str = "1.3.6.1.5.5.7.48.1";
pub const AD_CA_ISSUERS: &str = "1.3.6.1.5.5.7.48.2";
pub const KP_TIME_STAMPING: &str = "1.3.6.1.5.5.7.3.8";
pub const KP_OCSP_SIGNING: &str = "1.3.6.1.5.5.7.3.9";
pub const OCSP_BASIC: &str = "1.3.6.1.5.5.7.48.1.1";
pub const OCSP_NOCHECK: &str = "1.3.6.1.5.5.7.48.1.5";

// eIDAS QC statements (ETSI EN 319 412-5).
pub const QC_COMPLIANCE: &str = "0.4.0.1862.1.1";
pub const QC_SSCD: &str = "0.4.0.1862.1.4";
pub const QC_TYPE: &str = "0.4.0.1862.1.6";
pub const QCT_ESIGN: &str = "0.4.0.1862.1.6.1";
pub const QCT_ESEAL: &str = "0.4.0.1862.1.6.2";
