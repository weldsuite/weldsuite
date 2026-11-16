//! MP3 frame helpers for cutting a stored recording into clips before
//! transcription (`@weldsuite/meet-domain/audio/mp3`).
//!
//! MP3 can be cut on frame boundaries without re-encoding: read a byte range
//! from the bucket, align both ends to a frame header, send it. Anything that
//! is not Layer III MPEG audio is reported as unsupported by [`is_mp3`].

/// `MP3_ALIGN_SLACK_BYTES`: how far past a nominal chunk end a reader fetches
/// to find the next frame.
pub(crate) const ALIGN_SLACK_BYTES: u64 = 16 * 1024;

// Bitrates in kbps by the 4-bit header field; 0 (free) and 15 are invalid.
const BITRATES_MPEG1_L3: [u32; 16] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const BITRATES_MPEG2_L3: [u32; 16] = [
    0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];

/// `Mp3FrameHeader`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FrameHeader {
    /// The whole frame, header included.
    pub(crate) frame_length: usize,
    pub(crate) sample_rate: u32,
    /// PCM samples per frame (1152 for MPEG 1, 576 otherwise).
    pub(crate) samples_per_frame: u32,
}

/// `parseFrameHeader(buf, i)`: the Layer III header at `i`, if there is one.
pub(crate) fn parse_frame_header(buf: &[u8], i: usize) -> Option<FrameHeader> {
    let header = buf.get(i..i.checked_add(4)?)?;
    let (b0, b1, b2) = (header[0], header[1], header[2]);
    if b0 != 0xff || (b1 & 0xe0) != 0xe0 {
        return None;
    }
    // 0 = MPEG 2.5, 1 = reserved, 2 = MPEG 2, 3 = MPEG 1; layer 1 = Layer III.
    let version = (b1 >> 3) & 0x3;
    let layer = (b1 >> 1) & 0x3;
    if version == 1 || layer != 1 {
        return None;
    }
    let bitrate_index = usize::from((b2 >> 4) & 0xf);
    let sample_rate_index = usize::from((b2 >> 2) & 0x3);
    if bitrate_index == 0 || bitrate_index == 15 || sample_rate_index == 3 {
        return None;
    }
    let mpeg1 = version == 3;
    let bitrate = if mpeg1 {
        BITRATES_MPEG1_L3[bitrate_index]
    } else {
        BITRATES_MPEG2_L3[bitrate_index]
    } * 1000;
    let sample_rate = match version {
        3 => [44_100, 48_000, 32_000][sample_rate_index],
        2 => [22_050, 24_000, 16_000][sample_rate_index],
        _ => [11_025, 12_000, 8_000][sample_rate_index],
    };
    let padding = u32::from((b2 >> 1) & 0x1);
    let frame_length = (if mpeg1 { 144 } else { 72 }) * bitrate / sample_rate + padding;
    if frame_length < 4 {
        return None;
    }
    Some(FrameHeader {
        frame_length: usize::try_from(frame_length).ok()?,
        sample_rate,
        samples_per_frame: if mpeg1 { 1152 } else { 576 },
    })
}

/// `isFrameStart`: a valid header whose successor is valid too (or the
/// buffer ends first).
fn is_frame_start(buf: &[u8], i: usize) -> Option<FrameHeader> {
    let header = parse_frame_header(buf, i)?;
    let next = i + header.frame_length;
    if next + 4 > buf.len() {
        return Some(header);
    }
    parse_frame_header(buf, next).map(|_| header)
}

/// `findFrameStart(buf, from)`: the first frame start at or after `from`.
pub(crate) fn find_frame_start(buf: &[u8], from: usize) -> Option<usize> {
    (from..buf.len().saturating_sub(3))
        .find(|&i| buf[i] == 0xff && is_frame_start(buf, i).is_some())
}

/// `id3v2Size(buf)`: the size of a leading `ID3v2` tag, 0 without one.
pub(crate) fn id3v2_size(buf: &[u8]) -> usize {
    if buf.len() < 10 || &buf[..3] != b"ID3" {
        return 0;
    }
    let size = (usize::from(buf[6] & 0x7f) << 21)
        | (usize::from(buf[7] & 0x7f) << 14)
        | (usize::from(buf[8] & 0x7f) << 7)
        | usize::from(buf[9] & 0x7f);
    10 + size
}

/// `isMp3(head)`: the first bytes of a file are Layer III MPEG audio.
pub(crate) fn is_mp3(head: &[u8]) -> bool {
    find_frame_start(head, id3v2_size(head)).is_some()
}

