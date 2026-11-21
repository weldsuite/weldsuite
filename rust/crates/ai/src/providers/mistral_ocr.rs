//! Mistral OCR: `POST /v1/ocr` reads a PDF or an image into markdown per
//! page. With [`Document::extract`] the same call fills a JSON schema
//! (`document_annotation_format`), guided by [`Document::prompt`]
//! (`document_annotation_prompt`), priced per annotated page.

use serde_json::{Map, Value, json};

use super::{data_url, parse_json_answer, schema_tool_name};
use crate::catalog::ProviderId;
use crate::error::AiError;
use crate::policy::Target;
use crate::types::{Document, OcrPage};

/// The `/ocr` body for `target`.
pub(crate) fn ocr_body(target: &Target, document: &Document) -> Value {
    let url = data_url(&document.mime, &document.data);
    let source = if document.mime.starts_with("image/") {
        json!({ "type": "image_url", "image_url": url })
    } else {
        json!({ "type": "document_url", "document_url": url })
    };
    let mut body = Map::new();
    body.insert("model".to_owned(), json!(target.native_model()));
    body.insert("document".to_owned(), source);
    body.insert("include_image_base64".to_owned(), json!(false));
    if let Some(extract) = &document.extract {
        body.insert(
            "document_annotation_format".to_owned(),
            json!({
                "type": "json_schema",
                "json_schema": { "name": schema_tool_name(&extract.name), "schema": extract.schema },
            }),
        );
        if let Some(prompt) = document.prompt.as_deref().filter(|p| !p.is_empty()) {
            body.insert("document_annotation_prompt".to_owned(), json!(prompt));
        }
    }
    Value::Object(body)
}

/// What `/ocr` answered: the pages, the extracted fields, and the pages
/// billed.
pub(crate) struct OcrAnswer {
    pub(crate) pages: Vec<OcrPage>,
    pub(crate) object: Option<Value>,
    pub(crate) pages_processed: u32,
}

pub(crate) fn parse_ocr(body: &Value, document: &Document) -> Result<OcrAnswer, AiError> {
    let Some(raw_pages) = body.get("pages").and_then(Value::as_array) else {
        return Err(AiError::Provider {
            provider: ProviderId::Mistral,
            status: None,
            message: "the OCR answer has no pages".to_owned(),
        });
    };
    let pages: Vec<OcrPage> = raw_pages
        .iter()
        .enumerate()
        .map(|(position, page)| OcrPage {
            index: page
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|i| u32::try_from(i).ok())
                .unwrap_or_else(|| u32::try_from(position).unwrap_or(u32::MAX)),
            markdown: page
                .get("markdown")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
        .collect();
    let object = match (&document.extract, body.get("document_annotation")) {
        (Some(_), Some(Value::String(raw))) => Some(parse_json_answer(raw)?),
        (Some(_), Some(value)) if value.is_object() || value.is_array() => Some(value.clone()),
        (Some(_), _) => {
            return Err(AiError::Invalid(
                "the OCR answer has no document annotation".to_owned(),
            ));
        }
        (None, _) => None,
    };
    let pages_processed = body
        .pointer("/usage_info/pages_processed")
        .and_then(Value::as_u64)
        .and_then(|p| u32::try_from(p).ok())
        .unwrap_or_else(|| u32::try_from(pages.len()).unwrap_or(u32::MAX));
    Ok(OcrAnswer {
        pages,
        object,
        pages_processed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{KeySource, Region};
    use crate::types::JsonSchema;

    fn target() -> Target {
        Target {
            provider: ProviderId::Mistral,
            model: "mistral/mistral-ocr-4-1".to_owned(),
            region: Region::Eu,
            key_source: KeySource::Weldsuite,
        }
    }

    fn invoice(extract: bool) -> Document {
        Document {
            mime: "application/pdf".to_owned(),
            name: Some("invoice.pdf".to_owned()),
            data: b"%PDF".to_vec(),
            extract: extract.then(|| JsonSchema {
                name: "invoice".to_owned(),
                schema: json!({ "type": "object", "properties": { "total": { "type": "number" } } }),
            }),
            prompt: extract.then(|| "Extract the total.".to_owned()),
        }
    }

    #[test]
    fn documents_and_annotations_shape_the_request() {
        let body = ocr_body(&target(), &invoice(true));
        assert_eq!(body["model"], "mistral-ocr-4-1");
        assert_eq!(
            body["document"],
            json!({ "type": "document_url", "document_url": "data:application/pdf;base64,JVBERg==" })
        );
        assert_eq!(body["document_annotation_format"]["type"], "json_schema");
        assert_eq!(
            body["document_annotation_format"]["json_schema"]["name"],
            "invoice"
        );
        assert_eq!(body["document_annotation_prompt"], "Extract the total.");
        let image = Document {
            mime: "image/jpeg".to_owned(),
            ..invoice(false)
        };
        let body = ocr_body(&target(), &image);
        assert_eq!(body["document"]["type"], "image_url");
        assert!(body.get("document_annotation_format").is_none());
    }

    #[test]
    fn answers_parse_pages_and_the_annotation() {
        let answer = parse_ocr(
            &json!({
                "pages": [{ "index": 0, "markdown": "# Invoice" }, { "index": 1, "markdown": "Total 12" }],
                "document_annotation": "{\"total\": 12}",
                "usage_info": { "pages_processed": 2, "doc_size_bytes": 4 },
            }),
            &invoice(true),
        )
        .expect("answer");
        assert_eq!(answer.pages.len(), 2);
        assert_eq!(answer.pages[1].markdown, "Total 12");
        assert_eq!(answer.object, Some(json!({ "total": 12 })));
        assert_eq!(answer.pages_processed, 2);
        assert!(matches!(
            parse_ocr(&json!({ "pages": [] }), &invoice(true)),
            Err(AiError::Invalid(_))
        ));
        assert!(parse_ocr(&json!({}), &invoice(false)).is_err());
    }
}
