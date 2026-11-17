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
fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| value.as_bytes().iter().copied().map(char::from).collect())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

/// The visitor's address: the first (leftmost) hop of `X-Forwarded-For`,
/// which is the visitor's own when a first-party proxy forwards the beacon.
/// Empty when there is none. A client can name any address there; it is
/// used for the cookieless hash and the IP filter only, never stored.
pub(crate) fn client_ip(headers: &HeaderMap) -> String {
    header(headers, "x-forwarded-for")
        .and_then(|hops| {
            hops.split(',')
                .map(js_trim)
                .find(|hop| !hop.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_default()
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
