//! The default WeldAgent (`packages/domains/agent/src/persona.ts`): the chat
//! assistant a person gets without picking a workspace agent.
//!
//! It has no agent row and so no grants. What it may read comes from the
//! person chatting: each read tool is offered only when that person's own
//! permissions cover it, and reads stay inside their row-level scope.
//!
//! It writes in one place only: the spreadsheets the person points it at, the
//! one open next to the chat and the ones tagged in it (AGENT-015). It gets
//! the spreadsheet tools limited to those sheets, with the person's own
//! `sheets:*` permissions (reading needs `sheets:read`, writing
//! `sheets:update` as well) and their edit access to each sheet.

use tokio::sync::mpsc;
use weldsuite_ai::{
    Ai, AiCall, AiError, ChatRequest, Message, Part, Role, Served, StreamEvent, ToolCall,
    ToolChoice, Usage,
};
use weldsuite_flow_domain::day_bounds::workspace_timezone;

use crate::Caller;
use crate::tools::{
    SHEET_SCOPED_TOOL_IDS, ToolContext, ToolRowScope, ToolSpec, execute_tool, platform_tools,
    sheet_call_allowed, sheet_not_allowed, tool_defs,
};

/// Stands in for the agent id the tools attribute work to.
pub(super) const PERSONA_AGENT_ID: &str = "agt_weldagent_default";

/// Model requests one reply may take: a few lookups, then the answer.
pub(super) const MAX_STEPS: usize = 6;

/// With a spreadsheet to work on: look at its tabs and cells, write, check,
/// answer (`PERSONA_SHEET_MAX_STEPS`).
pub(super) const SHEET_MAX_STEPS: usize = 10;

/// The spreadsheet open next to the chat (`context.sheet`, `AiOpenSheet`).
#[derive(Debug, Clone, Default)]
pub(super) struct OpenSheet {
    pub(super) id: String,
    pub(super) name: Option<String>,
    pub(super) tab: Option<String>,
    pub(super) selection: Option<String>,
}

/// The spreadsheets the person points the persona at (`PersonaSheets`): the
/// open one and the ones tagged in the conversation (id, label).
#[derive(Debug, Clone, Default)]
pub(super) struct PersonaSheets {
    pub(super) open: Option<OpenSheet>,
    pub(super) tagged: Vec<(String, Option<String>)>,
}

impl PersonaSheets {
    /// `personaSheetIds`: the open one first, each once.
    pub(super) fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        for id in self
            .open
            .iter()
            .map(|sheet| sheet.id.clone())
            .chain(self.tagged.iter().map(|(id, _)| id.clone()))
        {
            if !id.is_empty() && !ids.contains(&id) {
                ids.push(id);
            }
        }
        ids
    }
}

/// `describeOpenSheet`: where the person is in the open spreadsheet, as one
/// sentence.
pub(crate) fn describe_open_sheet(
    id: &str,
    name: Option<&str>,
    tab: Option<&str>,
    selection: Option<&str>,
) -> String {
    let name = name
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map_or_else(|| "a spreadsheet".to_owned(), |n| format!("\"{n}\""));
    let place: Vec<String> = [
        tab.filter(|t| !t.is_empty())
            .map(|t| format!("on the tab \"{t}\"")),
        selection
            .filter(|s| !s.is_empty())
            .map(|s| format!("with {s} selected")),
    ]
    .into_iter()
    .flatten()
    .collect();
    let place = if place.is_empty() {
        String::new()
    } else {
        format!(", {}", place.join(", "))
    };
    format!("The user has the spreadsheet {name} open (spreadsheetId {id}){place}.")
}

/// `openSheetInstructions`: what a workspace agent is told about the
/// spreadsheet open next to the chat: it works on it with its own spreadsheet
/// tools, if it has them.
pub(crate) fn open_sheet_instructions(
    id: &str,
    name: Option<&str>,
    tab: Option<&str>,
    selection: Option<&str>,
) -> String {
    format!(
        "{} \"This sheet\", \"here\" and \"the selection\" refer to it: use that spreadsheetId with your spreadsheet tools. \
         Your changes show in the sheet at once. If you have no spreadsheet tools, say you cannot read or change spreadsheets.",
        describe_open_sheet(id, name, tab, selection)
    )
}

