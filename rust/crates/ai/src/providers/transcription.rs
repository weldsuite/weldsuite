//! Speech to text on the OpenAI-compatible `POST /v1/audio/transcriptions`
//! (Mistral's Voxtral): a multipart upload of the audio, with segment
//! timestamps.

use serde_json::Value;

use crate::policy::Target;
use crate::types::Audio;

/// A `multipart/form-data` body and its content type.
pub(crate) fn transcription_body(
    target: &Target,
    audio: &Audio,
    boundary: &str,
) -> (Vec<u8>, String) {
    let mut body = Vec::new();
    let mut field = |name: &str, value: &str| {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\ncontent-disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    };
    field("model", target.native_model());
    if let Some(language) = audio.language.as_deref().filter(|l| !l.is_empty()) {
        field("language", language);
    }
    field("timestamp_granularities[]", "segment");
    let file_name: String = audio
        .name
        .chars()
        .map(|c| if c == '"' || c.is_control() { '_' } else { c })
        .collect();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\ncontent-disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\ncontent-type: {}\r\n\r\n",
            audio.mime
        )
        .as_bytes(),
    );
    body.extend_from_slice(&audio.data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (body, format!("multipart/form-data; boundary={boundary}"))
}

/// The answer: text, segments `(start, end, text)` and the audio's length in
/// seconds (what is billed).
pub(crate) struct TranscriptionAnswer {
    pub(crate) text: String,
    pub(crate) segments: Vec<(f64, f64, String)>,
    pub(crate) duration_seconds: Option<f64>,
}

pub(crate) fn parse_transcription(body: &Value) -> TranscriptionAnswer {
    let segments: Vec<(f64, f64, String)> = body
        .get("segments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| {
            Some((
                s.get("start")?.as_f64()?,
                s.get("end")?.as_f64()?,
                s.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_owned(),
            ))
        })
        .collect();
    let duration_seconds = body
        .pointer("/usage/prompt_audio_seconds")
        .and_then(Value::as_f64)
        .or_else(|| body.get("duration").and_then(Value::as_f64))
        .or_else(|| segments.last().map(|(_, end, _)| *end));
    TranscriptionAnswer {
        text: body
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        segments,
        duration_seconds,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::catalog::{KeySource, ProviderId, Region};

    #[test]
    fn the_upload_is_multipart_with_the_model_and_file() {
        let target = Target {
            provider: ProviderId::Mistral,
            model: "mistral/voxtral-mini-transcribe-3-0".to_owned(),
            region: Region::Eu,
            key_source: KeySource::Weldsuite,
        };
        let audio = Audio {
            mime: "audio/mpeg".to_owned(),
            name: "call \"1\".mp3".to_owned(),
            data: b"ID3".to_vec(),
            language: Some("nl".to_owned()),
        };
        let (body, content_type) = transcription_body(&target, &audio, "XyZ");
        assert_eq!(content_type, "multipart/form-data; boundary=XyZ");
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("name=\"model\"\r\n\r\nvoxtral-mini-transcribe-3-0\r\n"));
        assert!(text.contains("name=\"language\"\r\n\r\nnl\r\n"));
        assert!(text.contains(
            "filename=\"call _1_.mp3\"\r\ncontent-type: audio/mpeg\r\n\r\nID3\r\n--XyZ--"
        ));
    }

    #[test]
    fn answers_parse_segments_and_duration() {
        let answer = parse_transcription(&json!({
            "text": "Hallo daar",
            "segments": [{ "start": 0.0, "end": 1.5, "text": " Hallo" }, { "start": 1.5, "end": 2.75, "text": " daar" }],
            "usage": { "prompt_audio_seconds": 3.0 },
        }));
        assert_eq!(answer.text, "Hallo daar");
        assert_eq!(answer.segments[1], (1.5, 2.75, "daar".to_owned()));
        assert_eq!(answer.duration_seconds, Some(3.0));
        let without_usage = parse_transcription(
            &json!({ "text": "x", "segments": [{ "start": 0.0, "end": 4.0, "text": "x" }] }),
        );
        assert_eq!(without_usage.duration_seconds, Some(4.0));
    }
}
