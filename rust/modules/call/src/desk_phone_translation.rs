//! `/api/desk/phone/calls/:callId/translation`
//! (`routes/desk-phone/translation.ts`): live spoken translation of a call.
//!
//! On Global it runs on `@weldsuite/ai` (`services/desk-phone-translation.ts`:
//! Telnyx transcribes both legs, each line is translated by a model and
//! charged in AI credits). The Kubernetes editions have no AI provider (ADR
//! AI-011), so a translation cannot be started, changed or stopped here: the
//! three writing routes answer 503 `ai_unavailable` behind the worker's
//! `conversations:update`, and `/config.json` lists `desk-ai` as unavailable
//! so the platform hides the control. The service is not ported.
//!
//! ```text
//! GET    /:callId/translation   conversations:read    the stored state, or null
//! POST   /:callId/translation   conversations:update  503 ai_unavailable
//! PATCH  /:callId/translation   conversations:update  503 ai_unavailable
//! DELETE /:callId/translation   conversations:update  503 ai_unavailable
//! ```
//!
//! `GET` reads `voip_calls.translation` as the worker does: null on this
//! backend, or what a call carried when its workspace came from Global. The
//! routes are left out of the conformance suite (`excludedRoutes` of "call:
//! desk phone and the Telnyx webhook"); the webhook accepts and drops
//! `call.transcription` lines, and a hangup has no translation to stop
//! (`webhook`).

use axum::extract::Path;
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_db::orm;
use weldsuite_kit::{ApiError, Data};
use weldsuite_schema::tenant::voip_calls;

use crate::{Caller, internal, js};

/// `CALL_TRANSLATION_LANGUAGES` with a Telnyx `speak` locale: the languages
/// the agent's words can be spoken in (Ukrainian, `uk`, is captions-only).
const SPOKEN_LANGUAGES: [&str; 19] = [
    "en", "nl", "de", "fr", "es", "it", "pt", "pl", "tr", "ar", "ru", "ro", "sv", "da", "nb", "hi",
    "zh", "ja", "ko",
];

/// `callTranslationTtsLocale(tag) !== null`: a voice exists for the language
/// (`pt-BR` reads as `pt`, `no` as `nb`).
fn speak_available(tag: &Value) -> bool {
    let Some(tag) = tag.as_str() else {
        return false;
    };
    let lowered = weldsuite_kit::validation::js_trim(tag).to_lowercase();
    let primary = lowered.split('-').next().unwrap_or_default();
    let code = if primary == "no" { "nb" } else { primary };
    SPOKEN_LANGUAGES.contains(&code)
}

/// `toTranslationState(callId, t)` of a stored `voip_calls.translation`.
fn translation_state(call_id: &str, translation: &Value) -> Value {
    let mut state = Map::new();
    state.insert("callId".to_owned(), json!(call_id));
    state.insert(
        "active".to_owned(),
        json!(!js::truthy(&translation["stoppedAt"])),
    );
    state.insert(
        "speakAvailable".to_owned(),
        json!(speak_available(&translation["callerLanguage"])),
    );
    // A key the stored value lacks is left out, as `JSON.stringify` drops
    // `undefined`.
    for key in [
        "callerLanguage",
        "agentLanguage",
        "speakToCaller",
        "startedAt",
        "startedById",
        "stoppedAt",
    ] {
        if let Some(value) = translation.get(key) {
            state.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(state)
}

/// `GET /api/desk/phone/calls/:callId/translation`: the stored state, or
/// null before any.
pub(crate) async fn state(caller: Caller, Path(call_id): Path<String>) -> Response {
    let stored: Result<Option<Option<Value>>, DbErr> = voip_calls::Entity::find()
        .select_only()
        .column(voip_calls::Column::Translation)
        .filter(voip_calls::Column::Id.eq(&call_id))
        .limit(1)
        .into_tuple()
        .one(&orm(&caller.db))
        .await;
    match stored {
        Ok(Some(translation)) => {
            // `call.translation ? toTranslationState(call.id, call.translation) : null`.
            let state = translation
                .filter(js::truthy)
                .map_or(Value::Null, |stored| translation_state(&call_id, &stored));
            Data(state).into_response()
        }
        Ok(None) => ApiError::not_found("Call", Some(&call_id)).into_response(),
        Err(error) => internal(&error, "An unexpected error occurred"),
    }
}

/// `POST`, `PATCH` and `DELETE /api/desk/phone/calls/:callId/translation`:
/// what the worker answers without the AI gateway. There is no AI to
/// translate with, so nothing is started and nothing runs to change or stop.
pub(crate) async fn unavailable() -> Response {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "ai_unavailable",
        "AI is currently unavailable",
    )
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn translation_is_unavailable_without_ai() {
        let response = unavailable().await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the body reads");
        let body: Value = serde_json::from_slice(&bytes).expect("the body is JSON");
        assert_eq!(
            body,
            json!({ "error": { "code": "ai_unavailable", "message": "AI is currently unavailable" } })
        );
    }

    #[test]
    fn a_stored_translation_reads_like_the_workers_state() {
        let stored = json!({
            "callerLanguage": "nl",
            "agentLanguage": "en",
            "speakToCaller": true,
            "agentLegId": "cc-agent",
            "startedAt": "2026-10-10T09:59:00.000Z",
            "startedById": "user_anna",
            "stoppedAt": null,
        });
        assert_eq!(
            translation_state("vcall_1", &stored),
            json!({
                "callId": "vcall_1",
                "active": true,
                "callerLanguage": "nl",
                "agentLanguage": "en",
                "speakToCaller": true,
                "speakAvailable": true,
                "startedAt": "2026-10-10T09:59:00.000Z",
                "startedById": "user_anna",
                "stoppedAt": null,
            })
        );
        let mut stopped = stored;
        stopped["stoppedAt"] = json!("2026-10-10T10:05:00.000Z");
        stopped["callerLanguage"] = Value::Null;
        let state = translation_state("vcall_1", &stopped);
        assert_eq!(state["active"], false);
        assert_eq!(state["speakAvailable"], false);
        // A voice exists for most languages; Ukrainian is captions-only.
        assert!(speak_available(&json!("pt-BR")));
        assert!(speak_available(&json!(" NO ")));
        assert!(!speak_available(&json!("uk")));
        assert!(!speak_available(&json!("xx")));
    }
}