/// The only tools the default WeldAgent has, all read-only.
const TOOL_IDS: [&str; 6] = [
    "people.list",
    "people.get",
    "tickets.list",
    "tasks.list",
    "projects.list",
    "projects.get",
];

/// The row-level grants that widen what a person sees to everyone's records.
const SCOPE_PEOPLE: &str = "people:scope:all";
const SCOPE_PROJECTS: &str = "projects:scope:all";

/// What the person sees when the model returned no text.
pub(super) const FALLBACK_TEXT: &str = "Sorry, I couldn't finish that. Please try again.";

/// What a tool that threw answers the model with.
const TOOL_FAILED: &str = "The lookup failed. Say you could not check it right now; do not guess.";

const BASE_INSTRUCTIONS: &str = "You are WeldAgent, the AI assistant built into the WeldSuite business platform. \
Be concise, direct and practical. Use plain text, no markdown headings, and keep answers short unless the user asks for detail.\n\n\
RULES\n\
- For any question about the user's workspace data, call your tools first, then answer from what they return. \
Do not write text before calling a tool, and never say you are going to look something up without doing it.\n\
- Only state counts, names, records, dates, notifications or emails that a tool returned in this conversation. \
Never guess, estimate or invent an example. If a tool returns nothing, say so plainly.\n\
- If you have no tool for something, say so in one short sentence of your own, speaking as \"I\" (never \"You cannot …\"), \
and point to where it lives: that app, or a workspace agent from the agent menu. \
For example: \"I can't see your notifications here — open the bell at the top right.\", \
\"I can't read your inbox here — open WeldMail.\", \"I can't create or change records here — pick a workspace agent from the agent menu.\" \
This covers notifications, the mail inbox, the calendar, meetings, files, accounting, commerce, and creating or changing any record. \
Never promise to check later.\n\
- Never show internal ids (they look like prj_…, task_…, per_…), tool names or raw field names. \
Refer to records by their name, title or number.\n\
- If the request lacks something you need (for example which contact to find), ask one short question.";

/// `sheetsSection`: how the persona works on the spreadsheets the user points at.
fn sheets_section(sheets: &PersonaSheets, can_write: bool) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(open) = &sheets.open {
        lines.push(format!(
            "{} \"This sheet\", \"here\" and \"the selection\" refer to it.",
            describe_open_sheet(
                &open.id,
                open.name.as_deref(),
                open.tab.as_deref(),
                open.selection.as_deref()
            )
        ));
    }
    let open_id = sheets.open.as_ref().map(|sheet| sheet.id.as_str());
    let tagged: Vec<String> = sheets
        .tagged
        .iter()
        .filter(|(id, _)| Some(id.as_str()) != open_id)
        .map(|(id, label)| {
            let name = label
                .as_deref()
                .filter(|l| !l.is_empty())
                .map_or_else(|| "a spreadsheet".to_owned(), |l| format!("\"{l}\""));
            format!("{name} (spreadsheetId {id})")
        })
        .collect();
    if !tagged.is_empty() {
        lines.push(format!("The user tagged: {}.", tagged.join(", ")));
    }
    if can_write {
        lines.extend([
            "You can read and change these spreadsheets, and only these, with list_spreadsheet_tabs, read_spreadsheet_range and write_spreadsheet_range. \
             Changing them is the one exception to the rule that you cannot change records.".to_owned(),
            "- Look before you write: read the tab first (read_spreadsheet_range without a range returns its used cells), so your changes fit its layout.".to_owned(),
            "- write_spreadsheet_range writes rows of values from a start cell. Text starting with \"=\" is a formula in English syntax, for example =SUM(B2:B9); null clears a cell.".to_owned(),
            "- Change cells only when the user asks for a change, and never overwrite filled cells they did not ask you to change.".to_owned(),
            "- After a write, say in one sentence what you changed and where (tab and cells). The change shows in the sheet at once and can be undone from version history.".to_owned(),
            "- If a write is refused because the user may only view the sheet, say so.".to_owned(),
        ]);
    } else {
        lines.push(
            "You can read these spreadsheets, and only these, with list_spreadsheet_tabs and read_spreadsheet_range. \
             You cannot change them: the user has no permission to edit spreadsheets."
                .to_owned(),
        );
    }
    format!("SPREADSHEETS\n{}", lines.join("\n"))
}

