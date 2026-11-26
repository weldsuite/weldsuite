//! The YAML the OpenAPI files are written in, read into JSON values.
//!
//! A strict subset, so the workspace needs no YAML crate: block mappings and
//! sequences, flow sequences (`[a, b]`, across lines too), `{}`, plain,
//! single- and double-quoted scalars, literal block scalars (`|`, `|-`, `|+`)
//! and comments. Anything else (anchors, aliases, tags, folded scalars, flow
//! mappings, multi-line plain scalars, tabs) is an error naming the line, never
//! a silent misread: extend this reader before writing such YAML.
//!
//! Plain scalars resolve as YAML 1.2's core schema does: `null`/`~`, `true`,
//! `false`, integers and decimals; everything else is a string.

use serde_json::{Map, Number, Value};

/// `text` as a JSON value, or what in it this reader doesn't take.
pub(crate) fn parse(text: &str) -> Result<Value, String> {
    let mut parser = Parser {
        lines: text.lines().map(str::to_owned).collect(),
        pos: 0,
    };
    if parser.next_indent()?.is_some() && parser.content() == "---" {
        parser.pos += 1;
    }
    let value = match parser.next_indent()? {
        Some(indent) => parser.block(indent)?,
        None => Value::Null,
    };
    if parser.next_indent()?.is_some() {
        return Err(parser.error("unexpected content after the document"));
    }
    Ok(value)
}

struct Parser {
    lines: Vec<String>,
    /// The line being read (0-based).
    pos: usize,
}

impl Parser {
    fn error(&self, message: &str) -> String {
        format!("line {}: {message}", self.pos + 1)
    }

    /// Skips blank and comment lines; the indent of the next line with
    /// content, which stays unread.
    fn next_indent(&mut self) -> Result<Option<usize>, String> {
        while let Some(line) = self.lines.get(self.pos) {
            let content = line.trim_start_matches(' ');
            if content.trim().is_empty() {
                self.pos += 1;
                continue;
            }
            if content.starts_with('\t') {
                return Err(self.error("a tab in the indentation"));
            }
            if content.starts_with('#') {
                self.pos += 1;
                continue;
            }
            return Ok(Some(line.len() - content.len()));
        }
        Ok(None)
    }

    /// The current line without its indentation.
    fn content(&self) -> String {
        self.lines[self.pos].trim_start_matches(' ').to_owned()
    }

    /// The node starting on the current line, which sits at `indent`.
    fn block(&mut self, indent: usize) -> Result<Value, String> {
        let content = self.content();
        if is_sequence_entry(&content) {
            self.sequence(indent)
        } else if content.starts_with('[') {
            self.pos += 1;
            self.flow(&content)
        } else if split_key(&content)?.is_some() {
            self.mapping(indent)
        } else {
            Err(self.error(
                "expected `key: value`, `- item` or `[…]` (a scalar on its own line is not read)",
            ))
        }
    }

    fn mapping(&mut self, indent: usize) -> Result<Value, String> {
        let mut map = Map::new();
        while let Some(at) = self.next_indent()? {
            if at < indent {
                break;
            }
            if at > indent {
                return Err(self.error("unexpected indentation"));
            }
            let content = self.content();
            if is_sequence_entry(&content) {
                return Err(self.error("a `- item` where a `key:` was expected"));
            }
            let Some((key, rest)) = split_key(&content)? else {
                return Err(self.error("expected `key: value`"));
            };
            let line = self.pos;
            self.pos += 1;
            let value = self.value(indent, &rest)?;
            if map.insert(key.clone(), value).is_some() {
                return Err(format!("line {}: `{key}` appears twice", line + 1));
            }
        }
        Ok(Value::Object(map))
    }

