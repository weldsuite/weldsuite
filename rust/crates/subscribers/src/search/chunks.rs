//! `chunkText` and `hashContent` (`services/search/indexer.ts`): split a
//! document on paragraph boundaries into chunks of up to 1,200 characters
//! with a 150-character overlap, and key each by the SHA-256 of its text.
//! Lengths and slices are JavaScript's, in UTF-16 units.

use aws_lc_rs::digest;

use crate::js;

const CHUNK_CHARS: usize = 1200;
const CHUNK_OVERLAP_CHARS: usize = 150;
/// Guard against a record producing thousands of embed calls.
pub const MAX_CHUNKS_PER_ENTITY: usize = 40;

type Units = Vec<u16>;

fn is_space_unit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(js::is_js_space)
}

/// `text.trim()` on UTF-16 units.
fn trim_units(units: &[u16]) -> &[u16] {
    let start = units
        .iter()
        .position(|u| !is_space_unit(*u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !is_space_unit(*u))
        .map_or(start, |i| i + 1);
    &units[start..end.max(start)]
}

/// `overlapTail(chunk)`: the last 150 units, cut back to a word boundary.
fn overlap_tail(chunk: &[u16]) -> Units {
    if chunk.len() <= CHUNK_OVERLAP_CHARS {
        return chunk.to_vec();
    }
    let tail = &chunk[chunk.len() - CHUNK_OVERLAP_CHARS..];
    match tail.iter().position(|u| is_space_unit(*u)) {
        None => tail.to_vec(),
        Some(boundary) => tail[boundary + 1..].to_vec(),
    }
}

struct ChunkState {
    chunks: Vec<Units>,
    current: Units,
}

impl ChunkState {
    /// `flushChunk`.
    fn flush(&mut self) {
        let trimmed = trim_units(&self.current);
        if !trimmed.is_empty() {
            self.chunks.push(trimmed.to_vec());
        }
        self.current.clear();
    }
}

/// `hardSplitParagraph`: true once the cap is reached.
fn hard_split(paragraph: &[u16], chunks: &mut Vec<Units>) -> bool {
    let mut i = 0;
    while i < paragraph.len() {
        let end = (i + CHUNK_CHARS).min(paragraph.len());
        chunks.push(paragraph[i..end].to_vec());
        if chunks.len() >= MAX_CHUNKS_PER_ENTITY {
            return true;
        }
        i += CHUNK_CHARS - CHUNK_OVERLAP_CHARS;
    }
    false
}

/// `packParagraph`: true once the cap is reached.
fn pack_paragraph(state: &mut ChunkState, paragraph: &[u16]) -> bool {
    if paragraph.len() > CHUNK_CHARS {
        state.flush();
        return hard_split(paragraph, &mut state.chunks);
    }
    if state.current.len() + paragraph.len() + 1 > CHUNK_CHARS {
        let carried = overlap_tail(&state.current);
        state.flush();
        if state.chunks.len() >= MAX_CHUNKS_PER_ENTITY {
            return true;
        }
        if !carried.is_empty() && carried.len() + paragraph.len() < CHUNK_CHARS {
            state.current = carried;
        }
    }
    if !state.current.is_empty() {
        state.current.push(u16::from(b'\n'));
    }
    state.current.extend_from_slice(paragraph);
    false
}

/// `chunkText(text)`.
pub fn chunk_text(text: &str) -> Vec<String> {
    let units = js::units(text);
    let clean = trim_units(&units);
    if clean.is_empty() {
        return Vec::new();
    }
    if clean.len() <= CHUNK_CHARS {
        return vec![js::from_units(clean)];
    }
    // `clean.split(/\n{2,}|\n/)`: on every run of newlines.
    let newline = u16::from(b'\n');
    let paragraphs: Vec<&[u16]> = clean
        .split(|u| *u == newline)
        .map(trim_units)
        .filter(|p| !p.is_empty())
        .collect();
    let mut state = ChunkState {
        chunks: Vec::new(),
        current: Vec::new(),
    };
    let mut capped = false;
    for paragraph in paragraphs {
        if pack_paragraph(&mut state, paragraph) {
            capped = true;
            break;
        }
    }
    if !capped {
        state.flush();
    }
    state
        .chunks
        .iter()
        .take(MAX_CHUNKS_PER_ENTITY)
        .map(|chunk| js::from_units(chunk))
        .collect()
}

/// `hashContent(content)`: SHA-256 of the UTF-8 text, hex.
pub fn hash_content(content: &str) -> String {
    hex::encode(digest::digest(&digest::SHA256, content.as_bytes()).as_ref())
}

/// `compose(parts)`: the non-empty trimmed parts on their own lines, runs of
/// spaces and tabs collapsed.
pub fn compose(parts: &[Option<&str>]) -> String {
    let joined = parts
        .iter()
        .map(|part| js::trim(part.unwrap_or_default()))
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let mut out = String::with_capacity(joined.len());
    let mut in_run = false;
    for c in joined.chars() {
        if c == ' ' || c == '\t' {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    js::trim(&out).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_one_chunk() {
        assert_eq!(chunk_text("  hello  "), vec!["hello"]);
        assert_eq!(chunk_text(" \n "), Vec::<String>::new());
    }

    #[test]
    fn long_paragraphs_overlap() {
        let paragraph = "word ".repeat(300);
        let chunks = chunk_text(&format!("{paragraph}\n\n{paragraph}"));
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|c| js::length(c) <= CHUNK_CHARS));
    }

    #[test]
    fn hashes_are_sha256_hex() {
        assert_eq!(
            hash_content("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn compose_collapses_spaces() {
        assert_eq!(
            compose(&[Some(" a  b "), None, Some(""), Some("c\t\td")]),
            "a b\nc d"
        );
    }
}