/// The persona's lookup guide, by the tool that makes it relevant.
const GUIDE_BY_TOOL: [(&str, &str); 4] = [
    (
        "people.list",
        "contacts and people in the CRM: list_people (search by name or email), get_person",
    ),
    ("tickets.list", "helpdesk tickets: list_tickets"),
    ("tasks.list", "tasks: list_tasks"),
    (
        "projects.list",
        "projects and how many tasks they have: list_projects, get_project",
    ),
];

/// The default WeldAgent for one caller: instructions, tools, and the context
/// the tools run in.
pub(super) struct Persona {
    pub(super) system: String,
    pub(super) tools: Vec<&'static ToolSpec>,
    ctx: ToolContext,
    /// The spreadsheets the sheet tools may work in (the open one and the
    /// tagged ones); a call for any other is refused before it reaches the
    /// sheets module.
    sheet_ids: Vec<String>,
    /// Model requests one reply may take.
    pub(super) max_steps: usize,
}

/// `selectPersonaSheetTools`: the spreadsheet tools for the sheets the person
/// points at, as far as their permissions go: reading needs `sheets:read`,
/// writing `sheets:update` as well. None without a sheet to work on.
fn select_sheet_tools(
    holds: &impl Fn(&str) -> bool,
    sheets: &PersonaSheets,
) -> Vec<&'static ToolSpec> {
    if sheets.ids().is_empty() || !holds("sheets:read") {
        return Vec::new();
    }
    platform_tools()
        .iter()
        .filter(|tool| SHEET_SCOPED_TOOL_IDS.contains(&tool.id))
        .filter(|tool| tool.required_permissions.iter().all(|key| holds(key)))
        .collect()
}

/// The persona's tools this person may use: those whose permissions they all
/// hold.
fn select_tools(holds: &impl Fn(&str) -> bool) -> Vec<&'static ToolSpec> {
    platform_tools()
        .iter()
        .filter(|tool| TOOL_IDS.contains(&tool.id))
        .filter(|tool| tool.required_permissions.iter().all(|key| holds(key)))
        .collect()
}

/// `buildPersonaSystem`: the rules, what it can look up, and how.
fn build_system(
    tools: &[&ToolSpec],
    extra_system: Option<&str>,
    today: &str,
    timezone: Option<&str>,
    sheets: Option<&PersonaSheets>,
) -> String {
    let has = |id: &str| tools.iter().any(|tool| tool.id == id);
    let mut sections = vec![BASE_INSTRUCTIONS.to_owned()];
    let sheets = sheets.filter(|_| has("sheets.read_range"));

    let lookups: Vec<String> = GUIDE_BY_TOOL
        .iter()
        .filter(|(id, _)| has(id))
        .map(|(_, line)| format!("- {line}"))
        .collect();
    if lookups.is_empty() && sheets.is_some() {
        sections.push(
            "WHAT YOU CAN LOOK UP\nOnly the spreadsheets below: you have no other lookup tools for this user."
                .to_owned(),
        );
    } else if lookups.is_empty() {
        sections.push(
            "WHAT YOU CAN LOOK UP\nNothing: you have no lookup tools for this user, so you cannot read their workspace data here. Say so if they ask for it."
                .to_owned(),
        );
    } else {
        sections.push(format!(
            "WHAT YOU CAN LOOK UP (read only)\n{}",
            lookups.join("\n")
        ));
    }

    if let Some(sheets) = sheets {
        sections.push(sheets_section(sheets, has("sheets.write_range")));
    }

    if has("tasks.list") {
        let zone = timezone.map_or_else(String::new, |zone| format!(" ({zone})"));
        let get_project = if has("projects.get") {
            "- \"How many tasks are in project X\": get_project by name and report its task counts.\n"
        } else {
            ""
        };
        sections.push(format!(
            "HOW\n\
- \"my\" and \"me\" mean the signed-in user: for \"my tasks\" use list_tasks with assignedToMe=true.\n\
- \"What is on my plate today?\": list_tasks with assignedToMe=true, includeDone=false and dueOnOrBefore set to today. \
That returns what is overdue or due today; when nothing is, say nothing is due today or overdue for them.\n\
- \"My open tasks\": list_tasks with assignedToMe=true and includeDone=false, whatever the due date. \
When there are none, say they have no open tasks assigned to them; do not talk about today.\n\
{get_project}- Today is {today}{zone}."
        ));
    }

    if let Some(extra) = extra_system.filter(|extra| !extra.is_empty()) {
        sections.push(extra.to_owned());
    }
    sections.join("\n\n")
}

