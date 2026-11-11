//! Hold audio for callers waiting in the WeldDesk phone queue
//! (`lib/desk-phone-audio.ts`): a ringback tone generated here, so no asset
//! or licence is involved. Telnyx fetches it from
//! `GET /public/webhooks/telnyx/ringback.wav` and loops it.
//!
//! 8 kHz mono 16-bit PCM, a 425 Hz tone for 1 s then 4 s of silence (the
//! European ringback cadence). Deterministic: the worker's bytes, on every
//! call (no sample is closer than a thousandth to a rounding boundary, so the
//! platform's `sin` cannot move one).

use std::sync::LazyLock;

use axum::response::{IntoResponse, Response};
use http::header::{CACHE_CONTROL, CONTENT_TYPE};
use weldsuite_kit::RequestEnv;

use crate::desk_phone::call_api_url;

pub(crate) const RINGBACK_PATH: &str = "/public/webhooks/telnyx/ringback.wav";

const SAMPLE_RATE: u32 = 8000;
const TONE_HZ: f64 = 425.0;
const TONE_SECONDS: u32 = 1;
const CYCLE_SECONDS: u32 = 5;
const AMPLITUDE: f64 = 0.25 * 32767.0;
/// Samples faded in and out at each end of the tone, so it does not click.
const FADE_SAMPLES: f64 = 80.0;
/// The RIFF header before the samples.
const HEADER_BYTES: usize = 44;

static RINGBACK: LazyLock<Vec<u8>> = LazyLock::new(ringback_wav);

/// `ringbackWav()`: a 44-byte RIFF header and 5 s of 16-bit little-endian
/// samples.
fn ringback_wav() -> Vec<u8> {
    let tone_samples = SAMPLE_RATE * TONE_SECONDS;
    let data_bytes = SAMPLE_RATE * CYCLE_SECONDS * 2;
    let length = HEADER_BYTES + usize::try_from(data_bytes).unwrap_or_default();
    let mut bytes = Vec::with_capacity(length);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes()); // fmt chunk size
    bytes.extend_from_slice(&1_u16.to_le_bytes()); // PCM
    bytes.extend_from_slice(&1_u16.to_le_bytes()); // mono
    bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    bytes.extend_from_slice(&2_u16.to_le_bytes()); // block align
    bytes.extend_from_slice(&16_u16.to_le_bytes()); // bits per sample
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_bytes.to_le_bytes());
    for index in 0..tone_samples {
        let at = f64::from(index);
        let fade = 1.0_f64
            .min(at / FADE_SAMPLES)
            .min((f64::from(tone_samples) - 1.0 - at) / FADE_SAMPLES);
        let value = ((2.0 * std::f64::consts::PI * TONE_HZ * at) / f64::from(SAMPLE_RATE)).sin()
            * AMPLITUDE
            * fade;
        // `Math.round`; the amplitude keeps it well inside 16 bits.
        #[allow(clippy::cast_possible_truncation)]
        let sample = (value + 0.5).floor() as i16;
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    // The rest of the cycle is silence.
    bytes.resize(length, 0);
    bytes
}

/// `ringbackUrl(env)`: where Telnyx fetches the ringback from, call-api's
/// own host (not app-api's forwarder).
pub(crate) fn ringback_url(env: Option<&RequestEnv>) -> String {
    call_api_url(env, RINGBACK_PATH)
}

/// `GET /public/webhooks/telnyx/ringback.wav`.
pub(crate) async fn ringback() -> Response {
    (
        [
            (CONTENT_TYPE, "audio/wav"),
            (CACHE_CONTROL, "public, max-age=86400, immutable"),
        ],
        RINGBACK.as_slice(),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use sha2::{Digest, Sha256};

    use super::*;

    #[test]
    fn the_ringback_is_the_workers_bytes() {
        let bytes = ringback_wav();
        assert_eq!(bytes.len(), 80_044);
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[36..40], b"data");
        // The first sample of the fade-in, the tone, then silence.
        assert_eq!(&bytes[44..46], &[0, 0]);
        assert!(bytes[HEADER_BYTES + 16_000..].iter().all(|byte| *byte == 0));
        // The digest of `ringbackWav()` in `lib/desk-phone-audio.ts`.
        let digest = Sha256::digest(&bytes)
            .iter()
            .fold(String::new(), |mut hex, byte| {
                let _ = write!(hex, "{byte:02x}");
                hex
            });
        assert_eq!(
            digest,
            "993f964b7226e5e802682ef2c8d2476433654c5e19470787a114bb8c520585c4"
        );
    }
}
