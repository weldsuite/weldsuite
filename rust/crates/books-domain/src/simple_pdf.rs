//! A plain PDF of an invoice or a quote for the customer: what the public
//! document page downloads and the e-mail attaches (Rust only, edition feature
//! `books-invoice-email`).
//!
//! The invoice route's "PDF" is the printable HTML layout (there is no
//! HTML-to-PDF engine on the server), so this draws its own page, in the
//! built-in Helvetica (WinAnsi, no font to embed), with the same content a
//! customer needs: the seller, the buyer, the dates, the lines, the totals
//! and how to pay. It does not follow the entity's designed template; a
//! designed layout is still the HTML of `GET /api/invoices/:id/pdf`.

use std::fmt::Write as _;

const WIDTH: f64 = 595.0;
const HEIGHT: f64 = 842.0;
const MARGIN: f64 = 50.0;

/// A party's name and address lines.
#[derive(Debug, Clone, Default)]
pub struct PdfParty {
    pub name: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PdfLine {
    pub description: String,
    pub quantity: String,
    pub unit_price: String,
    pub tax_rate: String,
    pub total: String,
}

/// The words on the page, in the document's language.
#[derive(Debug, Clone)]
pub struct PdfLabels {
    pub description: String,
    pub quantity: String,
    pub unit_price: String,
    pub tax: String,
    pub amount: String,
    pub subtotal: String,
    pub total: String,
    pub paid: String,
    pub balance_due: String,
    pub notes: String,
    pub payment: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone)]
pub struct DocumentPdf {
    /// "Invoice", "Quote", "Credit note".
    pub title: String,
    pub number: String,
    pub seller: PdfParty,
    pub buyer: PdfParty,
    /// Label and value pairs under the parties: dates, reference.
    pub meta: Vec<(String, String)>,
    pub labels: PdfLabels,
    pub lines: Vec<PdfLine>,
    /// Money already formatted: the subtotal, one row per tax rate, the
    /// total and, for an invoice, what is paid and left.
    pub subtotal: String,
    pub taxes: Vec<(String, String)>,
    pub total: String,
    pub paid: Option<String>,
    pub balance_due: Option<String>,
    pub notes: Option<String>,
    pub payment_lines: Vec<String>,
    /// A QR code with the payment details (the SEPA transfer of an invoice).
    pub qr: Option<PdfQr>,
    /// The pay-online link under the payment details.
    pub pay_link: Option<PdfLink>,
}

/// A QR code and what to say under it.
#[derive(Debug, Clone)]
pub struct PdfQr {
    /// The text the code holds ([`crate::epc::payload`]).
    pub payload: String,
    /// "Scan to pay with your banking app".
    pub caption: String,
}

/// A clickable link with its lead-in.
#[derive(Debug, Clone)]
pub struct PdfLink {
    /// "Pay online:".
    pub label: String,
    pub url: String,
}

/// Helvetica's width of `ch` in thousandths of the font size (close, not
/// exact: it only aligns numbers and wraps text).
fn glyph(ch: char) -> f64 {
    match ch {
        ' ' | '.' | ',' | ':' | ';' | '!' | 'i' | 'j' | 'l' | '\'' | '|' => 278.0,
        'f' | 't' | 'I' | '(' | ')' | '[' | ']' | '-' | '/' | 'r' => 333.0,
        'm' | 'w' => 833.0,
        'M' | 'W' | '%' | '@' => 889.0,
        'A'..='Z' | '€' => 667.0,
        _ => 556.0, // digits, lowercase letters and the rest
    }
}

fn width(text: &str, size: f64) -> f64 {
    text.chars().map(glyph).sum::<f64>() * size / 1000.0
}

/// The WinAnsi byte for `ch`; what the font cannot show is `?`.
fn winansi(ch: char) -> u8 {
    match ch {
        '\u{20}'..='\u{7e}' | '\u{a0}'..='\u{ff}' => u8::try_from(u32::from(ch)).unwrap_or(b'?'),
        '€' => 0x80,
        '\u{2018}' | '\u{2019}' => b'\'',
        '\u{201c}' | '\u{201d}' => b'"',
        '\u{2013}' | '\u{2014}' => b'-',
        _ => b'?',
    }
}

