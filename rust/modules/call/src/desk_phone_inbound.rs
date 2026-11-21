//! What an inbound call to a WeldDesk phone number does, per its route
//! (`services/desk-phone-inbound.ts`): `forward`, `ai_agent`, `agents` (ring
//! the team), `voicemail`, `menu` (a keypad menu in front of the others) or
//! hang up. The queue, ringing and voicemail steps live in
//! `desk_phone_queue` and `desk_phone_legs`.

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;

use crate::crm;
use crate::desk_phone::{lookup_crm_tool, now_seconds, tool_url_for};
use crate::desk_phone_messages::{append, fanout, meta, post_phone_message};
use crate::desk_phone_options::{
    self, MenuChoice, PHONE_VOICE, RouteOptions, invalid_choice_prompt,
};
use crate::desk_phone_queue::{
    CallEventInput, Flow, as_string, flow_of, start_agents_flow, start_voicemail,
};
use crate::desk_phone_ring::{Call, Phone, load_call};
use crate::telnyx::{AssistantStart, Gather, Speech, transfer_tool};
use crate::tool_auth::{self, Claims};

/// `matchCallerSafe(db, fromNumber)`: who is calling, or nobody when the
/// CRM cannot be asked.
pub(crate) async fn match_caller_safe(db: &PgPool, from_number: &str) -> crm::Caller {
    match crm::match_caller(db, from_number).await {
        Ok(caller) => caller,
        Err(error) => {
            tracing::error!(%error, "[Telnyx Webhook] CRM caller match failed");
            crm::Caller::default()
        }
    }
}

/// `callerContextInstructions(args)`.
fn caller_instructions(system_prompt: &str, phone: &str, caller: &crm::Caller) -> String {
    let mut lines = vec![
        weldsuite_kit::validation::js_trim(system_prompt).to_owned(),
        String::new(),
        "## Live call context".to_owned(),
        format!("Caller phone: {phone}"),
    ];
    let present = |value: &Option<String>| {
        value
            .as_deref()
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    if let Some(name) = present(&caller.caller_name) {
        lines.push(format!("Matched name: {name}"));
    }
    if let Some(name) = present(&caller.customer_name) {
        lines.push(format!("Matched customer: {name}"));
    }
    if let Some(id) = present(&caller.contact_id) {
        lines.push(format!("Contact id: {id}"));
    }
    if let Some(id) = present(&caller.customer_id) {
        lines.push(format!("Customer id: {id}"));
    }
    lines.push("Greet the caller by name when a match is present. Use the lookup_crm tool to search CRM if they mention another person or company, or if no match is listed above. Do not invent account details that the tool did not return. If they need a human, transfer them.".to_owned());
    lines.join("\n")
}

/// A voice agent: `(id, name, systemPrompt, enabled, telnyxAssistantId,
/// forwardToE164)`.
type AgentRow = (String, String, String, bool, Option<String>, Option<String>);

/// A number's inbound route (`PhoneRouteRow`), as the call's first event
/// reads it.
#[derive(Debug, Clone, Default)]
pub(crate) struct Route {
    pub(crate) action: String,
    pub(crate) voice_agent_id: Option<String>,
    pub(crate) forward_to_e164: Option<String>,
    pub(crate) options: Option<Value>,
}

/// `InboundCallContext`.
pub(crate) struct InboundCall<'a> {
    pub(crate) flow: Flow<'a>,
    /// The `client_state` of the route's first command (the one a plain
    /// `ai_agent` or `forward` route sends).
    pub(crate) client_state: String,
    pub(crate) to_number: &'a str,
    pub(crate) from_number: &'a str,
    pub(crate) caller: crm::Caller,
    /// `phoneRow.enableRecording !== false`.
    pub(crate) record: bool,
}

