//! `lib/ip-filter.ts`: project IP filters (`settings.ipFilters`), exact
//! IPv4 or IPv6 addresses or CIDR ranges. The address is compared and
//! dropped, never stored.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Address {
    v4: bool,
    value: u128,
}

/// `/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/`, each octet at most 255.
fn parse_ipv4(text: &str) -> Option<u128> {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut value: u128 = 0;
    for part in parts {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let octet: u128 = part.parse().ok()?;
        if octet > 255 {
            return None;
        }
        value = (value << 8) | octet;
    }
    Some(value)
}

/// The embedded IPv4 tail (`::ffff:1.2.3.4`) right after a `:`:
/// `/(?<=:)(\d{1,3}(?:\.\d{1,3}){3})$/`.
fn ipv4_tail(text: &str) -> Option<(usize, &str)> {
    let colon = text.rfind(':')?;
    let tail = &text[colon + 1..];
    let parts: Vec<&str> = tail.split('.').collect();
    let shaped = parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()));
    shaped.then_some((colon + 1, tail))
}

fn parse_ipv6(text: &str) -> Option<u128> {
    let mut rest = text.to_owned();
    if let Some((index, tail)) = ipv4_tail(text) {
        let v4 = parse_ipv4(tail)?;
        rest = format!("{}{:x}:{:x}", &text[..index], v4 >> 16, v4 & 0xffff);
    }
    let halves: Vec<&str> = rest.split("::").collect();
    if halves.len() > 2 {
        return None;
    }
    let head: Vec<&str> = if halves[0].is_empty() {
        Vec::new()
    } else {
        halves[0].split(':').collect()
    };
    let end: Vec<&str> = match halves.get(1) {
        Some(half) if !half.is_empty() => half.split(':').collect(),
        _ => Vec::new(),
    };
    let missing = 8_i64 - i64::try_from(head.len() + end.len()).ok()?;
    if halves.len() == 1 {
        if missing != 0 {
            return None;
        }
    } else if missing < 1 {
        return None;
    }
    let fill = if halves.len() == 2 {
        usize::try_from(missing).ok()?
    } else {
        0
    };
    let mut value: u128 = 0;
    for group in head
        .iter()
        .copied()
        .chain(std::iter::repeat_n("0", fill))
        .chain(end.iter().copied())
    {
        if group.is_empty() || group.len() > 4 || !group.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        value = (value << 16) | u128::from(u16::from_str_radix(group, 16).ok()?);
    }
    Some(value)
}

fn parse_address(raw: &str) -> Option<Address> {
    let trimmed = weldsuite_kit::validation::js_trim(raw);
    let unbracketed = trimmed.strip_prefix('[').unwrap_or(trimmed);
    let unbracketed = unbracketed.strip_suffix(']').unwrap_or(unbracketed);
    let text = unbracketed.split('%').next().unwrap_or_default();
    if !text.contains(':') {
        return parse_ipv4(text).map(|value| Address { v4: true, value });
    }
    let value = parse_ipv6(text)?;
    if value >> 32 == 0xffff {
        return Some(Address {
            v4: true,
            value: value & 0xffff_ffff,
        });
    }
    Some(Address { v4: false, value })
}

/// `matchesIpFilter(ip, filters)`: whether `ip` equals or falls inside any
/// entry. Unparseable entries and addresses never match.
pub(crate) fn matches_ip_filter(ip: &str, filters: &[String]) -> bool {
    if ip.is_empty() || filters.is_empty() {
        return false;
    }
    let Some(address) = parse_address(ip) else {
        return false;
    };
    let bits: u32 = if address.v4 { 32 } else { 128 };
    filters.iter().any(|entry| {
        let parts: Vec<&str> = entry.split('/').collect();
        if parts.len() > 2 || parts[0].is_empty() {
            return false;
        }
        let Some(network) = parse_address(parts[0]) else {
            return false;
        };
        if network.v4 != address.v4 {
            return false;
        }
        let Some(prefix) = parts.get(1) else {
            return network.value == address.value;
        };
        if prefix.is_empty() || prefix.len() > 3 || !prefix.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        let Ok(length) = prefix.parse::<u32>() else {
            return false;
        };
        if length > bits {
            return false;
        }
        let shift = bits - length;
        let high = |value: u128| value.checked_shr(shift).unwrap_or(0);
        high(address.value) == high(network.value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filters(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|e| (*e).to_owned()).collect()
    }

    #[test]
    fn matches_addresses_and_ranges() {
        assert!(matches_ip_filter("203.0.113.7", &filters(&["203.0.113.0/24"])));
        assert!(!matches_ip_filter("203.0.114.7", &filters(&["203.0.113.0/24"])));
        assert!(matches_ip_filter("2001:db8::1", &filters(&["2001:db8::/32"])));
        assert!(matches_ip_filter("::ffff:203.0.113.7", &filters(&["203.0.113.7"])));
        assert!(matches_ip_filter("[::1]", &filters(&["::1"])));
        assert!(matches_ip_filter("10.0.0.1", &filters(&["0.0.0.0/0"])));
        assert!(!matches_ip_filter("10.0.0.1", &filters(&["10.0.0.1/33", "garbage", "10.0.0.1/1/2"])));
        assert!(!matches_ip_filter("", &filters(&["10.0.0.1"])));
    }
}
