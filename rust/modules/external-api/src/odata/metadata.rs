//! `$metadata` (CSDL XML), the service document, and the URLs the payloads
//! carry (`routes/v1/odata/metadata.ts`).

use std::fmt::Write as _;
use std::sync::LazyLock;

use weldsuite_core_domain::js::Js;

use super::catalog::{EntitySet, Property, catalog};
use super::query::{SkipToken, encode_skip_token};

/// `xmlEscape(value)`.
pub(crate) fn xml_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            other => escaped.push(other),
        }
    }
    escaped
}

static METADATA: LazyLock<String> = LazyLock::new(|| {
    let catalog = catalog();
    let mut xml = String::new();
    xml.push_str("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n");
    xml.push_str(
        "<edmx:Edmx Version=\"4.0\" xmlns:edmx=\"http://docs.oasis-open.org/odata/ns/edmx\">\n",
    );
    xml.push_str("  <edmx:DataServices>\n");
    // Writing to a String cannot fail.
    let _ = writeln!(
        xml,
        "    <Schema Namespace=\"{}\" xmlns=\"http://docs.oasis-open.org/odata/ns/edm\">",
        catalog.namespace
    );
    for set in &catalog.entity_sets {
        let _ = writeln!(
            xml,
            "      <EntityType Name=\"{}\">",
            xml_escape(&set.entity_type)
        );
        xml.push_str("        <Key>\n");
        let _ = writeln!(
            xml,
            "          <PropertyRef Name=\"{}\"/>",
            xml_escape(&set.key)
        );
        xml.push_str("        </Key>\n");
        for prop in &set.properties {
            let _ = writeln!(
                xml,
                "        <Property Name=\"{}\" Type=\"{}\" Nullable=\"{}\"/>",
                xml_escape(&prop.name),
                xml_escape(prop.edm.name()),
                prop.nullable
            );
        }
        xml.push_str("      </EntityType>\n");
    }
    let _ = writeln!(
        xml,
        "      <EntityContainer Name=\"{}\">",
        catalog.container
    );
    for set in &catalog.entity_sets {
        let _ = writeln!(
            xml,
            "        <EntitySet Name=\"{}\" EntityType=\"{}.{}\"/>",
            xml_escape(&set.name),
            catalog.namespace,
            xml_escape(&set.entity_type)
        );
    }
    xml.push_str("      </EntityContainer>\n");
    xml.push_str("    </Schema>\n");
    xml.push_str("  </edmx:DataServices>\n");
    xml.push_str("</edmx:Edmx>\n");
    xml
});

/// `metadataXml()`: the CSDL document, one `EntityType` per set and an
/// `EntityContainer` listing the sets.
pub(crate) fn metadata_xml() -> &'static str {
    &METADATA
}