    fn sequence(&mut self, indent: usize) -> Result<Value, String> {
        let mut items = Vec::new();
        while let Some(at) = self.next_indent()? {
            if at < indent {
                break;
            }
            if at > indent {
                return Err(self.error("unexpected indentation"));
            }
            let content = self.content();
            if !is_sequence_entry(&content) {
                // The next key of the mapping this sequence is a value of.
                break;
            }
            let after = &content[1..];
            let item = after.trim_start();
            if item.is_empty() || item.starts_with('#') {
                self.pos += 1;
                items.push(self.nested(indent)?);
                continue;
            }
            let item_indent = indent + 1 + (after.len() - item.len());
            if is_sequence_entry(item) || split_key(item)?.is_some() {
                // `- key: value` opens a mapping (`- - x` a sequence) whose
                // first line is this one, written where its text starts.
                self.lines[self.pos] = format!("{}{item}", " ".repeat(item_indent));
                items.push(self.block(item_indent)?);
            } else {
                self.pos += 1;
                items.push(self.inline(indent, item)?);
            }
        }
        Ok(Value::Array(items))
    }

    /// The value after `key:` (the key's line already read).
    fn value(&mut self, indent: usize, rest: &str) -> Result<Value, String> {
        let rest = rest.trim();
        if rest.is_empty() || rest.starts_with('#') {
            match self.next_indent()? {
                // YAML lets a sequence sit at its key's own indentation.
                Some(at) if at == indent && is_sequence_entry(&self.content()) => self.sequence(at),
                _ => self.nested(indent),
            }
        } else {
            self.inline(indent, rest)
        }
    }

    /// A block more indented than `indent`, or null when there is none.
    fn nested(&mut self, indent: usize) -> Result<Value, String> {
        match self.next_indent()? {
            Some(at) if at > indent => self.block(at),
            _ => Ok(Value::Null),
        }
    }

    /// A value written on its key's or dash's line (that line already read).
    fn inline(&mut self, indent: usize, text: &str) -> Result<Value, String> {
        let line = self.pos - 1;
        let fail = |message: &str| format!("line {}: {message}", line + 1);
        match text.chars().next() {
            Some('[') => self.flow(text),
            Some('{') => {
                let inner = text[1..].trim_start();
                match inner.strip_prefix('}') {
                    Some(after) if is_blank_or_comment(after) => Ok(Value::Object(Map::new())),
                    _ => Err(fail("flow mappings other than `{}` are not read")),
                }
            }
            Some('|') => self.literal(indent, text).map(Value::String),
            Some('>') => Err(fail("folded scalars (`>`) are not read; use `|`")),
            Some('&' | '*' | '!' | '%' | '@' | '`') => Err(fail(&format!(
                "`{}` (anchors, aliases, tags, reserved) is not read",
                &text[..1]
            ))),
            _ => {
                let (value, after) = scalar(text, false).map_err(|error| fail(&error))?;
                if !is_blank_or_comment(after) {
                    return Err(fail(&format!(
                        "unexpected `{}` after the value",
                        after.trim()
                    )));
                }
                if let Some(at) = self.next_indent()?
                    && at > indent
                    && self.pos == line + 1
                    && !is_sequence_entry(&self.content())
                    && split_key(&self.content())?.is_none()
                {
                    return Err(self.error("multi-line plain scalars are not read; use `|`"));
                }
                Ok(value)
            }
        }
    }

    /// A flow sequence starting with `text`, read on as many lines as its
    /// brackets take (the line holding `text` already read).
    fn flow(&mut self, text: &str) -> Result<Value, String> {
        let first = self.pos - 1;
        let mut source = text.to_owned();
        loop {
            match flow_sequence(&source) {
                Ok(Some((value, after))) => {
                    if !is_blank_or_comment(after) {
                        return Err(self.error(&format!("unexpected `{}` after `]`", after.trim())));
                    }
                    return Ok(value);
                }
                Ok(None) => {
                    let Some(next) = self.lines.get(self.pos) else {
                        return Err(format!("line {}: `[` is never closed", first + 1));
                    };
                    source.push('\n');
                    source.push_str(next);
                    self.pos += 1;
                }
                Err(error) => return Err(format!("line {}: {error}", first + 1)),
            }
        }
    }

