//! Export of the responses table as CSV or XLSX (`services/export.ts`),
//! from the same column model and filters as the list. CSV follows RFC 4180
//! (CRLF, quoted fields) with a byte order mark so Excel opens it right;
//! XLSX is a minimal `SpreadsheetML` package with the worker's parts, in its
//! order and with its XML. File answers carry a link into the app, never a
//! public URL. At most `FORM_LIMITS.maxExportRows` rows.

use std::collections::HashMap;
use std::fmt::Write as _;

use serde_json::Value;

use crate::common::{Ctx, FormsResult, all, iso, text};
use crate::engine::js::{js_round, number_text};
use crate::response_model::{
    Bind, Column, MAX_EXPORT_ROWS, ResponseFilter, VersionInfo, answer_cell, bind_all,
    build_columns, is_abandoned, js_string, latest_fields, load_versions, response_conditions,
    response_order,
};

/// One cell: `string | number | null`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Cell {
    Null,
    Num(f64),
    Text(String),
}

impl Cell {
    fn of(value: &Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Number(n) => n.as_f64().map_or(Self::Null, Self::Num),
            Value::String(text) => Self::Text(text.clone()),
            other => Self::Text(js_string(other)),
        }
    }
}

/// The file the route answers with.
pub(crate) struct ExportFile {
    pub(crate) body: Vec<u8>,
    pub(crate) content_type: &'static str,
    pub(crate) filename: String,
}

const CSV_TYPE: &str = "text/csv; charset=utf-8";
const XLSX_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/// `appLink(env, formId, responseId)`: the response in the platform.
fn app_link(ctx: &Ctx, form_id: &str, response_id: &str) -> String {
    let base = ctx
        .env()
        .non_empty("PLATFORM_URL")
        .unwrap_or_else(|| "https://app.weldsuite.org".to_owned());
    let base = base.strip_suffix('/').unwrap_or(&base);
    format!("{base}/weldforms/{form_id}/results?tab=responses&response={response_id}")
}

/// `metaValue(column, row, version, now)`.
fn meta_value(column: &Column, row: &Value, version: Option<&VersionInfo>, now_ms: i64) -> Cell {
    let metadata = &row["metadata"];
    match column.key.as_str() {
        "number" => Cell::of(&row["number"]),
        "submittedAt" => Cell::of(&row["submittedAt"]),
        "startedAt" => Cell::of(&row["startedAt"]),
        "email" => Cell::of(&row["respondentEmail"]),
        "score" => Cell::of(&row["score"]),
        "duration" => row["durationMs"]
            .as_f64()
            .map_or(Cell::Null, |ms| Cell::Num(js_round(ms / 1000.0))),
        "status" => Cell::Text(if is_abandoned(row, now_ms) {
            "abandoned".to_owned()
        } else {
            text(row, "status").to_owned()
        }),
        #[allow(clippy::cast_precision_loss)]
        "version" => version.map_or(Cell::Null, |v| Cell::Num(v.number as f64)),
        "source" | "device" | "country" | "referrer" => Cell::of(&metadata[column.key.as_str()]),
        key => Cell::of(&row["hidden"][key]),
    }
}

