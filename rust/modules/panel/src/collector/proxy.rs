//! What the proxy in front says about the visitor: the client address
//! (`X-Forwarded-For`) and the geo headers a first-party proxy or Vercel
//! sets. panel-ingest reads the same headers before Cloudflare's own
//! (`CF-Connecting-IP`, `request.cf`), which nothing in front of this server
//! sets.

use http::HeaderMap;
use weldsuite_kit::validation::js_trim;

use super::rows::Geo;
use super::url::{decode_uri, slice_utf16};

const MAX_GEO: usize = 100;

/// `request.headers.get(name)`: every value of the header joined with
/// `, `, each byte a character as a `ByteString` reads it; `None` when the
/// request has none.
pub(crate) fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| value.as_bytes().iter().copied().map(char::from).collect())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

/// Who sent a browser request (`requestAddresses`): the visitor as far as
/// we can tell, and the address that opened the connection to us (the
/// customer's proxy, when there is one).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Addresses {
    /// The first (leftmost) hop of `X-Forwarded-For`, which is the
    /// visitor's own when a first-party proxy forwards the beacon; else the
    /// connecting address. A client can name any address there; it is used
    /// for the cookieless hash, the IP filter and the rate limit only,
    /// never stored.
    pub(crate) client: String,
    pub(crate) connecting: String,
}

/// Where the connecting address comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Edge {
    /// Cloudflare's `CF-Connecting-IP`, as panel-ingest reads it: the test
    /// harness (conformance) plays the edge and sets it.
    Cloudflare,
    /// The `X-Forwarded-For` hop this many from the right: the proxies in
    /// front of this server (the ingress) append theirs. `CF-Connecting-IP`
    /// is not read: nothing in front of this server sets it, so a client
    /// could.
    TrustedProxies(usize),
}

/// The request's [`Addresses`].
pub(crate) fn request_addresses(headers: &HeaderMap, edge: Edge) -> Addresses {
    let forwarded = header(headers, "x-forwarded-for").unwrap_or_default();
    let hops: Vec<&str> = forwarded
        .split(',')
        .map(js_trim)
        .filter(|hop| !hop.is_empty())
        .collect();
    let connecting = match edge {
        Edge::Cloudflare => header(headers, "cf-connecting-ip").unwrap_or_default(),
        Edge::TrustedProxies(trusted) => hops
            .len()
            .checked_sub(trusted.max(1))
            .and_then(|at| hops.get(at))
            .map(|hop| (*hop).to_owned())
            .unwrap_or_default(),
    };
    Addresses {
        client: hops
            .first()
            .map_or_else(|| connecting.clone(), |hop| (*hop).to_owned()),
        connecting,
    }
}

/// One geo value: percent-decoded (kept as sent when that fails, as
/// `decodeURIComponent` throws), trimmed and cut to 100 UTF-16 units;
/// `None` when empty.
fn geo_value(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let decoded = if raw.contains('%') {
        decode_uri(raw, "").unwrap_or_else(|| raw.to_owned())
    } else {
        raw.to_owned()
    };
    let value = slice_utf16(js_trim(&decoded), MAX_GEO);
    (!value.is_empty()).then_some(value)
}

/// A country: two letters, upper-cased, not Cloudflare's `XX` (unknown).
fn country(raw: &str) -> Option<String> {
    let code = geo_value(Some(raw))?.to_uppercase();
    (code.len() == 2 && code.bytes().all(|b| b.is_ascii_uppercase()) && code != "XX")
        .then_some(code)
}

/// The request's geo: from `X-WeldPanel-Country`/`-Region`/`-City` (a
/// first-party proxy), else from Vercel's `x-vercel-ip-country`/
/// `-country-region`/`-city`, whichever family names a country; null
/// without either.
pub(crate) fn request_geo(headers: &HeaderMap) -> Geo {
    let families = [
        (
            "x-weldpanel-country",
            "x-weldpanel-region",
            "x-weldpanel-city",
        ),
        (
            "x-vercel-ip-country",
            "x-vercel-ip-country-region",
            "x-vercel-ip-city",
        ),
    ];
    for (country_header, region_header, city_header) in families {
        let Some(raw_country) =
            header(headers, country_header).filter(|value| !js_trim(value).is_empty())
        else {
            continue;
        };
        return Geo {
            country: country(&raw_country),
            region: geo_value(header(headers, region_header).as_deref()),
            city: geo_value(header(headers, city_header).as_deref()),
        };
    }
    Geo::default()
}

#[cfg(test)]
mod tests {
    use http::HeaderValue;

    use super::*;

    fn headers(entries: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in entries {
            map.append(*name, HeaderValue::from_str(value).expect("a header value"));
        }
        map
    }

    fn geo(country: Option<&str>, region: Option<&str>, city: Option<&str>) -> Geo {
        Geo {
            country: country.map(str::to_owned),
            region: region.map(str::to_owned),
            city: city.map(str::to_owned),
        }
    }