/// Today's calendar date (`YYYY-MM-DD`) in a time zone (UTC when it is
/// missing or unknown): `todayIn`.
fn today_in(timezone: Option<&str>) -> String {
    let zone = timezone
        .filter(|zone| !zone.is_empty())
        .and_then(|zone| jiff::tz::TimeZone::get(zone).ok())
        .unwrap_or(jiff::tz::TimeZone::UTC);
    let date = jiff::Timestamp::now().to_zoned(zone).date();
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// `buildPersonaCall`: everything a persona model call needs besides the
/// model and the messages.
pub(super) async fn build(
    caller: &Caller,
    timezone: Option<String>,
    extra_system: Option<&str>,
    sheets: &PersonaSheets,
) -> Persona {
    let holds = |key: &str| caller.permissions.has_any(&[key]);
    let read_tools = select_tools(&holds);
    let sheet_tools = select_sheet_tools(&holds, sheets);
    let mut timezone = timezone;
    if !read_tools.is_empty() && timezone.is_none() {
        timezone = workspace_timezone(&caller.db).await.unwrap_or(None);
    }
    let mut tools = read_tools.clone();
    tools.extend(sheet_tools.iter().copied());
    // The keys the persona's tools need that this person holds, checked
    // deny-aware like any route (`personaPermissions`).
    let mut held: Vec<String> = Vec::new();
    for key in platform_tools()
        .iter()
        .filter(|tool| TOOL_IDS.contains(&tool.id) || SHEET_SCOPED_TOOL_IDS.contains(&tool.id))
        .flat_map(|tool| tool.required_permissions.iter().copied())
        .chain([SCOPE_PEOPLE, SCOPE_PROJECTS])
    {
        if !held.iter().any(|k| k == key) && holds(key) {
            held.push(key.to_owned());
        }
    }
    let ctx = ToolContext {
        db: caller.db.clone(),
        agent_id: PERSONA_AGENT_ID.to_owned(),
        actor_user_id: caller.user_id.clone(),
        workspace_id: caller.workspace_id.clone(),
        agent_permissions: held,
        enabled_tools: tools.iter().map(|tool| tool.id.to_owned()).collect(),
        user_timezone: timezone.clone(),
        actor_permissions: None,
        actor_can_edit: Some(false),
        row_scope: Some(ToolRowScope {
            user_id: caller.user_id.clone(),
            all_people: holds(SCOPE_PEOPLE),
            all_projects: holds(SCOPE_PROJECTS),
        }),
        events: None,
        sandbox: false,
        channel_id: None,
        conversation_id: None,
        agent_hop: 0,
        max_agent_hops: 2,
        master: None,
        realtime: None,
        ai: None,
    };
    let with_sheets = !sheet_tools.is_empty();
    Persona {
        system: build_system(
            &tools,
            extra_system,
            &today_in(timezone.as_deref()),
            timezone.as_deref(),
            with_sheets.then_some(sheets),
        ),
        tools,
        ctx,
        sheet_ids: if with_sheets {
            sheets.ids()
        } else {
            Vec::new()
        },
        max_steps: if with_sheets {
            SHEET_MAX_STEPS
        } else {
            MAX_STEPS
        },
    }
}

impl Persona {
    fn request(
        &self,
        messages: &[Message],
        temperature: Option<f32>,
        max_tokens: Option<u32>,
    ) -> ChatRequest {
        ChatRequest {
            system: Some(self.system.clone()),
            messages: messages.to_vec(),
            tools: tool_defs(&self.tools),
            tool_choice: ToolChoice::Auto,
            response_schema: None,
            max_tokens,
            temperature,
        }
    }

    /// Run one tool the model asked for. A tool that fails answers the model
    /// with an error, it does not end the reply.
    async fn run_tool(&self, call: &ToolCall) -> Part {
        let outside_sheets = self
            .tools
            .iter()
            .find(|tool| tool.name == call.name)
            .is_some_and(|tool| {
                SHEET_SCOPED_TOOL_IDS.contains(&tool.id)
                    && !sheet_call_allowed(&self.sheet_ids, &call.arguments)
            });
        let (content, is_error) = if outside_sheets {
            (sheet_not_allowed().to_string(), false)
        } else if self.tools.iter().any(|tool| tool.name == call.name) {
            match execute_tool(&self.ctx, &call.name, &call.arguments).await {
                Ok(value) => (value.to_string(), false),
                Err(error @ crate::tools::ToolError::InvalidArguments(_)) => (
                    serde_json::json!({ "error": error.message() }).to_string(),
                    true,
                ),
                Err(error) => {
                    tracing::warn!(tool = %call.name, error = %error.message(), "[weldagent/persona] a tool failed");
                    (
                        serde_json::json!({ "error": TOOL_FAILED }).to_string(),
                        false,
                    )
                }
            }
        } else {
            (
                serde_json::json!({ "error": format!("Unknown tool: {}", call.name) }).to_string(),
                true,
            )
        };
        Part::ToolResult {
            call_id: call.id.clone(),
            content,
            is_error,
        }
    }

    /// The model's tool calls and what the tools answered, as the next two
    /// messages of the conversation.
    async fn after_tools(&self, text: &str, calls: &[ToolCall]) -> [Message; 2] {
        let mut asked = Vec::new();
        if !text.is_empty() {
            asked.push(Part::Text(text.to_owned()));
        }
        asked.extend(calls.iter().cloned().map(Part::ToolCall));
        let mut answers = Vec::with_capacity(calls.len());
        for call in calls {
            answers.push(self.run_tool(call).await);
        }
        [
            Message {
                role: Role::Assistant,
                content: asked,
            },
            Message {
                role: Role::Tool,
                content: answers,
            },
        ]
    }
}

/// A finished reply: the last request's text, everything's usage and charge.
#[derive(Debug)]
pub(super) struct Reply {
    pub(super) text: String,
    pub(super) finish_reason: weldsuite_ai::FinishReason,
    pub(super) usage: Usage,
    pub(super) credits: i64,
    pub(super) served: Served,
}

fn add(total: &mut Usage, usage: Usage) {
    total.input_tokens += usage.input_tokens;
    total.output_tokens += usage.output_tokens;
}

/// `generateText` with the persona's tools (`stopWhen: stepCountIs(6)`): look
/// things up, then answer. Each model request is metered by the AI crate.
pub(super) async fn run(
    ai: &Ai,
    call: &AiCall,
    persona: &Persona,
    mut messages: Vec<Message>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
) -> Result<Reply, AiError> {
    let mut usage = Usage::default();
    let mut credits = 0;
    for step in 1..=persona.max_steps {
        let answer = ai
            .chat(call, persona.request(&messages, temperature, max_tokens))
            .await?;
        add(&mut usage, answer.usage);
        credits += answer.credits;
        if answer.tool_calls.is_empty() || step == persona.max_steps {
            return Ok(Reply {
                text: if answer.tool_calls.is_empty() {
                    answer.text
                } else {
                    String::new()
                },
                finish_reason: answer.finish_reason,
                usage,
                credits,
                served: answer.served,
            });
        }
        messages.extend(persona.after_tools(&answer.text, &answer.tool_calls).await);
    }
    Err(AiError::Unavailable)
}

/// The text of a finished reply, never empty (`personaReplyText`).
pub(super) fn reply_text(text: String) -> String {
    if text.trim().is_empty() {
        FALLBACK_TEXT.to_owned()
    } else {
        text
    }
}

/// `streamText` with the persona's tools, as the plain text the chat client
/// reads (`createPersonaTextTransform`): the text of one model request is set
/// apart from the next by a blank line, and an empty reply becomes
/// [`FALLBACK_TEXT`]. Chunks go to `out` as they arrive.
///
/// When the client leaves (`out` is closed) the request being streamed is
/// read to its end, so it is still metered, and no further request is made.
pub(super) async fn stream(
    ai: Ai,
    call: AiCall,
    persona: Persona,
    mut messages: Vec<Message>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    out: mpsc::Sender<String>,
) {
    use futures_util::StreamExt;

    let mut emitted = false;
    let mut separate = false;
    let mut gone = false;
    'steps: for step in 1..=persona.max_steps {
        let request = persona.request(&messages, temperature, max_tokens);
        let mut events = match ai.chat_stream(&call, request).await {
            Ok(events) => events,
            Err(error) => {
                tracing::error!(%error, "[ai/chat/stream] model error");
                break;
            }
        };
        let mut step_had_text = false;
        let mut finished = None;
        while let Some(event) = events.next().await {
            match event {
                Ok(StreamEvent::TextDelta(text)) if !text.is_empty() => {
                    if gone {
                        continue;
                    }
                    if separate {
                        separate = false;
                        gone = out.send("\n\n".to_owned()).await.is_err();
                    }
                    if !gone {
                        gone = out.send(text).await.is_err();
                    }
                    emitted = true;
                    step_had_text = true;
                }
                Ok(StreamEvent::Finish(answer)) => finished = Some(*answer),
                Ok(_) => {}
                Err(error) => {
                    tracing::error!(%error, "[ai/chat/stream] model error");
                    break 'steps;
                }
            }
        }
        if step_had_text {
            separate = true;
        }
        let Some(answer) = finished else { break };
        if gone || answer.tool_calls.is_empty() || step == persona.max_steps {
            break;
        }
        messages.extend(persona.after_tools(&answer.text, &answer.tool_calls).await);
    }
    if !emitted && !gone {
        let _ = out.send(FALLBACK_TEXT.to_owned()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_is_never_empty() {
        assert_eq!(reply_text("  ".to_owned()), FALLBACK_TEXT);
        assert_eq!(reply_text("Hi".to_owned()), "Hi");
    }

    #[test]
    fn without_tools_the_persona_says_it_can_look_nothing_up() {
        let system = build_system(&[], None, "2026-11-13", None, None);
        assert!(system.contains("no lookup tools for this user"));
        assert!(!system.contains("HOW\n"));
    }

    #[test]
    fn tools_come_with_their_guide_and_the_date() {
        let all = |_: &str| true;
        let tools = select_tools(&all);
        let ids: Vec<&str> = tools.iter().map(|tool| tool.id).collect();
        assert!(ids.contains(&"tasks.list"));
        assert!(!ids.contains(&"people.create"));
        let system = build_system(
            &tools,
            Some("Looking at a ticket"),
            "2026-11-13",
            Some("Europe/Amsterdam"),
            None,
        );
        assert!(system.contains("- tasks: list_tasks"));
        assert!(system.contains("Today is 2026-11-13 (Europe/Amsterdam)."));
        assert!(system.ends_with("Looking at a ticket"));
    }

    #[test]
    fn a_tool_needs_every_permission_it_declares() {
        let tasks_only = |key: &str| key.starts_with("tasks:");
        let ids: Vec<&str> = select_tools(&tasks_only).iter().map(|t| t.id).collect();
        assert_eq!(ids, ["tasks.list"]);
    }
}