    /// A literal block scalar under a key or dash at `indent`; `header` is
    /// `|`, `|-` or `|+` (its line already read).
    fn literal(&mut self, indent: usize, header: &str) -> Result<String, String> {
        let header = header.split('#').next().unwrap_or_default().trim();
        let chomp = match header {
            "|" => Chomp::Clip,
            "|-" => Chomp::Strip,
            "|+" => Chomp::Keep,
            other => {
                return Err(format!(
                    "line {}: block scalar header `{other}` is not read",
                    self.pos
                ));
            }
        };
        let mut body: Vec<String> = Vec::new();
        let mut content_indent = None;
        while let Some(line) = self.lines.get(self.pos) {
            let spaces = line.len() - line.trim_start_matches(' ').len();
            if line.trim().is_empty() {
                body.push(String::new());
                self.pos += 1;
                continue;
            }
            if spaces <= indent {
                break;
            }
            let start = *content_indent.get_or_insert(spaces);
            if spaces < start {
                return Err(format!(
                    "line {}: less indented than the block scalar's first line",
                    self.pos + 1
                ));
            }
            body.push(line[start..].to_owned());
            self.pos += 1;
        }
        // Blank lines after the block belong to whatever comes next.
        let trailing = body.iter().rev().take_while(|line| line.is_empty()).count();
        let kept = body.len() - trailing;
        if trailing > 0 {
            self.pos -= trailing;
        }
        let text = body[..kept].join("\n");
        Ok(match chomp {
            Chomp::Strip => text,
            Chomp::Clip if kept == 0 => String::new(),
            Chomp::Clip => text + "\n",
            Chomp::Keep => text + &"\n".repeat(1 + trailing),
        })
    }
}

#[derive(Debug, Clone, Copy)]
enum Chomp {
    Clip,
    Strip,
    Keep,
}

fn is_sequence_entry(content: &str) -> bool {
    content == "-" || content.starts_with("- ")
}

fn is_blank_or_comment(text: &str) -> bool {
    let text = text.trim();
    text.is_empty() || text.starts_with('#')
}

/// `key: rest` as the key and the text after the colon, or `None` when the
/// line is no mapping entry.
fn split_key(content: &str) -> Result<Option<(String, String)>, String> {
    if content.starts_with('\'') || content.starts_with('"') {
        let (key, after) = scalar(content, false)?;
        let Some(rest) = after.strip_prefix(':') else {
            return Ok(None);
        };
        if !(rest.is_empty() || rest.starts_with(' ')) {
            return Ok(None);
        }
        let key = match key {
            Value::String(key) => key,
            other => other.to_string(),
        };
        return Ok(Some((key, rest.to_owned())));
    }
    if content.starts_with(['[', '{', '#', '|', '>']) || is_sequence_entry(content) {
        return Ok(None);
    }
    let colon = content
        .find(": ")
        .or_else(|| content.ends_with(':').then(|| content.len() - 1));
    Ok(colon.and_then(|at| {
        let key = content[..at].trim_end();
        // A comment before the colon means the colon is in the comment.
        (!key.is_empty() && !key.contains(" #"))
            .then(|| (key.to_owned(), content[at + 1..].to_owned()))
    }))
}