fn literal(text: &str) -> String {
    let mut out = String::from("(");
    for ch in text.chars() {
        let byte = winansi(ch);
        match byte {
            b'(' | b')' | b'\\' => {
                out.push('\\');
                out.push(char::from(byte));
            }
            0x20..=0x7e => out.push(char::from(byte)),
            other => {
                let _ = write!(out, "\\{other:03o}");
            }
        }
    }
    out.push(')');
    out
}

fn wrap(text: &str, max: f64, size: f64) -> Vec<String> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut line = String::new();
        for word in paragraph.split_whitespace() {
            let candidate = if line.is_empty() {
                word.to_owned()
            } else {
                format!("{line} {word}")
            };
            if width(&candidate, size) > max && !line.is_empty() {
                lines.push(std::mem::take(&mut line));
                word.clone_into(&mut line);
            } else {
                line = candidate;
            }
        }
        lines.push(line);
    }
    lines
}

/// A clickable rectangle (`x1 y1 x2 y2`) and where it leads.
type Link = ([f64; 4], String);

#[derive(Default)]
#[allow(
    clippy::struct_field_names,
    reason = "the pages' content streams and their links go side by side"
)]
struct Pages {
    pages: Vec<String>,
    /// The link annotations of each page, as `pages`.
    links: Vec<Vec<Link>>,
    y: f64,
}

impl Pages {
    fn new() -> Self {
        Self {
            pages: vec![String::new()],
            links: vec![Vec::new()],
            y: HEIGHT - MARGIN,
        }
    }

    fn page(&mut self) -> &mut String {
        self.pages.last_mut().expect("there is always a page")
    }

    fn break_if(&mut self, needed: f64) {
        if self.y - needed < MARGIN {
            self.pages.push(String::new());
            self.links.push(Vec::new());
            self.y = HEIGHT - MARGIN;
        }
    }

    /// `text` in link blue with an annotation to `url`.
    fn link(&mut self, x: f64, y: f64, size: f64, text: &str, url: &str) {
        let end = x + width(text, size);
        let _ = writeln!(
            self.page(),
            "0.05 0.3 0.75 rg BT /F1 {size:.1} Tf {x:.2} {y:.2} Td {} Tj ET 0 g",
            literal(text)
        );
        if let Some(links) = self.links.last_mut() {
            links.push(([x, y - 2.0, end, y + size], url.to_owned()));
        }
    }

    /// The dark modules of `matrix` as filled rectangles in a square `side`
    /// points wide, its top left corner at `x`, `top`.
    #[allow(
        clippy::cast_precision_loss,
        reason = "a QR code has under 200 modules"
    )]
    fn qr(&mut self, x: f64, top: f64, side: f64, matrix: &[Vec<bool>]) {
        let module = side / matrix.len().max(1) as f64;
        let mut ops = String::from("0 g\n");
        for (row, modules) in matrix.iter().enumerate() {
            let mut col = 0;
            while col < modules.len() {
                if !modules[col] {
                    col += 1;
                    continue;
                }
                let start = col;
                while col < modules.len() && modules[col] {
                    col += 1;
                }
                let _ = writeln!(
                    ops,
                    "{:.3} {:.3} {:.3} {module:.3} re",
                    x + start as f64 * module,
                    top - (row + 1) as f64 * module,
                    (col - start) as f64 * module
                );
            }
        }
        ops.push_str("f\n");
        self.page().push_str(&ops);
    }

    fn text(&mut self, x: f64, y: f64, size: f64, bold: bool, text: &str) {
        let font = if bold { "F2" } else { "F1" };
        let _ = writeln!(
            self.page(),
            "BT /{font} {size:.1} Tf {x:.2} {y:.2} Td {} Tj ET",
            literal(text)
        );
    }

    fn right(&mut self, right_edge: f64, y: f64, size: f64, bold: bool, text: &str) {
        let x = right_edge - width(text, size) * if bold { 1.05 } else { 1.0 };
        self.text(x, y, size, bold, text);
    }

    fn rule(&mut self, y: f64) {
        let _ = writeln!(
            self.page(),
            "0.8 G 0.5 w {MARGIN:.2} {y:.2} m {:.2} {y:.2} l S 0 G",
            WIDTH - MARGIN
        );
    }
}