/// `mp3DurationSeconds(buf)`: the playing time of the whole frames in `buf`.
pub(crate) fn duration_seconds(buf: &[u8]) -> f64 {
    let mut at = find_frame_start(buf, id3v2_size(buf));
    let mut seconds = 0.0;
    while let Some(i) = at {
        if i + 4 > buf.len() {
            break;
        }
        match parse_frame_header(buf, i) {
            Some(header) => {
                seconds += f64::from(header.samples_per_frame) / f64::from(header.sample_rate);
                at = Some(i + header.frame_length);
            }
            None => at = find_frame_start(buf, i + 1),
        }
    }
    seconds
}

/// `Mp3ChunkWindow`: the bytes to fetch for one chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ChunkWindow {
    pub(crate) offset: u64,
    /// The nominal chunk plus the alignment slack, clipped to the file.
    pub(crate) length: u64,
    pub(crate) is_last: bool,
}

/// `mp3ChunkWindow(totalBytes, chunkBytes, index)`. A chunk boundary is the
/// first frame start at or after `index * chunk_bytes`, so adjacent chunks
/// share it exactly.
pub(crate) fn chunk_window(total_bytes: u64, chunk_bytes: u64, index: u64) -> ChunkWindow {
    let offset = index * chunk_bytes;
    let is_last = offset + chunk_bytes >= total_bytes;
    let slack = if is_last { 0 } else { ALIGN_SLACK_BYTES };
    ChunkWindow {
        offset,
        length: total_bytes.saturating_sub(offset).min(chunk_bytes + slack),
        is_last,
    }
}

/// `mp3ChunkCount(totalBytes, chunkBytes)`.
pub(crate) fn chunk_count(total_bytes: u64, chunk_bytes: u64) -> u64 {
    total_bytes.div_ceil(chunk_bytes).max(1)
}

/// `alignMp3Chunk(window, chunkBytes, { index, isLast })`: the whole frames
/// of a fetched window.
pub(crate) fn align_chunk(window: &[u8], chunk_bytes: u64, index: u64, is_last: bool) -> &[u8] {
    // The first chunk may open with an ID3v2 tag; later ones begin mid-stream.
    let from = if index == 0 { id3v2_size(window) } else { 0 };
    let Some(start) = find_frame_start(window, from) else {
        return &[];
    };
    let end = if is_last {
        window.len()
    } else {
        usize::try_from(chunk_bytes)
            .ok()
            .and_then(|nominal| find_frame_start(window, nominal))
            .unwrap_or(window.len())
    };
    window.get(start..end).unwrap_or_default()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// `frames` MPEG-1 Layer III frames at 128 kbps, 44.1 kHz: 417 bytes and
    /// 1152 samples each (the meet-api workflow test's fixture).
    pub(crate) fn mp3(frames: usize) -> Vec<u8> {
        let mut out = vec![0; frames * 417];
        for i in 0..frames {
            out[i * 417..i * 417 + 4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x00]);
        }
        out
    }

    #[test]
    fn frames_and_tags_parse() {
        let header = parse_frame_header(&mp3(2), 0).expect("a frame");
        assert_eq!(header.frame_length, 417);
        assert_eq!(header.sample_rate, 44_100);
        assert_eq!(header.samples_per_frame, 1152);
        assert!(is_mp3(&mp3(3)));
        assert!(!is_mp3(&[0; 2048]), "silence is not MP3");
        let mut tagged = b"ID3\x04\0\0\0\0\0\x05hello".to_vec();
        tagged.extend_from_slice(&mp3(2));
        assert_eq!(id3v2_size(&tagged), 15);
        assert!(is_mp3(&tagged));
        let seconds = duration_seconds(&mp3(100));
        assert!(
            (seconds - 100.0 * 1152.0 / 44_100.0).abs() < 1e-9,
            "{seconds}"
        );
    }

    #[test]
    fn chunks_tile_the_file_on_frame_boundaries() {
        let audio = mp3(2000);
        let total = audio.len() as u64;
        let chunk = 100_000;
        let count = chunk_count(total, chunk);
        assert_eq!(count, 9);
        let mut tiled = 0;
        for index in 0..count {
            let window = chunk_window(total, chunk, index);
            let start = usize::try_from(window.offset).expect("offset");
            let end = start + usize::try_from(window.length).expect("length");
            let clip = align_chunk(&audio[start..end], chunk, index, window.is_last);
            assert_eq!(clip.len() % 417, 0, "whole frames only");
            tiled += clip.len();
        }
        assert_eq!(tiled, audio.len(), "no gap, no overlap");
        assert_eq!(chunk_count(10, 100), 1);
        assert_eq!(chunk_count(0, 100), 1);
    }
}