/// `serviceDocument(root)`.
pub(crate) fn service_document(root: &str) -> Js {
    let text = |value: &str| Js::String(value.to_owned());
    Js::Object(vec![
        (
            "@odata.context".to_owned(),
            Js::String(format!("{root}/$metadata")),
        ),
        (
            "value".to_owned(),
            Js::Array(
                catalog()
                    .entity_sets
                    .iter()
                    .map(|set| {
                        Js::Object(vec![
                            ("name".to_owned(), text(&set.name)),
                            ("kind".to_owned(), text("EntitySet")),
                            ("url".to_owned(), text(&set.name)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}

/// `contextUrl(root, set, select, entity)`: `<root>/$metadata#Set`, with the
/// selected properties in parentheses.
pub(crate) fn context_url(
    root: &str,
    set: &EntitySet,
    select: Option<&[&Property]>,
    entity: bool,
) -> String {
    let fields = select.map_or_else(String::new, |props| {
        let names: Vec<&str> = props.iter().map(|prop| prop.name.as_str()).collect();
        format!("({})", names.join(","))
    });
    format!(
        "{root}/$metadata#{}{fields}{}",
        set.name,
        if entity { "/$entity" } else { "" }
    )
}

/// `encodeURIComponent(value)`.
pub(crate) fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

/// `nextLink(requestUrl, token, remainingTop)`: the next page's URL: the
/// caller's own options, minus `$skip` and `$top` (the position is in the
/// token; `$top` becomes what is left of it), plus `$skiptoken`.
pub(crate) fn next_link(
    origin: &str,
    path: &str,
    params: &[(String, String)],
    token: &SkipToken,
    remaining_top: Option<i64>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (name, value) in params {
        if matches!(name.as_str(), "$skip" | "$top" | "$skiptoken") {
            continue;
        }
        let name = match name.strip_prefix('$') {
            Some(rest) => format!("${}", encode_uri_component(rest)),
            None => encode_uri_component(name),
        };
        parts.push(format!("{name}={}", encode_uri_component(value)));
    }
    if let Some(top) = remaining_top {
        parts.push(format!("$top={top}"));
    }
    parts.push(format!("$skiptoken={}", encode_skip_token(token)));
    format!("{origin}{path}?{}", parts.join("&"))
}

#[cfg(test)]
mod tests {
    use weldsuite_core_domain::js::stringify;

    use super::super::catalog::find_entity_set;
    use super::*;

    #[test]
    fn xml_is_escaped() {
        assert_eq!(
            xml_escape("a&b<c>\"d\"'e'"),
            "a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;"
        );
    }

    #[test]
    fn the_csdl_lists_every_set_and_property() {
        let xml = metadata_xml();
        assert!(xml.starts_with(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
             <edmx:Edmx Version=\"4.0\" xmlns:edmx=\"http://docs.oasis-open.org/odata/ns/edmx\">\n\
             \x20 <edmx:DataServices>\n\
             \x20   <Schema Namespace=\"WeldSuite.Desk\" xmlns=\"http://docs.oasis-open.org/odata/ns/edm\">\n\
             \x20     <EntityType Name=\"Conversation\">\n\
             \x20       <Key>\n\
             \x20         <PropertyRef Name=\"id\"/>\n\
             \x20       </Key>\n\
             \x20       <Property Name=\"id\" Type=\"Edm.String\" Nullable=\"false\"/>\n\
             \x20       <Property Name=\"conversationNumber\" Type=\"Edm.Int32\" Nullable=\"false\"/>\n\
             \x20       <Property Name=\"title\" Type=\"Edm.String\" Nullable=\"true\"/>\n"
        ));
        assert!(xml.ends_with(
            "        <EntitySet Name=\"Articles\" EntityType=\"WeldSuite.Desk.Article\"/>\n\
             \x20     </EntityContainer>\n\
             \x20   </Schema>\n\
             \x20 </edmx:DataServices>\n\
             </edmx:Edmx>\n"
        ));
        assert!(xml.contains("      <EntityContainer Name=\"Feed\">\n"));
        assert!(xml.contains(
            "        <Property Name=\"tags\" Type=\"Collection(Edm.String)\" Nullable=\"false\"/>\n"
        ));
        for set in &catalog().entity_sets {
            assert!(xml.contains(&format!(
                "      <EntityType Name=\"{}\">\n",
                set.entity_type
            )));
            assert!(xml.contains(&format!(
                "        <EntitySet Name=\"{}\" EntityType=\"WeldSuite.Desk.{}\"/>\n",
                set.name, set.entity_type
            )));
            for prop in &set.properties {
                assert!(
                    xml.contains(&format!(
                        "        <Property Name=\"{}\" Type=\"{}\" Nullable=\"{}\"/>\n",
                        prop.name,
                        prop.edm.name(),
                        prop.nullable
                    )),
                    "{}.{}",
                    set.name,
                    prop.name
                );
            }
        }
        let lines = xml.lines().count();
        let expected: usize = catalog()
            .entity_sets
            .iter()
            .map(|set| set.properties.len() + 6)
            .sum::<usize>()
            + 9;
        assert_eq!(lines, expected);
    }

    #[test]
    fn the_service_document_lists_the_sets_in_order() {
        let document = stringify(&service_document("http://localhost/v1/odata"));
        assert!(document.starts_with(
            r#"{"@odata.context":"http://localhost/v1/odata/$metadata","value":[{"name":"Conversations","kind":"EntitySet","url":"Conversations"},{"name":"Messages","kind":"EntitySet","url":"Messages"},"#
        ));
        assert!(document.ends_with(r#"{"name":"Articles","kind":"EntitySet","url":"Articles"}]}"#));
    }

    #[test]
    fn context_urls_name_the_set_and_what_was_selected() {
        let set = find_entity_set("Conversations").expect("the set");
        let root = "https://api.weldsuite.org/v1/odata";
        assert_eq!(
            context_url(root, set, None, false),
            "https://api.weldsuite.org/v1/odata/$metadata#Conversations"
        );
        assert_eq!(
            context_url(root, set, None, true),
            "https://api.weldsuite.org/v1/odata/$metadata#Conversations/$entity"
        );
        let selected: Vec<&Property> = ["id", "tags"]
            .iter()
            .filter_map(|name| set.property(name))
            .collect();
        assert_eq!(
            context_url(root, set, Some(&selected), false),
            "https://api.weldsuite.org/v1/odata/$metadata#Conversations(id,tags)"
        );
        assert_eq!(
            context_url(root, set, Some(&selected), true),
            "https://api.weldsuite.org/v1/odata/$metadata#Conversations(id,tags)/$entity"
        );
    }

    #[test]
    fn uri_components_are_encoded_as_javascript_does() {
        assert_eq!(encode_uri_component("createdAt desc"), "createdAt%20desc");
        assert_eq!(
            encode_uri_component("kind eq 'message'"),
            "kind%20eq%20'message'"
        );
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
        assert_eq!(
            encode_uri_component("a&b=c+d/e?f#g,h;i:j@k$l%"),
            "a%26b%3Dc%2Bd%2Fe%3Ff%23g%2Ch%3Bi%3Aj%40k%24l%25"
        );
        assert_eq!(encode_uri_component("é😀"), "%C3%A9%F0%9F%98%80");
    }

    #[test]
    fn the_next_link_keeps_the_callers_options() {
        let params = |given: &[(&str, &str)]| {
            given
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            next_link(
                "http://localhost",
                "/v1/odata/Messages",
                &params(&[("$select", "id")]),
                &SkipToken::Key("msg_01000".into()),
                None,
            ),
            "http://localhost/v1/odata/Messages?$select=id&$skiptoken=eyJrIjoibXNnXzAxMDAwIn0"
        );
        // `$skip`, `$top` and the old token go; `$top` is what is left of it.
        assert_eq!(
            next_link(
                "https://api.weldsuite.org",
                "/v1/odata/Messages",
                &params(&[
                    ("$top", "1500"),
                    ("$skip", "5"),
                    ("$skiptoken", "old"),
                    ("$orderby", "createdAt desc"),
                    ("custom key", "a&b"),
                    ("$count", "true"),
                ]),
                &SkipToken::Offset(1000),
                Some(500),
            ),
            "https://api.weldsuite.org/v1/odata/Messages?$orderby=createdAt%20desc&custom%20key=a%26b&$count=true&$top=500&$skiptoken=eyJvIjoxMDAwfQ"
        );
    }
}