/// The finished PDF.
#[allow(clippy::too_many_lines, reason = "one page layout, top to bottom")]
pub fn render(doc: &DocumentPdf) -> Vec<u8> {
    let mut p = Pages::new();
    let right = WIDTH - MARGIN;

    p.text(MARGIN, p.y, 22.0, true, &doc.title);
    p.right(right, p.y, 12.0, false, &doc.number);
    p.y -= 36.0;

    // Seller on the left, buyer on the right.
    let top = p.y;
    let mut left_y = top;
    p.text(MARGIN, left_y, 8.0, true, &doc.labels.from.to_uppercase());
    left_y -= 13.0;
    p.text(MARGIN, left_y, 10.5, true, &doc.seller.name);
    left_y -= 13.0;
    for line in &doc.seller.lines {
        p.text(MARGIN, left_y, 9.5, false, line);
        left_y -= 12.0;
    }
    let buyer_x = WIDTH / 2.0 + 20.0;
    let mut right_y = top;
    p.text(buyer_x, right_y, 8.0, true, &doc.labels.to.to_uppercase());
    right_y -= 13.0;
    p.text(buyer_x, right_y, 10.5, true, &doc.buyer.name);
    right_y -= 13.0;
    for line in &doc.buyer.lines {
        p.text(buyer_x, right_y, 9.5, false, line);
        right_y -= 12.0;
    }
    p.y = left_y.min(right_y) - 10.0;

    for (label, value) in &doc.meta {
        p.break_if(14.0);
        p.text(MARGIN, p.y, 9.5, true, label);
        p.text(MARGIN + 110.0, p.y, 9.5, false, value);
        p.y -= 13.0;
    }
    p.y -= 12.0;

    // Lines: description | qty | unit price | tax | amount.
    let (qty_r, price_r, tax_r) = (330.0, 410.0, 455.0);
    let header = |p: &mut Pages| {
        let y = p.y;
        p.text(MARGIN, y, 9.0, true, &doc.labels.description);
        p.right(qty_r, y, 9.0, true, &doc.labels.quantity);
        p.right(price_r, y, 9.0, true, &doc.labels.unit_price);
        p.right(tax_r, y, 9.0, true, &doc.labels.tax);
        p.right(right, y, 9.0, true, &doc.labels.amount);
        p.rule(y - 5.0);
        p.y -= 18.0;
    };
    header(&mut p);
    for line in &doc.lines {
        let description = wrap(&line.description, qty_r - MARGIN - 50.0, 9.5);
        #[allow(clippy::cast_precision_loss)]
        let height = description.len() as f64 * 12.0;
        if p.y - height < MARGIN + 20.0 {
            p.break_if(f64::MAX / 2.0);
            header(&mut p);
        }
        let y = p.y;
        for (i, part) in description.iter().enumerate() {
            #[allow(clippy::cast_precision_loss)]
            p.text(MARGIN, y - i as f64 * 12.0, 9.5, false, part);
        }
        p.right(qty_r, y, 9.5, false, &line.quantity);
        p.right(price_r, y, 9.5, false, &line.unit_price);
        p.right(tax_r, y, 9.5, false, &format!("{}%", line.tax_rate));
        p.right(right, y, 9.5, false, &line.total);
        p.y -= height + 5.0;
    }
    p.y -= 6.0;

    // Totals.
    let label_x = 330.0;
    p.break_if(20.0 + 14.0 * f64::from(u32::try_from(doc.taxes.len() + 4).unwrap_or(u32::MAX)));
    let row = |p: &mut Pages, label: &str, value: &str, bold: bool| {
        let y = p.y;
        p.text(label_x, y, if bold { 11.0 } else { 9.5 }, bold, label);
        p.right(right, y, if bold { 11.0 } else { 9.5 }, bold, value);
        p.y -= 14.0;
    };
    row(&mut p, &doc.labels.subtotal, &doc.subtotal, false);
    for (rate, amount) in &doc.taxes {
        row(
            &mut p,
            &format!("{} {rate}%", doc.labels.tax),
            amount,
            false,
        );
    }
    p.rule(p.y + 9.0);
    row(&mut p, &doc.labels.total, &doc.total, true);
    if let Some(paid) = &doc.paid {
        row(&mut p, &doc.labels.paid, paid, false);
    }
    if let Some(balance) = &doc.balance_due {
        row(&mut p, &doc.labels.balance_due, balance, true);
    }
    p.y -= 14.0;

    let block = |p: &mut Pages, title: &str, body: &[String]| {
        if body.is_empty() {
            return;
        }
        p.break_if(30.0);
        let y = p.y;
        p.text(MARGIN, y, 9.5, true, title);
        p.y -= 14.0;
        for text in body {
            for part in wrap(text, WIDTH - 2.0 * MARGIN, 9.5) {
                p.break_if(14.0);
                let y = p.y;
                p.text(MARGIN, y, 9.5, false, &part);
                p.y -= 12.0;
            }
        }
        p.y -= 8.0;
    };
    block(&mut p, &doc.labels.payment, &doc.payment_lines);
    if let Some(qr) = &doc.qr {
        let matrix = crate::epc::matrix(&qr.payload);
        if !matrix.is_empty() {
            // A quiet zone of four modules stays blank around the code; the
            // page is white.
            let side = QR_SIDE;
            p.break_if(side + 16.0);
            let top = p.y;
            p.qr(MARGIN, top, side, &matrix);
            for (i, part) in wrap(&qr.caption, WIDTH - 2.0 * MARGIN - side - 20.0, 9.5)
                .iter()
                .enumerate()
            {
                #[allow(clippy::cast_precision_loss)]
                p.text(
                    MARGIN + side + 14.0,
                    top - 14.0 - i as f64 * 12.0,
                    9.5,
                    false,
                    part,
                );
            }
            p.y = top - side - 14.0;
        }
    }
    if let Some(link) = &doc.pay_link {
        let max = WIDTH - 2.0 * MARGIN;
        let parts = url_lines(&link.url, max, 9.0);
        #[allow(clippy::cast_precision_loss)]
        p.break_if(16.0 + parts.len() as f64 * 12.0);
        let y = p.y;
        p.text(MARGIN, y, 9.5, true, &link.label);
        p.y -= 13.0;
        for part in &parts {
            let y = p.y;
            p.link(MARGIN, y, 9.0, part, &link.url);
            p.y -= 12.0;
        }
        p.y -= 8.0;
    }
    if let Some(notes) = &doc.notes {
        block(&mut p, &doc.labels.notes, std::slice::from_ref(notes));
    }
    assemble(&p.pages, &p.links)
}