impl InboundCall<'_> {
    fn phone(&self) -> &Phone<'_> {
        &self.flow.phone
    }

    /// The conversation an inbound call always has; without one the append
    /// finds nothing, as the worker's does.
    fn conversation(&self) -> &str {
        self.flow.conversation_id.unwrap_or_default()
    }

    /// `forwardInboundCall(ctx, forwardToE164, clientState)`.
    async fn forward(&self, to: &str, client_state: &str) -> Result<(), String> {
        self.phone()
            .telnyx
            .transfer(
                self.flow.call_control_id,
                to,
                Some(client_state),
                Some(self.to_number),
            )
            .await
            .map_err(|e| e.to_string())?;
        append(
            self.phone().db,
            self.conversation(),
            "message",
            "system",
            None,
            format!("Forwarding call to {to}"),
            meta(json!({ "event": "call_forwarded", "forwardToE164": to, "callId": self.flow.call_id })),
        )
        .await?;
        Ok(())
    }

    /// `hangupCallWithoutRoute(ctx)`.
    async fn hangup_without_route(&self) -> Result<(), String> {
        self.phone()
            .telnyx
            .hangup(self.flow.call_control_id, Some(&self.client_state))
            .await
            .map_err(|e| e.to_string())?;
        append(
            self.phone().db,
            self.conversation(),
            "message",
            "system",
            None,
            "Call ended (no inbound route configured)".to_owned(),
            meta(json!({ "event": "call_hangup_no_route", "callId": self.flow.call_id })),
        )
        .await?;
        Ok(())
    }

    /// `buildAiAgentTools(ctx, agent)`: the assistant's tools for this call,
    /// or none without a Telnyx key to sign the tool token with.
    fn ai_agent_tools(&self, agent_id: &str, forward: Option<&str>) -> Option<Vec<Value>> {
        let phone = self.phone();
        let key = phone.telnyx.api_key()?;
        let token = tool_auth::sign(
            key,
            &Claims {
                org: phone.workspace.to_owned(),
                aid: agent_id.to_owned(),
                call: Some(self.flow.call_id.to_owned()),
                conv: self.flow.conversation_id.map(str::to_owned),
            },
            now_seconds(),
        );
        let mut tools = vec![
            json!({ "type": "hangup" }),
            lookup_crm_tool(&tool_url_for(phone.env), &format!("Bearer {token}")),
        ];
        if let Some(forward) = forward.filter(|f| !f.is_empty()) {
            tools.push(transfer_tool(forward));
        }
        Some(tools)
    }

    /// `answerWithAiAgent(ctx, voiceAgentId, { alreadyAnswered, clientState })`.
    async fn ai_agent(
        &self,
        agent_id: &str,
        already_answered: bool,
        client_state: &str,
    ) -> Result<(), String> {
        let phone = self.phone();
        let control = self.flow.call_control_id;
        let agent: Option<AgentRow> = sqlx::query_as(
            "select id, name, system_prompt, enabled, telnyx_assistant_id, forward_to_e164
             from desk_voice_agents where id = $1 and deleted_at is null limit 1",
        )
        .bind(agent_id)
        .fetch_optional(phone.db)
        .await
        .map_err(|e| e.to_string())?;
        let Some((id, name, system_prompt, _, Some(assistant), forward)) =
            agent.filter(|(_, _, _, enabled, assistant, _)| {
                *enabled && assistant.as_deref().is_some_and(|a| !a.is_empty())
            })
        else {
            tracing::warn!(agent_id, "[Telnyx Webhook] Voice agent unavailable, hangup");
            phone
                .telnyx
                .hangup(control, Some(client_state))
                .await
                .map_err(|e| e.to_string())?;
            return Ok(());
        };
        let tools = self.ai_agent_tools(&id, forward.as_deref());
        let mut variables = Map::new();
        variables.insert("caller_phone".to_owned(), json!(self.from_number));
        if let Some(name) = self.caller.caller_name.as_deref().filter(|n| !n.is_empty()) {
            variables.insert("caller_name".to_owned(), json!(name));
        }
        if let Some(name) = self
            .caller
            .customer_name
            .as_deref()
            .filter(|n| !n.is_empty())
        {
            variables.insert("customer_name".to_owned(), json!(name));
        }
        if !already_answered {
            phone
                .telnyx
                .answer(control, Some(client_state))
                .await
                .map_err(|e| e.to_string())?;
        }
        phone
            .telnyx
            .ai_assistant_start(
                control,
                &assistant,
                AssistantStart {
                    client_state: client_state.to_owned(),
                    instructions: caller_instructions(
                        &system_prompt,
                        self.from_number,
                        &self.caller,
                    ),
                    tools,
                    dynamic_variables: Some(variables),
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        if self.record
            && let Err(error) = phone.telnyx.record_start(control).await
        {
            tracing::error!(%error, "[Telnyx Webhook] record_start failed");
        }
        let body = match self.caller.caller_name.as_deref().filter(|n| !n.is_empty()) {
            Some(matched) => format!("AI agent “{name}” answered the call (matched {matched})"),
            None => format!("AI agent “{name}” answered the call"),
        };
        let (conversation, message) = append(
            phone.db,
            self.conversation(),
            "message",
            "bot",
            Some(&id),
            body,
            meta(json!({
                "event": "ai_answered",
                "voiceAgentId": id,
                "callId": self.flow.call_id,
                "contactId": self.caller.contact_id,
                "customerId": self.caller.customer_id,
            })),
        )
        .await?;
        fanout(phone.state, phone.workspace, &conversation, &message, true).await;
        Ok(())
    }

    // ── Keypad menu ─────────────────────────────────────────────────────────

    /// `startMenu(ctx, options)`: answer, then speak the prompt and collect
    /// one digit.
    async fn start_menu(&self, options: &RouteOptions) -> Result<(), String> {
        let Some(menu) = &options.menu else {
            return self.hangup_without_route().await;
        };
        let telnyx = self.phone().telnyx;
        let control = self.flow.call_control_id;
        telnyx
            .answer(control, Some(&self.flow.state(&[])))
            .await
            .map_err(|e| e.to_string())?;
        let valid_digits: String = menu.choices.iter().map(|c| c.digit.as_str()).collect();
        let state = self.flow.state(&[("stage", "menu")]);
        telnyx
            .gather_using_speak(
                control,
                Gather {
                    payload: &menu.prompt,
                    speech: Speech {
                        voice: PHONE_VOICE,
                        language: &options.language,
                        client_state: Some(&state),
                    },
                    minimum_digits: 1,
                    maximum_digits: 1,
                    maximum_tries: 2,
                    timeout_millis: 8000,
                    valid_digits: &valid_digits,
                    invalid_payload: invalid_choice_prompt(&options.language),
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// `runMenuChoice(ctx, choice, options)`.
    async fn run_menu_choice(
        &self,
        choice: &MenuChoice,
        options: &RouteOptions,
    ) -> Result<(), String> {
        let telnyx = self.phone().telnyx;
        let control = self.flow.call_control_id;
        let given = |value: &Option<String>| value.clone().filter(|text| !text.is_empty());
        match choice.action.as_str() {
            "ai_agent" => {
                let Some(agent) = given(&choice.voice_agent_id) else {
                    telnyx
                        .hangup(control, None)
                        .await
                        .map_err(|e| e.to_string())?;
                    return Ok(());
                };
                let state = self.flow.state(&[("voiceAgentId", &agent)]);
                self.ai_agent(&agent, true, &state).await
            }
            "forward" => {
                let Some(to) = given(&choice.forward_to_e164) else {
                    telnyx
                        .hangup(control, None)
                        .await
                        .map_err(|e| e.to_string())?;
                    return Ok(());
                };
                self.forward(&to, &self.flow.state(&[])).await
            }
            "agents" => {
                start_agents_flow(&self.flow, true, options, choice.department_id.as_deref()).await
            }
            "voicemail" => start_voicemail(&self.flow, true, false, options).await,
            _ => Ok(()),
        }
    }
}

/// `menuChoiceAlreadyRecorded(db, conversationId, callId)`.
async fn menu_choice_already_recorded(
    db: &PgPool,
    conversation_id: &str,
    call_id: &str,
) -> Result<bool, String> {
    let recorded: Option<String> = sqlx::query_scalar(
        "select id from desk_messages
         where conversation_id = $1 and metadata->>'event' = 'menu_choice'
           and metadata->>'callId' = $2
         limit 1",
    )
    .bind(conversation_id)
    .bind(call_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(recorded.is_some())
}

/// `inboundContextOf(env, db, workspaceId, call)`: the inbound context of a
/// call row, for events after the first (a menu choice).
async fn inbound_context_of<'a>(
    phone: Phone<'a>,
    call: &'a Call,
) -> Result<Option<InboundCall<'a>>, String> {
    let Some(flow) = flow_of(phone, call) else {
        return Ok(None);
    };
    let phone_row: Option<Option<bool>> = sqlx::query_scalar(
        "select enable_recording from voip_phone_numbers
         where phone_number = $1 and deleted_at is null limit 1",
    )
    .bind(&call.to_number)
    .fetch_optional(phone.db)
    .await
    .map_err(|e| e.to_string())?;
    let Some(enable_recording) = phone_row else {
        return Ok(None);
    };
    Ok(Some(InboundCall {
        flow,
        client_state: flow.state(&[]),
        to_number: &call.to_number,
        from_number: &call.from_number,
        caller: match_caller_safe(phone.db, &call.from_number).await,
        record: enable_recording != Some(false),
    }))
}

/// `handleGatherEnded(ev)`: `call.gather.ended` of the menu prompt. Run the
/// pressed choice; for a key that is not on the menu, or nothing pressed,
/// the fallback choice, else hang up.
pub(crate) async fn handle_gather_ended(ev: &CallEventInput<'_>) -> Result<(), String> {
    if ev.stage() != Some("menu") {
        return Ok(());
    }
    let status = as_string(&ev.payload["status"]);
    if matches!(status, Some("call_hangup" | "cancelled")) {
        return Ok(());
    }
    let db = ev.phone.db;
    let Some(call) = load_call(db, ev.call_id).await? else {
        return Ok(());
    };
    let Some(inbound) = inbound_context_of(ev.phone, &call).await? else {
        return Ok(());
    };
    let options = desk_phone_options::for_number(db, &call.to_number)
        .await
        .map_err(|e| e.to_string())?;
    let digits = as_string(&ev.payload["digits"]).map(weldsuite_kit::validation::js_trim);
    if let Err(error) = run_gathered(&inbound, &options, status, digits).await {
        tracing::error!(%error, "[Telnyx Webhook] Menu choice failed");
        let _ = ev
            .phone
            .telnyx
            .hangup(inbound.flow.call_control_id, None)
            .await;
    }
    Ok(())
}

/// The body of [`handle_gather_ended`] the worker runs in its `try`.
async fn run_gathered(
    inbound: &InboundCall<'_>,
    options: &RouteOptions,
    status: Option<&str>,
    digits: Option<&str>,
) -> Result<(), String> {
    let phone = inbound.phone();
    let flow = &inbound.flow;
    let hangup = || async {
        phone
            .telnyx
            .hangup(flow.call_control_id, None)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    };
    let Some(menu) = &options.menu else {
        return hangup().await;
    };
    let pressed = match (status, digits) {
        (Some("valid"), Some(digits)) if !digits.is_empty() => menu.choice(digits),
        _ => None,
    };
    let fallback = pressed.is_none();
    let choice = pressed.or_else(|| {
        menu.fallback_digit
            .as_deref()
            .filter(|digit| !digit.is_empty())
            .and_then(|digit| menu.choice(digit))
    });
    let Some(choice) = choice else {
        post_phone_message(
            phone,
            flow.conversation_id,
            "Caller made no menu choice".to_owned(),
            json!({ "event": "menu_no_choice", "callId": flow.call_id }),
        )
        .await;
        return hangup().await;
    };
    // A retried event finds the choice written already.
    if let Some(conversation_id) = flow.conversation_id
        && menu_choice_already_recorded(phone.db, conversation_id, flow.call_id).await?
    {
        return Ok(());
    }
    let label = choice
        .label
        .as_deref()
        .map(weldsuite_kit::validation::js_trim)
        .filter(|label| !label.is_empty());
    let named = match label {
        Some(label) => format!("{} ({label})", choice.digit),
        None => choice.digit.clone(),
    };
    let mut metadata = meta(json!({
        "event": "menu_choice",
        "callId": flow.call_id,
        "digit": choice.digit,
        "label": label,
        "action": choice.action,
    }));
    if fallback {
        metadata.insert("fallback".to_owned(), json!(true));
    }
    post_phone_message(
        phone,
        flow.conversation_id,
        if fallback {
            format!("No valid choice, continuing with {named}")
        } else {
            format!("Caller chose {named}")
        },
        Value::Object(metadata),
    )
    .await;
    inbound.run_menu_choice(choice, options).await
}

// ── The route ───────────────────────────────────────────────────────────────

/// `executeInboundRoute(ctx, route)`: what the number's route does with the
/// call; a step that fails hangs the call up.
pub(crate) async fn execute_route(inbound: &InboundCall<'_>, route: Option<&Route>) {
    let action = route.map_or("hangup", |route| route.action.as_str());
    let options = desk_phone_options::resolve(route.and_then(|route| route.options.as_ref()));
    let forward = route
        .and_then(|route| route.forward_to_e164.as_deref())
        .filter(|to| !to.is_empty());
    let voice_agent = route
        .and_then(|route| route.voice_agent_id.as_deref())
        .filter(|agent| !agent.is_empty());
    let executed = match (action, forward, voice_agent) {
        ("forward", Some(to), _) => inbound.forward(to, &inbound.client_state).await,
        ("ai_agent", _, Some(agent)) => inbound.ai_agent(agent, false, &inbound.client_state).await,
        ("agents", _, _) => {
            start_agents_flow(
                &inbound.flow,
                false,
                &options,
                options.department_id.as_deref(),
            )
            .await
        }
        ("voicemail", _, _) => start_voicemail(&inbound.flow, false, false, &options).await,
        ("menu", _, _) if options.menu.is_some() => inbound.start_menu(&options).await,
        _ => inbound.hangup_without_route().await,
    };
    if let Err(error) = executed {
        tracing::error!(%error, "[Telnyx Webhook] Inbound route execution failed");
        let _ = inbound
            .phone()
            .telnyx
            .hangup(inbound.flow.call_control_id, Some(&inbound.client_state))
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_assistant_is_told_who_is_calling() {
        let caller = crm::Caller {
            contact_id: Some("crmc_1".to_owned()),
            caller_name: Some("Ann".to_owned()),
            ..crm::Caller::default()
        };
        let text = caller_instructions("  Be kind.  ", "+31612340001", &caller);
        assert!(text.starts_with("Be kind.\n\n## Live call context\nCaller phone: +31612340001\n"));
        assert!(text.contains("Matched name: Ann\nContact id: crmc_1\nGreet the caller"));
        assert!(!text.contains("Matched customer"));
    }
}