/// The scalar at the start of `text` and what follows it. In a flow
/// sequence (`flow`), `,`, `]` and a line break end a plain scalar.
fn scalar(text: &str, flow: bool) -> Result<(Value, &str), String> {
    if let Some(body) = text.strip_prefix('\'') {
        let mut out = String::new();
        let mut chars = body.char_indices().peekable();
        while let Some((at, c)) = chars.next() {
            if c == '\'' {
                if chars.peek().is_some_and(|(_, next)| *next == '\'') {
                    chars.next();
                    out.push('\'');
                } else {
                    return Ok((Value::String(out), &body[at + 1..]));
                }
            } else if c == '\n' {
                return Err("multi-line quoted scalars are not read".to_owned());
            } else {
                out.push(c);
            }
        }
        return Err("a `'` is never closed".to_owned());
    }
    if let Some(body) = text.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = body.char_indices();
        while let Some((at, c)) = chars.next() {
            match c {
                '"' => return Ok((Value::String(out), &body[at + 1..])),
                '\\' => match chars.next().map(|(_, escaped)| escaped) {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some('/') => out.push('/'),
                    Some(other) => return Err(format!("the escape `\\{other}` is not read")),
                    None => break,
                },
                '\n' => return Err("multi-line quoted scalars are not read".to_owned()),
                c => out.push(c),
            }
        }
        return Err("a `\"` is never closed".to_owned());
    }
    let mut end = text.len();
    for (at, c) in text.char_indices() {
        let comment = c == '#' && text[..at].ends_with([' ', '\t']);
        if comment || (flow && matches!(c, ',' | ']' | '\n')) {
            end = at;
            break;
        }
    }
    let plain = text[..end].trim();
    if plain.contains(": ") || plain.ends_with(':') {
        return Err(format!("`{plain}`: a `: ` inside a plain scalar; quote it"));
    }
    if flow && plain.starts_with(['{', '[']) {
        return Err("nested flow collections are not read".to_owned());
    }
    Ok((resolve(plain), &text[end..]))
}

/// A plain scalar as YAML 1.2's core schema reads it.
fn resolve(plain: &str) -> Value {
    match plain {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        _ => {}
    }
    let digits = plain.strip_prefix(['-', '+']).unwrap_or(plain);
    if !digits.is_empty()
        && digits.chars().all(|c| c.is_ascii_digit())
        && let Ok(int) = plain.parse::<i64>()
    {
        return Value::Number(int.into());
    }
    let decimal = digits.chars().any(|c| c.is_ascii_digit())
        && digits
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '-' | '+'));
    if decimal && let Some(number) = plain.parse::<f64>().ok().and_then(Number::from_f64) {
        return Value::Number(number);
    }
    Value::String(plain.to_owned())
}

/// A flow sequence at the start of `text`: its value and what follows, or
/// `None` while `text` ends before the `]`.
fn flow_sequence(text: &str) -> Result<Option<(Value, &str)>, String> {
    let mut rest = text
        .strip_prefix('[')
        .ok_or_else(|| "expected `[`".to_owned())?;
    let mut items = Vec::new();
    loop {
        rest = skip_space_and_comments(rest);
        if rest.is_empty() {
            return Ok(None);
        }
        if let Some(after) = rest.strip_prefix(']') {
            return Ok(Some((Value::Array(items), after)));
        }
        if rest.starts_with(',') {
            return Err("an empty item in `[…]`".to_owned());
        }
        let (item, after) = scalar(rest, true)?;
        items.push(item);
        rest = skip_space_and_comments(after);
        if rest.is_empty() {
            return Ok(None);
        }
        if let Some(after) = rest.strip_prefix(',') {
            rest = after;
        } else if !rest.starts_with(']') {
            return Err(format!(
                "expected `,` or `]` in `[…]`, found `{}`",
                &rest[..1]
            ));
        }
    }
}