/// The side of the QR code, including nothing of its quiet zone.
const QR_SIDE: f64 = 92.0;

/// `url` cut into lines that fit `max` points: a link has no spaces to wrap at.
fn url_lines(url: &str, max: f64, size: f64) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for ch in url.chars() {
        if !line.is_empty() && width(&format!("{line}{ch}"), size) > max {
            lines.push(std::mem::take(&mut line));
        }
        line.push(ch);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// One open item on a statement.
#[derive(Debug, Clone)]
pub struct StatementRow {
    /// "Invoice INV-001", "Credit note CN-002".
    pub document: String,
    pub date: String,
    pub due: String,
    pub amount: String,
    pub balance: String,
}

/// The words on a statement, in the contact's language.
#[derive(Debug, Clone)]
pub struct StatementLabels {
    pub document: String,
    pub date: String,
    pub due_date: String,
    pub amount: String,
    pub balance: String,
    pub total: String,
    pub from: String,
    pub to: String,
    /// Shown when nothing is open.
    pub nothing_open: String,
}

/// A contact's open items: what the seller sends a customer as a statement.
#[derive(Debug, Clone)]
pub struct StatementPdf {
    /// "Statement".
    pub title: String,
    /// The date it is as of, as the reader reads it.
    pub as_of: String,
    pub seller: PdfParty,
    pub buyer: PdfParty,
    pub labels: StatementLabels,
    pub rows: Vec<StatementRow>,
    /// The balance per currency, money formatted: `(currency, total)`.
    pub totals: Vec<(String, String)>,
}

/// The statement's PDF, on the same page set-up as [`render`].
#[allow(clippy::too_many_lines, reason = "one page layout, top to bottom")]
pub fn render_statement(doc: &StatementPdf) -> Vec<u8> {
    let mut p = Pages::new();
    let right = WIDTH - MARGIN;
    p.text(MARGIN, p.y, 22.0, true, &doc.title);
    p.right(right, p.y, 12.0, false, &doc.as_of);
    p.y -= 36.0;

    let top = p.y;
    let mut left_y = top;
    p.text(MARGIN, left_y, 8.0, true, &doc.labels.from.to_uppercase());
    left_y -= 13.0;
    p.text(MARGIN, left_y, 10.5, true, &doc.seller.name);
    left_y -= 13.0;
    for line in &doc.seller.lines {
        p.text(MARGIN, left_y, 9.5, false, line);
        left_y -= 12.0;
    }
    let buyer_x = WIDTH / 2.0 + 20.0;
    let mut right_y = top;
    p.text(buyer_x, right_y, 8.0, true, &doc.labels.to.to_uppercase());
    right_y -= 13.0;
    p.text(buyer_x, right_y, 10.5, true, &doc.buyer.name);
    right_y -= 13.0;
    for line in &doc.buyer.lines {
        p.text(buyer_x, right_y, 9.5, false, line);
        right_y -= 12.0;
    }
    p.y = left_y.min(right_y) - 18.0;

    // Document | date | due date | amount | balance.
    let (date_x, due_x, amount_r) = (260.0, 335.0, 460.0);
    let header = |p: &mut Pages| {
        let y = p.y;
        p.text(MARGIN, y, 9.0, true, &doc.labels.document);
        p.text(date_x, y, 9.0, true, &doc.labels.date);
        p.text(due_x, y, 9.0, true, &doc.labels.due_date);
        p.right(amount_r, y, 9.0, true, &doc.labels.amount);
        p.right(right, y, 9.0, true, &doc.labels.balance);
        p.rule(y - 5.0);
        p.y -= 18.0;
    };
    header(&mut p);
    if doc.rows.is_empty() {
        let y = p.y;
        p.text(MARGIN, y, 9.5, false, &doc.labels.nothing_open);
        p.y -= 16.0;
    }
    for row in &doc.rows {
        let name = wrap(&row.document, date_x - MARGIN - 10.0, 9.5);
        #[allow(clippy::cast_precision_loss)]
        let height = name.len() as f64 * 12.0;
        if p.y - height < MARGIN + 20.0 {
            p.break_if(f64::MAX / 2.0);
            header(&mut p);
        }
        let y = p.y;
        for (i, part) in name.iter().enumerate() {
            #[allow(clippy::cast_precision_loss)]
            p.text(MARGIN, y - i as f64 * 12.0, 9.5, false, part);
        }
        p.text(date_x, y, 9.5, false, &row.date);
        p.text(due_x, y, 9.5, false, &row.due);
        p.right(amount_r, y, 9.5, false, &row.amount);
        p.right(right, y, 9.5, false, &row.balance);
        p.y -= height + 5.0;
    }
    p.y -= 6.0;
    p.break_if(20.0 + 14.0 * f64::from(u32::try_from(doc.totals.len() + 1).unwrap_or(u32::MAX)));
    p.rule(p.y + 9.0);
    for (currency, total) in &doc.totals {
        let y = p.y;
        p.text(
            amount_r - 130.0,
            y,
            11.0,
            true,
            &format!("{} ({currency})", doc.labels.total),
        );
        p.right(right, y, 11.0, true, total);
        p.y -= 15.0;
    }
    assemble(&p.pages, &p.links)
}

fn assemble(pages: &[String], links: &[Vec<Link>]) -> Vec<u8> {
    // Objects: 1 catalog, 2 pages, 3 and 4 fonts, then a content and a page
    // object per page, then the link annotations.
    let mut next_annotation = 5 + pages.len() * 2;
    let mut objects: Vec<String> = Vec::new();
    objects.push("<< /Type /Catalog /Pages 2 0 R >>".to_owned());
    let kids: Vec<String> = (0..pages.len())
        .map(|i| format!("{} 0 R", 6 + i * 2))
        .collect();
    objects.push(format!(
        "<< /Type /Pages /Kids [{}] /Count {} >>",
        kids.join(" "),
        pages.len()
    ));
    objects.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_owned(),
    );
    objects.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
            .to_owned(),
    );
    for (i, content) in pages.iter().enumerate() {
        let content_id = 5 + i * 2;
        objects.push(format!(
            "<< /Length {} >>\nstream\n{content}endstream",
            content.len()
        ));
        debug_assert_eq!(objects.len(), content_id);
        let page_links = links.get(i).map_or(&[][..], Vec::as_slice);
        let annots = if page_links.is_empty() {
            String::new()
        } else {
            let ids: Vec<String> = (next_annotation..next_annotation + page_links.len())
                .map(|id| format!("{id} 0 R"))
                .collect();
            next_annotation += page_links.len();
            format!(" /Annots [{}]", ids.join(" "))
        };
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {WIDTH} {HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {content_id} 0 R{annots} >>"
        ));
    }
    for ([x1, y1, x2, y2], url) in links.iter().flatten() {
        objects.push(format!(
            "<< /Type /Annot /Subtype /Link /Rect [{x1:.2} {y1:.2} {x2:.2} {y2:.2}] /Border [0 0 0] /A << /S /URI /URI {} >> >>",
            literal(url)
        ));
    }
    let mut out: Vec<u8> = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, object) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(object.as_bytes());
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    fn doc(lines: usize) -> DocumentPdf {
        DocumentPdf {
            title: "Factuur".into(),
            number: "F-2026-001".into(),
            seller: PdfParty {
                name: "Acme B.V.".into(),
                lines: vec!["Straat 1".into(), "1234 AB Amsterdam".into(), "BTW NL123456789B01".into()],
            },
            buyer: PdfParty {
                name: "Klant (Piet) \\ Co".into(),
                lines: vec!["Weg 2".into()],
            },
            meta: vec![("Factuurdatum".into(), "27-11-2026".into())],
            labels: PdfLabels {
                description: "Omschrijving".into(),
                quantity: "Aantal".into(),
                unit_price: "Prijs".into(),
                tax: "BTW".into(),
                amount: "Bedrag".into(),
                subtotal: "Subtotaal".into(),
                total: "Totaal".into(),
                paid: "Betaald".into(),
                balance_due: "Openstaand".into(),
                notes: "Opmerkingen".into(),
                payment: "Betalen".into(),
                from: "Van".into(),
                to: "Aan".into(),
            },
            lines: (0..lines)
                .map(|i| PdfLine {
                    description: format!("Werk {i} met een lange omschrijving die over meerdere regels loopt omdat hij zo uitgebreid is, \u{20ac}"),
                    quantity: "2".into(),
                    unit_price: "50.00".into(),
                    tax_rate: "21".into(),
                    total: "100.00".into(),
                })
                .collect(),
            subtotal: "100.00".into(),
            taxes: vec![("21".into(), "21.00".into())],
            total: "121.00".into(),
            paid: Some("0.00".into()),
            balance_due: Some("121.00".into()),
            notes: Some("Bedankt".into()),
            payment_lines: vec!["IBAN NL00 TEST 0000 0000 00".into()],
            qr: None,
            pay_link: None,
        }
    }

    const PAY_URL: &str = "https://pay.example.org/d/eyJ2IjoxLCJ3cyI6IndzXzEyMzQ1Njc4OTAxMiIsInQiOiJpbnZvaWNlIiwiaWQiOiJpbnZfYWJjZGVmZ2hpamtsbW5vcHFyc3QiLCJuIjoibm9uY2Vub25jZW5vbmNlIn0.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJl";

    #[test]
    fn a_qr_code_is_drawn_only_when_given() {
        let plain = String::from_utf8_lossy(&render(&doc(1))).into_owned();
        assert!(!plain.contains(" re\n"));
        let mut with = doc(1);
        with.qr = Some(PdfQr {
            payload: "BCD\n002\n1\nSCT\n\nAcme\nNL91ABNA0417164300\nEUR121.00\n\n\nF-1".into(),
            caption: "Scan om te betalen met je bank-app".into(),
        });
        let bytes = render(&with);
        let text = String::from_utf8_lossy(&bytes);
        // Filled rectangles, one fill, and the caption.
        assert!(text.matches(" re\n").count() > 50);
        assert!(text.contains("Scan om te betalen met je bank-app"));
        assert!(text.contains("\nf\n"));
    }

    #[test]
    fn a_pay_link_is_a_clickable_annotation() {
        let none = String::from_utf8_lossy(&render(&doc(1))).into_owned();
        assert!(!none.contains("/Subtype /Link"));
        assert!(!none.contains("/Annots"));
        let mut with = doc(1);
        with.pay_link = Some(PdfLink {
            label: "Online betalen:".into(),
            url: PAY_URL.into(),
        });
        let bytes = render(&with);
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("(Online betalen:)"));
        assert!(text.contains("/Subtype /Link"));
        assert!(text.contains(&format!("/URI ({PAY_URL})")));
        assert!(text.contains("/Annots ["));
        // The long link wraps over lines inside the margins, one annotation each.
        assert!(text.matches("/Subtype /Link").count() >= 2);
        // Offsets still match with annotation objects after the pages.
        let xref: usize = text
            .rsplit("startxref\n")
            .next()
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let first: usize = text[xref..].lines().nth(3).unwrap()[..10].parse().unwrap();
        assert!(text[first..].starts_with("1 0 obj"));
    }

    #[test]
    fn it_is_a_pdf_with_matching_offsets() {
        let bytes = render(&doc(2));
        assert!(bytes.starts_with(b"%PDF-1.4"));
        assert!(bytes.ends_with(b"%%EOF\n"));
        let text = String::from_utf8_lossy(&bytes);
        let xref: usize = text
            .rsplit("startxref\n")
            .next()
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        assert!(text[xref..].starts_with("xref"));
        // The first object starts where the table says.
        let first: usize = text[xref..].lines().nth(3).unwrap()[..10].parse().unwrap();
        assert!(text[first..].starts_with("1 0 obj"));
        assert!(text.contains("(Factuur)"));
        assert!(text.contains("Klant \\(Piet\\) \\\\ Co"));
    }

    #[test]
    fn a_long_invoice_runs_over_pages() {
        let one = String::from_utf8_lossy(&render(&doc(1)))
            .matches("/Type /Page ")
            .count();
        let many = String::from_utf8_lossy(&render(&doc(60)))
            .matches("/Type /Page ")
            .count();
        assert_eq!(one, 1);
        assert!(many > 2, "{many}");
    }

    #[test]
    fn the_euro_sign_is_winansi() {
        assert_eq!(winansi('€'), 0x80);
        assert_eq!(winansi('é'), 0xe9);
        assert_eq!(winansi('漢'), b'?');
        assert!(literal("€").contains("\\200"));
    }

    #[test]
    fn a_statement_is_a_pdf() {
        let doc = StatementPdf {
            title: "Overzicht".into(),
            as_of: "28-11-2026".into(),
            seller: PdfParty {
                name: "Acme B.V.".into(),
                lines: vec!["Straat 1".into()],
            },
            buyer: PdfParty {
                name: "Klant".into(),
                lines: Vec::new(),
            },
            labels: StatementLabels {
                document: "Document".into(),
                date: "Datum".into(),
                due_date: "Vervaldatum".into(),
                amount: "Bedrag".into(),
                balance: "Openstaand".into(),
                total: "Totaal".into(),
                from: "Van".into(),
                to: "Aan".into(),
                nothing_open: "Niets open".into(),
            },
            rows: (0..80)
                .map(|i| StatementRow {
                    document: format!("Factuur F-{i}"),
                    date: "01-11-2026".into(),
                    due: "01-12-2026".into(),
                    amount: "121.00".into(),
                    balance: "121.00".into(),
                })
                .collect(),
            totals: vec![("EUR".into(), "9680.00".into())],
        };
        let pdf = render_statement(&doc);
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(
            String::from_utf8_lossy(&pdf)
                .matches("/Type /Page ")
                .count()
                >= 2
        );
        let empty = render_statement(&StatementPdf {
            rows: Vec::new(),
            totals: Vec::new(),
            ..doc
        });
        assert!(String::from_utf8_lossy(&empty).contains("Niets open"));
    }
}
