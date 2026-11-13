//! The default WeldAgent (`packages/domains/agent/src/persona.ts`): the chat
//! assistant a person gets without picking a workspace agent.
//!
//! It has no agent row and so no grants. What it may read comes from the
//! person chatting: each read tool is offered only when that person's own
//! permissions cover it, and reads stay inside their row-level scope.
//!
//! The spreadsheet tools (`sheets.*`) are not in the EU tool registry yet
//! ([`crate::tools::LEFT_OUT`]), so the persona offers none and the open
//! sheet is not described, as on Global for a caller without them.

use tokio::sync::mpsc;
use weldsuite_ai::{
    Ai, AiCall, AiError, ChatRequest, Message, Part, Role, Served, StreamEvent, ToolCall,
    ToolChoice, Usage,
};
use weldsuite_flow_domain::day_bounds::workspace_timezone;

use crate::Caller;
use crate::tools::{ToolContext, ToolRowScope, ToolSpec, execute_tool, platform_tools, tool_defs};

/// Stands in for the agent id the tools attribute work to.
pub(super) const PERSONA_AGENT_ID: &str = "agt_weldagent_default";

/// Model requests one reply may take: a few lookups, then the answer.
pub(super) const MAX_STEPS: usize = 6;

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
) -> String {
    let has = |id: &str| tools.iter().any(|tool| tool.id == id);
    let mut sections = vec![BASE_INSTRUCTIONS.to_owned()];

    let lookups: Vec<String> = GUIDE_BY_TOOL
        .iter()
        .filter(|(id, _)| has(id))
        .map(|(_, line)| format!("- {line}"))
        .collect();
    if lookups.is_empty() {
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
) -> Persona {
    let holds = |key: &str| caller.permissions.has_any(&[key]);
    let tools = select_tools(&holds);
    let mut timezone = timezone;
    if !tools.is_empty() && timezone.is_none() {
        timezone = workspace_timezone(&caller.db).await.unwrap_or(None);
    }
    // The keys the persona's tools need that this person holds, checked
    // deny-aware like any route (`personaPermissions`).
    let mut held: Vec<String> = Vec::new();
    for key in platform_tools()
        .iter()
        .filter(|tool| TOOL_IDS.contains(&tool.id))
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
    };
    Persona {
        system: build_system(
            &tools,
            extra_system,
            &today_in(timezone.as_deref()),
            timezone.as_deref(),
        ),
        tools,
        ctx,
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
        let (content, is_error) = if self.tools.iter().any(|tool| tool.name == call.name) {
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
    for step in 1..=MAX_STEPS {
        let answer = ai
            .chat(call, persona.request(&messages, temperature, max_tokens))
            .await?;
        add(&mut usage, answer.usage);
        credits += answer.credits;
        if answer.tool_calls.is_empty() || step == MAX_STEPS {
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
    'steps: for step in 1..=MAX_STEPS {
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
        if gone || answer.tool_calls.is_empty() || step == MAX_STEPS {
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
        let system = build_system(&[], None, "2026-11-13", None);
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