fn skip_space_and_comments(mut text: &str) -> &str {
    loop {
        text = text.trim_start();
        match text.strip_prefix('#') {
            Some(comment) => text = comment.find('\n').map_or("", |end| &comment[end..]),
            None => return text,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::parse;

    fn ok(text: &str) -> serde_json::Value {
        parse(text).unwrap_or_else(|error| panic!("{error}\n{text}"))
    }

    #[test]
    fn reads_mappings_sequences_and_scalars() {
        let text = "\
# a comment
openapi: 3.0.3
info:
  title: WeldPass API (native apps)
  version: 1.0.0
paths:
  /api/weldpass/vaults/{vaultId}:
    get:
      parameters:
        - $ref: '#/components/parameters/VaultId'
        - name: type
          in: query   # trailing comment
          required: false
      responses:
        '200':
          description: The login's username, or \"•••• 4242\" for a card.
security:
  - bearer: []
list:
- a
- 'b'
- \"c\\\"d\"
empty: {}
nothing:
numbers: [1, -2, 1.5, '3']
flags: [true, false, null, ~]
";
        assert_eq!(
            ok(text),
            json!({
                "openapi": "3.0.3",
                "info": { "title": "WeldPass API (native apps)", "version": "1.0.0" },
                "paths": {
                    "/api/weldpass/vaults/{vaultId}": {
                        "get": {
                            "parameters": [
                                { "$ref": "#/components/parameters/VaultId" },
                                { "name": "type", "in": "query", "required": false },
                            ],
                            "responses": {
                                "200": {
                                    "description": "The login's username, or \"•••• 4242\" for a card.",
                                },
                            },
                        },
                    },
                },
                "security": [{ "bearer": [] }],
                "list": ["a", "b", "c\"d"],
                "empty": {},
                "nothing": null,
                "numbers": [1, -2, 1.5, "3"],
                "flags": [true, false, null, null],
            })
        );
    }

    #[test]
    fn reads_flow_sequences_across_lines() {
        let text = "\
required:
  [id, vaultId, type,
   title, 'a, b'] # done
pattern: '^\\d{6,8}$'
quoted: 'it''s'
";
        assert_eq!(
            ok(text),
            json!({
                "required": ["id", "vaultId", "type", "title", "a, b"],
                "pattern": "^\\d{6,8}$",
                "quoted": "it's",
            })
        );
    }

    #[test]
    fn reads_literal_block_scalars() {
        let text = "\
info:
  description: |
    First line.

    # Not a comment: `x: y`
      indented
  after: 1
strip: |-
  no newline
keep: |+
  kept

last: 2
";
        assert_eq!(
            ok(text),
            json!({
                "info": {
                    "description": "First line.\n\n# Not a comment: `x: y`\n  indented\n",
                    "after": 1,
                },
                "strip": "no newline",
                "keep": "kept\n\n",
                "last": 2,
            })
        );
    }

    #[test]
    fn refuses_what_it_does_not_read() {
        for (text, needle) in [
            ("a: &anchor 1\n", "anchors"),
            ("a: *alias\n", "anchors"),
            ("a: !!str 1\n", "anchors"),
            ("a: >\n  folded\n", "folded"),
            ("a: {b: 1}\n", "flow mappings"),
            ("a: b: c\n", "quote it"),
            ("a: one\n  two\n", "multi-line plain"),
            ("a: 1\na: 2\n", "twice"),
            ("a:\n\t- 1\n", "tab"),
            ("a: [1, 2\n", "never closed"),
            ("a: [[1]]\n", "nested flow"),
            ("a:\n  b: 1\n   c: 2\n", "indentation"),
            ("a:\n  - 1\n  b: 2\n", "unexpected indentation"),
            ("a: 'open\n", "never closed"),
        ] {
            let error = parse(text).expect_err(text);
            assert!(error.contains(needle), "{text:?}: {error}");
            assert!(error.starts_with("line "), "{text:?}: {error}");
        }
    }

    #[test]
    fn a_sequence_of_mappings_keeps_each_entrys_keys() {
        let text = "\
allOf:
  - $ref: '#/components/schemas/Item'
  - type: object
    required: [issues]
    properties:
      issues:
        type: array
";
        assert_eq!(
            ok(text),
            json!({
                "allOf": [
                    { "$ref": "#/components/schemas/Item" },
                    {
                        "type": "object",
                        "required": ["issues"],
                        "properties": { "issues": { "type": "array" } },
                    },
                ],
            })
        );
    }
}
