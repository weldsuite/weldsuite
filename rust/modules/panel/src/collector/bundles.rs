//! `routes/script.ts`: `GET /s.js` (the browser SDK), `GET /rec.js` (its
//! recording plugin) and `GET /v.js` (its web vitals plugin), the same
//! bundles for every project, cacheable for an hour with a strong
//! validator. The core loads `/rec.js` only when the visitor consented, the
//! session is sampled, `GET /c/:token` says recording isn't blocked and the
//! page isn't excluded; `/v.js` on every page unless the site turned web
//! vitals off.
//!
//! The bundles are `pnpm --filter @weldsuite/panel-sdk build`'s
//! `dist/panel.global.js`, `dist/panel-recorder.global.js` and
//! `dist/panel-vitals.global.js`, which the image carries under
//! `/srv/panel` (`PANEL_SDK_FILE`, `PANEL_RECORDER_FILE`,
//! `PANEL_VITALS_FILE`).

use std::sync::Arc;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use http::header::CONTENT_TYPE;
use http::{HeaderMap, StatusCode};
use sha2::{Digest, Sha256};

use super::{CollectorState, Ctx, reject};

/// One bundle and its strong validator.
#[derive(Debug, Clone)]
pub struct ScriptBundle {
    text: String,
    etag: String,
}

impl ScriptBundle {
    /// The bundle at `path`, or `None` when it can't be read.
    pub fn load(path: &str) -> Option<Self> {
        let text = std::fs::read_to_string(path).ok()?;
        let digest = hex::encode(Sha256::digest(text.as_bytes()));
        Some(Self {
            etag: format!("\"{}\"", &digest[..32]),
            text,
        })
    }
}

/// The three bundles the collector serves, each one it could read.
#[derive(Debug, Clone, Default)]
pub struct Bundles {
    pub sdk: Option<Arc<ScriptBundle>>,
    pub recorder: Option<Arc<ScriptBundle>>,
    pub vitals: Option<Arc<ScriptBundle>>,
}

impl Bundles {
    /// The bundles at these paths.
    pub fn load(sdk: &str, recorder: &str, vitals: &str) -> Self {
        let load = |path: &str| ScriptBundle::load(path).map(Arc::new);
        Self {
            sdk: load(sdk),
            recorder: load(recorder),
            vitals: load(vitals),
        }
    }
}

/// Which bundle a route serves.
#[derive(Debug, Clone, Copy)]
enum Script {
    Sdk,
    Recorder,
    Vitals,
}

impl Script {
    /// Where a conformance test's env names the file.
    const fn env(self) -> &'static str {
        match self {
            Self::Sdk => "PANEL_SDK_FILE",
            Self::Recorder => "PANEL_RECORDER_FILE",
            Self::Vitals => "PANEL_VITALS_FILE",
        }
    }

    const fn missing(self) -> &'static str {
        match self {
            Self::Sdk => "The WeldPanel SDK bundle is not installed on this server",
            Self::Recorder => "The WeldPanel recording plugin is not installed on this server",
            Self::Vitals => "The WeldPanel web vitals plugin is not installed on this server",
        }
    }

    fn of(self, bundles: &Bundles) -> Option<Arc<ScriptBundle>> {
        match self {
            Self::Sdk => bundles.sdk.clone(),
            Self::Recorder => bundles.recorder.clone(),
            Self::Vitals => bundles.vitals.clone(),
        }
    }
}

/// `If-None-Match` is a list of validators or `*`; weak ones compare equal for GET.
fn matches_etag(header: Option<&str>, current: &str) -> bool {
    let Some(header) = header else {
        return false;
    };
    if header.trim() == "*" {
        return true;
    }
    header.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate.strip_prefix("W/").unwrap_or(candidate) == current
    })
}

fn serve(state: &CollectorState, ctx: &Ctx, headers: &HeaderMap, script: Script) -> Response {
    let bundle = if ctx.conformance() {
        ctx.env(script.env())
            .and_then(|path| ScriptBundle::load(&path))
            .map(Arc::new)
    } else {
        script.of(&state.bundles)
    };
    let Some(bundle) = bundle else {
        return reject(StatusCode::NOT_FOUND, "not_found", script.missing());
    };
    let cache_headers = [
        ("cache-control", "public, max-age=3600".to_owned()),
        ("etag", bundle.etag.clone()),
    ];
    let if_none_match = headers
        .get("if-none-match")
        .and_then(|value| value.to_str().ok());
    if matches_etag(if_none_match, &bundle.etag) {
        return (StatusCode::NOT_MODIFIED, cache_headers).into_response();
    }
    (
        StatusCode::OK,
        cache_headers,
        [(CONTENT_TYPE, "application/javascript; charset=utf-8")],
        bundle.text.clone(),
    )
        .into_response()
}

/// `GET /s.js`.
pub(super) async fn sdk(
    State(state): State<CollectorState>,
    ctx: Ctx,
    headers: HeaderMap,
) -> Response {
    serve(&state, &ctx, &headers, Script::Sdk)
}

/// `GET /rec.js`.
pub(super) async fn recorder(
    State(state): State<CollectorState>,
    ctx: Ctx,
    headers: HeaderMap,
) -> Response {
    serve(&state, &ctx, &headers, Script::Recorder)
}

/// `GET /v.js`.
pub(super) async fn vitals(
    State(state): State<CollectorState>,
    ctx: Ctx,
    headers: HeaderMap,
) -> Response {
    serve(&state, &ctx, &headers, Script::Vitals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validators_match_weakly_in_lists_and_star() {
        let etag = "\"0123\"";
        assert!(matches_etag(Some("\"0123\""), etag));
        assert!(matches_etag(Some("W/\"0123\""), etag));
        assert!(matches_etag(Some("\"other\", \"0123\""), etag));
        assert!(matches_etag(Some(" * "), etag));
        assert!(!matches_etag(Some("\"stale\""), etag));
        assert!(!matches_etag(None, etag));
    }
}
