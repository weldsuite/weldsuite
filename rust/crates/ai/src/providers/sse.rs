//! Server-sent events, as the model APIs stream them: `event:` and `data:`
//! lines, an empty line ending each event. Chunks may split a line (or a
//! UTF-8 character) anywhere, so bytes wait in the buffer until their line
//! is complete.

/// One event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SseEvent {
    pub(crate) event: Option<String>,
    pub(crate) data: String,
}

#[derive(Debug, Default)]
pub(crate) struct SseParser {
    pending: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    /// The events `chunk` completes.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.pending.drain(..=end).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.line(&String::from_utf8_lossy(&line), &mut events);
        }
        events
    }

    /// The last event, when the body ended without its empty line.
    pub(crate) fn finish(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        if !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            let line = String::from_utf8_lossy(&rest)
                .trim_end_matches('\r')
                .to_owned();
            self.line(&line, &mut events);
        }
        self.dispatch(&mut events);
        events
    }

    fn line(&mut self, line: &str, events: &mut Vec<SseEvent>) {
        if line.is_empty() {
            self.dispatch(events);
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = line
            .split_once(':')
            .map_or((line, ""), |(f, v)| (f, v.strip_prefix(' ').unwrap_or(v)));
        match field {
            "event" => self.event = Some(value.to_owned()),
            "data" => self.data.push(value.to_owned()),
            _ => {}
        }
    }

    fn dispatch(&mut self, events: &mut Vec<SseEvent>) {
        if self.data.is_empty() {
            self.event = None;
            return;
        }
        events.push(SseEvent {
            event: self.event.take(),
            data: std::mem::take(&mut self.data).join("\n"),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_survive_any_split() {
        let body = "event: message_start\ndata: {\"a\":1}\n\n: keep-alive\n\ndata: héllo\r\n\r\ndata: [DONE]\n\n";
        let whole = SseParser::default().push(body.as_bytes());
        assert_eq!(whole.len(), 3);
        assert_eq!(whole[0].event.as_deref(), Some("message_start"));
        assert_eq!(whole[0].data, "{\"a\":1}");
        assert_eq!(whole[1].data, "héllo");
        assert_eq!(whole[2].data, "[DONE]");
        // Byte by byte, splitting the é too.
        let mut parser = SseParser::default();
        let mut split = Vec::new();
        for byte in body.as_bytes() {
            split.extend(parser.push(&[*byte]));
        }
        split.extend(parser.finish());
        assert_eq!(split, whole);
    }

    #[test]
    fn an_unterminated_last_event_is_kept() {
        let mut parser = SseParser::default();
        assert_eq!(parser.push(b"data: one\ndata: two").len(), 0);
        let events = parser.finish();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "one\ntwo");
    }
}