/// `exportTable(ctx, formId, query)`: the header and the rows.
pub(crate) async fn export_table(
    ctx: &Ctx,
    form_id: &str,
    filter: &ResponseFilter,
    sort: Option<&str>,
) -> FormsResult<(Vec<String>, Vec<Vec<Cell>>)> {
    let versions = load_versions(&ctx.db, form_id).await?;
    let by_version: HashMap<&str, &VersionInfo> =
        versions.iter().map(|v| (v.id.as_str(), v)).collect();
    let fallback = latest_fields(&versions);
    let columns = build_columns(&versions);
    let mut w = response_conditions(form_id, filter, &fallback)?;
    let limit = w.param(Bind::Int(MAX_EXPORT_ROWS));
    let sql = format!(
        "select to_jsonb(r) from form_responses r where {} order by {} limit {limit}",
        w.sql(),
        response_order(Some(sort.unwrap_or("oldest")))
    );
    let rows = all(
        &ctx.db,
        bind_all(sqlx::query_scalar(sqlx::AssertSqlSafe(sql)), &w.binds),
    )
    .await?;
    let now = ctx.now_ms();
    let table = rows
        .iter()
        .map(|row| {
            let version = by_version.get(text(row, "versionId")).copied();
            columns
                .iter()
                .map(|column| {
                    let Some(block_id) = &column.block_id else {
                        return meta_value(column, row, version, now);
                    };
                    let field = version
                        .and_then(|v| v.field(block_id))
                        .or_else(|| fallback.get(block_id));
                    let Some(raw) = row["answers"].get(block_id) else {
                        return Cell::Null;
                    };
                    if let Some(field) = field.filter(|f| f.kind.is_file()) {
                        let names = answer_cell(Some(field), Some(raw), None);
                        return if names.is_empty() {
                            Cell::Null
                        } else {
                            Cell::Text(format!(
                                "{names} ({})",
                                app_link(ctx, form_id, text(row, "id"))
                            ))
                        };
                    }
                    let cell = answer_cell(field, Some(raw), column.part.as_deref());
                    if cell.is_empty() {
                        Cell::Null
                    } else {
                        Cell::Text(cell)
                    }
                })
                .collect()
        })
        .collect();
    Ok((columns.into_iter().map(|c| c.label).collect(), table))
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/// `/^-\d+(\.\d+)?$/`.
fn plain_negative(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('-') else {
        return false;
    };
    let (whole, fraction) = match rest.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (rest, None),
    };
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

/// `defuse(text)`: a leading `=`, `+`, `-` or `@` reads as a formula in a
/// spreadsheet; a plain negative number stays one.
pub(crate) fn defuse(text: &str) -> String {
    let risky = text.starts_with(['=', '+', '@', '\t', '\r'])
        || (text.starts_with('-') && !plain_negative(text));
    if risky {
        format!("'{text}")
    } else {
        text.to_owned()
    }
}

fn csv_field(cell: &Cell) -> String {
    let text = match cell {
        Cell::Null => return String::new(),
        Cell::Num(n) => number_text(*n),
        Cell::Text(text) => defuse(text),
    };
    if text.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

/// `toCsv(header, rows)`.
pub(crate) fn to_csv(header: &[String], rows: &[Vec<Cell>]) -> String {
    let header: Vec<Cell> = header.iter().map(|h| Cell::Text(h.clone())).collect();
    let lines: Vec<String> = std::iter::once(&header)
        .chain(rows.iter())
        .map(|row| row.iter().map(csv_field).collect::<Vec<_>>().join(","))
        .collect();
    format!("\u{feff}{}\r\n", lines.join("\r\n"))
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/// `columnName(index)`: `A`, `B`, …, `Z`, `AA`, ….
pub(crate) fn column_name(index: usize) -> String {
    let mut n = index + 1;
    let mut name = Vec::new();
    while n > 0 {
        let rem = (n - 1) % 26;
        name.push(char::from(b'A' + u8::try_from(rem).unwrap_or_default()));
        n = (n - 1) / 26;
    }
    name.iter().rev().collect()
}

/// `esc(text)`.
fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
    out
}

/// `xmlText(text)`: what XML 1.0 cannot hold dropped, then escaped.
fn xml_text(text: &str) -> String {
    let kept: String = text
        .chars()
        .filter(|&c| {
            let code = u32::from(c);
            !((code < 0x20 && code != 0x09 && code != 0x0a && code != 0x0d)
                || code == 0xfffe
                || code == 0xffff)
        })
        .collect();
    esc(&kept)
}

fn sheet_cell(cell: &Cell, reference: &str, header: bool) -> String {
    let style = if header { " s=\"1\"" } else { "" };
    match cell {
        Cell::Null => String::new(),
        Cell::Text(text) if text.is_empty() => String::new(),
        Cell::Num(n) if n.is_finite() => {
            format!("<c r=\"{reference}\"{style}><v>{}</v></c>", number_text(*n))
        }
        Cell::Num(n) => format!(
            "<c r=\"{reference}\"{style} t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
            xml_text(&number_text(*n))
        ),
        Cell::Text(text) => format!(
            "<c r=\"{reference}\"{style} t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
            xml_text(text)
        ),
    }
}

const XML_HEADER: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

/// `toXlsx(header, rows, now)`.
pub(crate) fn to_xlsx(header: &[String], rows: &[Vec<Cell>], now_ms: i64) -> Vec<u8> {
    let header: Vec<Cell> = header.iter().map(|h| Cell::Text(h.clone())).collect();
    let mut sheet_rows = String::new();
    for (r, cells) in std::iter::once(&header).chain(rows.iter()).enumerate() {
        let _ = write!(sheet_rows, "<row r=\"{}\">", r + 1);
        for (c, cell) in cells.iter().enumerate() {
            let reference = format!("{}{}", column_name(c), r + 1);
            sheet_rows.push_str(&sheet_cell(cell, &reference, r == 0));
        }
        sheet_rows.push_str("</row>");
    }
    let files: Vec<(&str, String)> = vec![
        (
            "[Content_Types].xml",
            format!(
                "{XML_HEADER}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/></Types>"
            ),
        ),
        (
            "_rels/.rels",
            format!(
                "{XML_HEADER}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>"
            ),
        ),
        (
            "xl/workbook.xml",
            format!(
                "{XML_HEADER}<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"Responses\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"
            ),
        ),
        (
            "xl/_rels/workbook.xml.rels",
            format!(
                "{XML_HEADER}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>"
            ),
        ),
        (
            "xl/styles.xml",
            format!(
                "{XML_HEADER}<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/></cellXfs></styleSheet>"
            ),
        ),
        (
            "xl/worksheets/sheet1.xml",
            format!(
                "{XML_HEADER}<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><sheetData>{sheet_rows}</sheetData></worksheet>"
            ),
        ),
    ];
    let files: Vec<(&str, Vec<u8>)> = files
        .into_iter()
        .map(|(name, data)| (name, data.into_bytes()))
        .collect();
    crate::zip::write_zip(&files, now_ms)
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/// `safeFilename(title)`.
pub(crate) fn safe_filename(title: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    let trimmed: String = out.trim_matches('-').chars().take(60).collect();
    if trimmed.is_empty() {
        "form".to_owned()
    } else {
        trimmed
    }
}

/// `exportResponses(ctx, form, query, now)`.
pub(crate) async fn export_responses(
    ctx: &Ctx,
    form: &Value,
    format: &str,
    filter: &ResponseFilter,
    sort: Option<&str>,
) -> FormsResult<ExportFile> {
    let (header, rows) = export_table(ctx, text(form, "id"), filter, sort).await?;
    let now = ctx.now_ms();
    let base = format!(
        "{}-responses-{}",
        safe_filename(text(form, "title")),
        &iso(now)[..10]
    );
    if format == "csv" {
        return Ok(ExportFile {
            body: to_csv(&header, &rows).into_bytes(),
            content_type: CSV_TYPE,
            filename: format!("{base}.csv"),
        });
    }
    Ok(ExportFile {
        body: to_xlsx(&header, &rows, now),
        content_type: XLSX_TYPE,
        filename: format!("{base}.xlsx"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_quotes_and_defuses() {
        assert_eq!(defuse("=SUM(A1)"), "'=SUM(A1)");
        assert_eq!(defuse("-3"), "-3");
        assert_eq!(defuse("-3.5"), "-3.5");
        assert_eq!(defuse("-x"), "'-x");
        assert_eq!(defuse("-3."), "'-3.");
        assert_eq!(defuse("@me"), "'@me");
        let csv = to_csv(
            &["A".to_owned(), "B".to_owned()],
            &[vec![
                Cell::Text("Ann, \"the\" Great".to_owned()),
                Cell::Num(5.0),
            ]],
        );
        assert_eq!(csv, "\u{feff}A,B\r\n\"Ann, \"\"the\"\" Great\",5\r\n");
    }

    #[test]
    fn column_names_and_file_names() {
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(25), "Z");
        assert_eq!(column_name(26), "AA");
        assert_eq!(column_name(27 * 26), "AAA");
        assert_eq!(safe_filename("Survey"), "Survey");
        assert_eq!(
            safe_filename("  Klant tevreden?! 2026 "),
            "Klant-tevreden-2026"
        );
        assert_eq!(safe_filename("???"), "form");
        assert_eq!(
            sheet_cell(&Cell::Text("Number".to_owned()), "A1", true),
            "<c r=\"A1\" s=\"1\" t=\"inlineStr\"><is><t xml:space=\"preserve\">Number</t></is></c>"
        );
        assert_eq!(xml_text("a\u{1}<b>"), "a&lt;b&gt;");
    }
}
