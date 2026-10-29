//! Identifiers and secure random strings (`id.ts` and `random.ts` in
//! worker-kit).
//!
//! Ids look like `cus_m1x2k3l4a8b9c0d1`: the prefix, `_`, the creation time in
//! milliseconds in base 36, then eight random base-36 characters. Ids sort
//! roughly by creation time, and the column is `varchar(30)`.

use std::time::{SystemTime, UNIX_EPOCH};

pub const BASE36_UPPER: &str = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
pub const BASE36_LOWER: &str = "0123456789abcdefghijklmnopqrstuvwxyz";
pub const ALPHANUMERIC: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/// A new id, `<prefix>_<time><random>`, or `<time><random>` for an empty
/// prefix. Same format as `generateId()`.
///
/// The TypeScript version takes each random character as `byte % 36`, which
/// favours the first four characters slightly. This one draws without bias;
/// the format is the same.
pub fn generate_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    let timestamp = to_base36(millis);
    let random = random_string(8, BASE36_LOWER);
    if prefix.is_empty() {
        format!("{timestamp}{random}")
    } else {
        format!("{prefix}_{timestamp}{random}")
    }
}

/// `length` characters drawn uniformly from `alphabet` with the operating
/// system's secure random source. Bytes that would bias the draw are discarded
/// (rejection sampling), as in `randomString()`.
///
/// # Panics
///
/// When `alphabet` has fewer than 2 or more than 256 characters, or when the
/// operating system has no random source.
pub fn random_string(length: usize, alphabet: &str) -> String {
    let chars: Vec<char> = alphabet.chars().collect();
    assert!(
        (2..=256).contains(&chars.len()),
        "alphabet must contain between 2 and 256 characters"
    );
    // Largest multiple of the alphabet size that fits in a byte; bytes at or
    // above it are discarded so the remainder is uniform.
    let limit = 256 - (256 % chars.len());
    let mut out = String::with_capacity(length);
    let mut produced = 0;
    let mut buffer = vec![0u8; length.max(1)];
    while produced < length {
        let wanted = length - produced;
        getrandom::fill(&mut buffer[..wanted]).expect("the operating system has a random source");
        for &byte in &buffer[..wanted] {
            let byte = usize::from(byte);
            if byte < limit {
                out.push(chars[byte % chars.len()]);
                produced += 1;
            }
        }
    }
    out
}

/// Lowercase base 36, as JavaScript's `n.toString(36)`.
fn to_base36(mut value: u128) -> String {
    if value == 0 {
        return "0".to_owned();
    }
    let digits = BASE36_LOWER.as_bytes();
    let mut out = Vec::new();
    while value > 0 {
        // The remainder is below 36, so the cast cannot truncate.
        #[allow(clippy::cast_possible_truncation)]
        out.push(digits[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base36_matches_javascript_to_string_36() {
        // (1_700_000_000_000).toString(36) === "loyw3v28"
        assert_eq!(to_base36(1_700_000_000_000), "loyw3v28");
        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(36), "10");
    }

    #[test]
    fn ids_have_the_prefix_time_and_eight_random_characters() {
        let id = generate_id("cus");
        let (prefix, rest) = id.split_once('_').expect("prefix separator");
        assert_eq!(prefix, "cus");
        // Base-36 milliseconds are 8 characters until the year 2059.
        assert_eq!(rest.len(), 16, "{id}");
        assert!(rest.chars().all(|c| BASE36_LOWER.contains(c)), "{id}");
        assert!(id.len() <= 30, "fits varchar(30): {id}");
    }

    #[test]
    fn an_empty_prefix_leaves_out_the_separator() {
        let id = generate_id("");
        assert!(!id.contains('_'));
        assert_eq!(id.len(), 16);
    }

    #[test]
    fn ids_sort_by_creation_time() {
        let first = generate_id("x");
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = generate_id("x");
        assert!(first[..10] < second[..10], "{first} < {second}");
    }

    #[test]
    fn random_strings_use_only_the_alphabet() {
        let value = random_string(64, ALPHANUMERIC);
        assert_eq!(value.chars().count(), 64);
        assert!(value.chars().all(|c| ALPHANUMERIC.contains(c)));
        assert_eq!(random_string(0, BASE36_UPPER), "");
    }

    #[test]
    #[should_panic(expected = "between 2 and 256")]
    fn random_strings_reject_a_one_character_alphabet() {
        random_string(4, "a");
    }
}