    fn client_ip(headers: &HeaderMap) -> String {
        request_addresses(headers, Edge::TrustedProxies(1)).client
    }

    #[test]
    fn takes_the_first_forwarded_hop() {
        assert_eq!(
            client_ip(&headers(&[(
                "x-forwarded-for",
                "198.51.100.9, 203.0.113.7"
            )])),
            "198.51.100.9"
        );
        assert_eq!(
            client_ip(&headers(&[
                ("x-forwarded-for", " , 198.51.100.9"),
                ("x-forwarded-for", "203.0.113.7"),
            ])),
            "198.51.100.9"
        );
        assert_eq!(
            client_ip(&headers(&[
                ("x-forwarded-for", ""),
                ("x-forwarded-for", "203.0.113.7"),
            ])),
            "203.0.113.7"
        );
        assert_eq!(client_ip(&headers(&[("x-forwarded-for", " , ")])), "");
        assert_eq!(
            client_ip(&headers(&[("cf-connecting-ip", "203.0.113.7")])),
            ""
        );
    }

    #[test]
    fn the_connecting_address_is_the_trusted_proxy_s_hop() {
        let proxied = headers(&[("x-forwarded-for", "198.51.100.9, 203.0.113.7")]);
        assert_eq!(
            request_addresses(&proxied, Edge::TrustedProxies(1)),
            Addresses {
                client: "198.51.100.9".to_owned(),
                connecting: "203.0.113.7".to_owned(),
            }
        );
        assert_eq!(
            request_addresses(&proxied, Edge::TrustedProxies(2)).connecting,
            "198.51.100.9"
        );
        assert_eq!(
            request_addresses(&proxied, Edge::TrustedProxies(3)).connecting,
            ""
        );
        // A forged CF-Connecting-IP counts only where Cloudflare is the edge.
        let direct = headers(&[("cf-connecting-ip", "203.0.113.7")]);
        assert_eq!(
            request_addresses(&direct, Edge::TrustedProxies(1)),
            Addresses::default()
        );
        assert_eq!(
            request_addresses(&direct, Edge::Cloudflare),
            Addresses {
                client: "203.0.113.7".to_owned(),
                connecting: "203.0.113.7".to_owned(),
            }
        );
    }

    #[test]
    fn reads_the_first_party_geo_headers() {
        assert_eq!(
            request_geo(&headers(&[
                ("x-weldpanel-country", "de"),
                ("x-weldpanel-region", "Berlin"),
                ("x-weldpanel-city", "Berlin%20Mitte"),
                ("x-vercel-ip-country", "NL"),
                ("x-vercel-ip-city", "Amsterdam"),
            ])),
            geo(Some("DE"), Some("Berlin"), Some("Berlin Mitte"))
        );
        // A country that is no country leaves the family's region and city.
        assert_eq!(
            request_geo(&headers(&[
                ("x-weldpanel-country", "XX"),
                ("x-weldpanel-city", "  "),
                ("x-vercel-ip-country", "NL"),
            ])),
            geo(None, None, None)
        );
        assert_eq!(
            request_geo(&headers(&[
                ("x-weldpanel-country", "Germany"),
                ("x-weldpanel-region", "BE"),
            ])),
            geo(None, Some("BE"), None)
        );
        assert_eq!(
            request_geo(&headers(&[("x-weldpanel-country", "%64%65")])),
            geo(Some("DE"), None, None)
        );
    }

    #[test]
    fn falls_back_to_vercel_s_geo_headers() {
        assert_eq!(
            request_geo(&headers(&[
                ("x-weldpanel-country", "  "),
                ("x-vercel-ip-country", "br"),
                ("x-vercel-ip-country-region", "SP"),
                ("x-vercel-ip-city", "S%C3%A3o%20Paulo"),
            ])),
            geo(Some("BR"), Some("SP"), Some("São Paulo"))
        );
        assert_eq!(request_geo(&headers(&[])), Geo::default());
        assert_eq!(
            request_geo(&headers(&[("x-vercel-ip-city", "Amsterdam")])),
            Geo::default()
        );
    }

    #[test]
    fn keeps_a_geo_value_that_does_not_decode() {
        assert_eq!(geo_value(Some("100%")), Some("100%".to_owned()));
        assert_eq!(geo_value(Some("%E0%A4%A")), Some("%E0%A4%A".to_owned()));
        assert_eq!(geo_value(Some("%C3%28")), Some("%C3%28".to_owned()));
        assert_eq!(geo_value(Some("%20%20")), None);
        assert_eq!(geo_value(Some(" a+b ")), Some("a+b".to_owned()));
        assert_eq!(geo_value(Some(&"é".repeat(150))), Some("é".repeat(100)));
        assert_eq!(geo_value(None), None);
    }
}
