//! The spreadsheets the person points at (AGENT-015): the open sheet and the
//! ones tagged in the chat get the persona the sheet tools, limited to those
//! sheets, with the person's own `sheets:*` permissions.

use super::*;

fn sheet_chat() -> Value {
    json!({
        "messages": [{ "role": "user", "content": "Total column B of <@sheet:sht_tag|Budget>" }],
        "context": { "sheet": { "id": "sht_open", "name": "Sales", "tab": "Q4", "selection": "B2:B9" } },
    })
}

fn system_of(call: &weldsuite_ai::fake::FakeCall) -> String {
    call.body["messages"][0]["content"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

#[tokio::test]
async fn the_persona_reads_the_open_and_tagged_sheets_and_no_others() {
    let Some(tenant) = tenant() else { return };
    crate::tools::module_tools_tests::install_fake();
    let fake = FakeProvider::new()
        .reply_tool_call(
            "read_spreadsheet_range",
            &json!({ "spreadsheetId": "sht_open" }),
        )
        .reply_tool_call(
            "read_spreadsheet_range",
            &json!({ "spreadsheetId": "sht_other" }),
        )
        .reply_text("Done");
    let router = app(
        tenant,
        Some(Ai::fake(config(), fake.clone())),
        &["agents:read", "weldagent:use", "sheets:read"],
    );
    let (status, text, _) = post(&router, "/ai/chat", &sheet_chat()).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(json_of(&text)["data"]["text"], "Done");

    let calls = fake.calls();
    assert_eq!(calls.len(), 3);
    // Reading only: the person may not update sheets.
    let mut offered = tool_names(&calls[0]);
    offered.sort();
    assert_eq!(offered, ["list_spreadsheet_tabs", "read_spreadsheet_range"]);
    let system = system_of(&calls[0]);
    assert!(system.contains("spreadsheetId sht_open"), "{system}");
    assert!(
        system.contains("\"Budget\" (spreadsheetId sht_tag)"),
        "{system}"
    );
    assert!(system.contains("You cannot change them"), "{system}");
    // The open sheet's read reached the sheets module as the person; the other did not.
    let reached = crate::tools::module_tools_tests::calls_of("user_me");
    assert_eq!(reached.len(), 1, "{reached:?}");
    assert_eq!(reached[0].2.as_deref(), Some("sht_open"));
    let last = calls[2].body["messages"].to_string();
    assert!(
        last.contains("only work in the spreadsheet the user has open or tagged"),
        "{last}"
    );
}

#[tokio::test]
async fn the_persona_writes_only_with_the_update_permission_and_takes_ten_steps() {
    let Some(tenant) = tenant() else { return };
    crate::tools::module_tools_tests::install_fake();
    let mut fake = FakeProvider::new();
    for _ in 0..9 {
        fake = fake.reply_tool_call(
            "list_spreadsheet_tabs",
            &json!({ "spreadsheetId": "sht_open" }),
        );
    }
    let fake = fake.reply_text("Checked");
    let router = app(
        tenant,
        Some(Ai::fake(config(), fake.clone())),
        &[
            "agents:read",
            "weldagent:use",
            "sheets:read",
            "sheets:update",
        ],
    );
    let (status, text, _) = post(&router, "/ai/chat", &sheet_chat()).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    assert_eq!(json_of(&text)["data"]["text"], "Checked");
    let calls = fake.calls();
    // Ten model requests, not six.
    assert_eq!(calls.len(), 10);
    let mut offered = tool_names(&calls[0]);
    offered.sort();
    assert_eq!(
        offered,
        [
            "list_spreadsheet_tabs",
            "read_spreadsheet_range",
            "write_spreadsheet_range"
        ]
    );
    assert!(system_of(&calls[0]).contains("write_spreadsheet_range writes rows of values"));
}

#[tokio::test]
async fn without_a_sheet_or_the_permission_the_persona_has_no_sheet_tools() {
    let Some(tenant) = tenant() else { return };
    // A sheet is open, but the person may not read sheets.
    let fake = FakeProvider::new().reply_text("No");
    let router = app(tenant.clone(), Some(Ai::fake(config(), fake.clone())), &USE);
    let (status, _, _) = post(&router, "/ai/chat", &sheet_chat()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(tool_names(&fake.calls()[0]).is_empty());
    assert!(!system_of(&fake.calls()[0]).contains("SPREADSHEETS"));
    // They may, but point at none.
    let fake = FakeProvider::new().reply_text("No");
    let router = app(
        tenant,
        Some(Ai::fake(config(), fake.clone())),
        &["agents:read", "weldagent:use", "sheets:read"],
    );
    let (status, _, _) = post(&router, "/ai/chat", &hello()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(tool_names(&fake.calls()[0]).is_empty());
}

#[test]
fn a_tag_names_the_sheet_once_and_the_open_sheet_leads() {
    use crate::assistant::persona::{OpenSheet, PersonaSheets, open_sheet_instructions};
    let messages = vec![
        (
            "user".to_owned(),
            "<@sheet:s1|A> and <@sheet:s2> and <@task:t1|T> and <@sheet:s1|A>".to_owned(),
        ),
        ("assistant".to_owned(), "<@sheet:s3|Nope>".to_owned()),
    ];
    let tagged = crate::assistant::tags::tagged_sheets(&messages);
    assert_eq!(
        tagged,
        [
            ("s1".to_owned(), Some("A".to_owned())),
            ("s2".to_owned(), None)
        ]
    );
    let sheets = PersonaSheets {
        open: Some(OpenSheet {
            id: "s2".into(),
            ..OpenSheet::default()
        }),
        tagged,
    };
    assert_eq!(sheets.ids(), ["s2", "s1"]);
    let note = open_sheet_instructions("sht_1", Some(" Sales "), Some("Q4"), None);
    assert!(
        note.contains("\"Sales\" open (spreadsheetId sht_1), on the tab \"Q4\"."),
        "{note}"
    );
}
