//! The routes end to end, on the in-memory provider.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use http::header::{CONTENT_TYPE, COOKIE, SET_COOKIE};
use http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use weldsuite_ports::{MemoryCache, MemorySignIn, Prompt, RecordingSystemMail, SignInSettings};

use crate::{SignInState, router};

const PASSWORD: &str = "Secret123";

struct Harness {
    provider: Arc<MemorySignIn>,
    app: Router,
    /// The system mail, when WeldSuite emails the codes.
    mail: Option<Arc<RecordingSystemMail>>,
    /// The browser's `Accept-Language`.
    language: Option<&'static str>,
}

struct Reply {
    status: StatusCode,
    body: Value,
    /// `name=value` of the `Set-Cookie`, when the answer set one.
    cookie: Option<String>,
    /// The cookie was expired.
    cleared: bool,
}

impl Reply {
    fn step(&self) -> &str {
        self.body["data"]["status"].as_str().unwrap_or_default()
    }

    fn error(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or_default()
    }
}

fn harness() -> Harness {
    built(Some("https://app.test/"), None, None)
}

/// With system mail: WeldSuite emails the codes in its own templates.
fn mailing_harness(language: Option<&'static str>) -> Harness {
    built(
        Some("https://app.test/"),
        Some(Arc::new(RecordingSystemMail::new())),
        language,
    )
}

fn built(
    platform_url: Option<&str>,
    mail: Option<Arc<RecordingSystemMail>>,
    language: Option<&'static str>,
) -> Harness {
    let provider = Arc::new(MemorySignIn::new());
    provider.set_settings(SignInSettings {
        allow_register: true,
        ..SignInSettings::default()
    });
    let state = SignInState::new(
        Arc::clone(&provider) as _,
        Arc::new(MemoryCache::new()),
        platform_url,
        1,
    )
    .with_mail(mail.clone().map(|mail| mail as _));
    Harness {
        provider,
        app: router(state),
        mail,
        language,
    }
}

impl Harness {
    /// What WeldSuite emailed, oldest first: (to, subject, text).
    fn mailed(&self) -> Vec<(String, String, String)> {
        self.mail
            .as_ref()
            .map(|mail| {
                mail.sent()
                    .into_iter()
                    .map(|sent| (sent.to[0].email.clone(), sent.subject, sent.text))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The emails sent, once there are `count`: the reset email goes out
    /// after the answer.
    async fn mailed_after(&self, count: usize) -> Vec<(String, String, String)> {
        for _ in 0..100 {
            let mailed = self.mailed();
            if mailed.len() >= count {
                return mailed;
            }
            tokio::task::yield_now().await;
        }
        self.mailed()
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> Reply {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "app.test")
            .header("x-forwarded-for", "203.0.113.9");
        if let Some(language) = self.language {
            request = request.header("accept-language", language);
        }
        if let Some(cookie) = cookie {
            request = request.header(COOKIE, cookie);
        }
        let request = match body {
            Some(body) => request
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .expect("request");
        let response = self.app.clone().oneshot(request).await.expect("response");
        let status = response.status();
        let set_cookie = response
            .headers()
            .get(SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        Reply {
            status,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            cleared: set_cookie
                .as_deref()
                .is_some_and(|cookie| cookie.contains("Max-Age=0")),
            cookie: set_cookie
                .filter(|cookie| !cookie.contains("Max-Age=0"))
                .and_then(|cookie| cookie.split(';').next().map(str::to_owned)),
        }
    }

    async fn post(&self, path: &str, cookie: Option<&str>, body: Value) -> Reply {
        self.send(Method::POST, path, cookie, Some(body)).await
    }

    async fn get(&self, path: &str, cookie: Option<&str>) -> Reply {
        self.send(Method::GET, path, cookie, None).await
    }

    async fn sign_in(&self, request: &str, email: &str, password: &str) -> Reply {
        self.post(
            "/password",
            None,
            json!({ "authRequest": request, "email": email, "password": password }),
        )
        .await
    }

    async fn totp(&self, request: &str, cookie: &str, code: &str) -> Reply {
        self.post(
            "/second-factor",
            Some(cookie),
            json!({ "authRequest": request, "factor": "totp", "code": code }),
        )
        .await
    }
}

#[tokio::test]
async fn a_password_signs_in_and_the_session_answers_the_next_request_without_a_form() {
    let h = harness();
    let user = h.provider.add_user("jane@acme.test", PASSWORD);
    let first = h.provider.add_auth_request(&[]);

    let opened = h.get(&format!("/request?authRequest={first}"), None).await;
    assert_eq!(opened.status, StatusCode::OK);
    assert_eq!(
        opened.body["data"],
        json!({
            "status": "needs_credentials",
            "intent": "sign-in",
            "loginHint": null,
            "allowRegister": true,
            "allowPasswordReset": true,
        })
    );

    let signed_in = h.sign_in(&first, " Jane@Acme.test ", PASSWORD).await;
    assert_eq!(signed_in.step(), "complete");
    assert!(
        signed_in.body["data"]["redirectUrl"]
            .as_str()
            .is_some_and(|url| url.contains(&first))
    );
    assert_eq!(h.provider.completed_for(&first), Some(user.clone()));
    let cookie = signed_in.cookie.expect("session cookie");
    assert!(cookie.starts_with("weldsuite_signin="));

    // Switching workspace: a new auth request, the same browser.
    let second = h.provider.add_auth_request(&[]);
    let switched = h
        .get(&format!("/request?authRequest={second}"), Some(&cookie))
        .await;
    assert_eq!(switched.step(), "complete");
    assert_eq!(h.provider.completed_for(&second), Some(user));
}

#[tokio::test]
async fn a_wrong_password_and_an_unknown_account_get_the_same_answer() {
    let h = harness();
    h.provider.add_user("jane@acme.test", PASSWORD);
    let request = h.provider.add_auth_request(&[]);

    let wrong = h.sign_in(&request, "jane@acme.test", "nope").await;
    let unknown = h.sign_in(&request, "nobody@acme.test", PASSWORD).await;
    for reply in [&wrong, &unknown] {
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        assert_eq!(reply.error(), "INVALID_CREDENTIALS");
        assert!(reply.cookie.is_none());
    }
    assert_eq!(wrong.body, unknown.body);
    assert_eq!(h.provider.completed_for(&request), None);
}

#[tokio::test]
async fn the_authenticator_code_is_due_after_the_password() {
    let h = harness();
    let user = h.provider.add_user("jane@acme.test", PASSWORD);
    h.provider
        .update_user(&user, |user| user.methods.totp = true);
    let request = h.provider.add_auth_request(&[]);

    let after_password = h.sign_in(&request, "jane@acme.test", PASSWORD).await;
    assert_eq!(after_password.step(), "needs_second_factor");
    assert_eq!(after_password.body["data"]["factors"], json!(["totp"]));
    assert_eq!(h.provider.completed_for(&request), None);
    let cookie = after_password.cookie.expect("session cookie");

    // A reload shows the same step, and nothing is finished without the code.
    let reloaded = h
        .get(&format!("/request?authRequest={request}"), Some(&cookie))
        .await;
    assert_eq!(reloaded.step(), "needs_second_factor");

    let wrong = h
        .post(
            "/second-factor",
            Some(&cookie),
            json!({ "authRequest": request, "factor": "totp", "code": "000000" }),
        )
        .await;
    assert_eq!(wrong.status, StatusCode::BAD_REQUEST);
    assert_eq!(wrong.error(), "INVALID_CODE");

    let right = h
        .post(
            "/second-factor",
            Some(&cookie),
            json!({ "authRequest": request, "factor": "totp", "code": " 654 321 " }),
        )
        .await;
    assert_eq!(right.step(), "complete");
    assert_eq!(h.provider.completed_for(&request), Some(user));
    // The checked factor changed the session's token: a new cookie.
    assert!(right.cookie.is_some_and(|next| next != cookie));
}

#[tokio::test]
async fn without_an_authenticator_the_second_factor_goes_by_email() {
    let h = harness();
    let user = h.provider.add_user("jane@acme.test", PASSWORD);
    h.provider
        .update_user(&user, |user| user.methods.email_code = true);
    let request = h.provider.add_auth_request(&[]);

    let after_password = h.sign_in(&request, "jane@acme.test", PASSWORD).await;
    assert_eq!(after_password.step(), "needs_second_factor");
    assert_eq!(
        after_password.body["data"]["factors"],
        json!(["email_code"])
    );
    assert_eq!(after_password.body["data"]["email"], "jane@acme.test");
    // The code was emailed with the answer; a reload sends no second one.
    assert_eq!(h.provider.sent(), vec![("second-factor", user.clone())]);
    let cookie = after_password.cookie.expect("session cookie");
    let reloaded = h
        .get(&format!("/request?authRequest={request}"), Some(&cookie))
        .await;
    assert_eq!(reloaded.step(), "needs_second_factor");
    assert_eq!(h.provider.sent().len(), 1);

    // "Resend" does, and hands out the session's new token.
    let resent = h
        .post("/second-factor/email-code", Some(&cookie), json!({}))
        .await;
    assert_eq!(resent.status, StatusCode::NO_CONTENT);
    assert_eq!(h.provider.sent().len(), 2);
    let cookie = resent.cookie.expect("new cookie");

    // Typed in small letters: the provider's codes are capitals.
    let checked = h
        .post(
            "/second-factor",
            Some(&cookie),
            json!({ "authRequest": request, "factor": "email_code", "code": "abc123" }),
        )
        .await;
    assert_eq!(checked.step(), "complete");
    assert_eq!(h.provider.completed_for(&request), Some(user));
}

#[tokio::test]
async fn signing_up_verifies_the_address_before_it_signs_in() {
    let h = harness();
    let request = h.provider.add_auth_request(&[Prompt::Create]);

    let opened = h
        .get(&format!("/request?authRequest={request}"), None)
        .await;
    assert_eq!(opened.body["data"]["intent"], "sign-up");

    let created = h
        .post(
            "/sign-up",
            None,
            json!({
                "authRequest": request,
                "firstName": "Jane",
                "lastName": "Doe",
                "email": "jane@acme.test",
                "password": PASSWORD,
            }),
        )
        .await;
    assert_eq!(created.step(), "needs_email_verification");
    assert_eq!(created.body["data"]["email"], "jane@acme.test");
    assert_eq!(
        created.body["data"]["code"],
        json!({ "length": 6, "charset": "alphanumeric" })
    );
    let user = h
        .provider
        .user_by_email("jane@acme.test")
        .expect("created")
        .user;
    assert!(!user.email_verified);
    assert_eq!(h.provider.sent(), vec![("verify", user.id.clone())]);
    assert_eq!(h.provider.completed_for(&request), None);
    let cookie = created.cookie.expect("session cookie");

    let wrong = h
        .post(
            "/email-verification",
            Some(&cookie),
            json!({ "authRequest": request, "code": "WRONG1" }),
        )
        .await;
    assert_eq!(wrong.error(), "INVALID_CODE");
    assert_eq!(h.provider.completed_for(&request), None);

    let verified = h
        .post(
            "/email-verification",
            Some(&cookie),
            json!({ "authRequest": request, "code": MemorySignIn::CODE }),
        )
        .await;
    assert_eq!(verified.step(), "complete");
    assert_eq!(h.provider.completed_for(&request), Some(user.id));
}

#[tokio::test]
async fn an_address_with_an_account_is_taken_unless_it_is_the_same_person_again() {
    let h = harness();
    let request = h.provider.add_auth_request(&[]);
    let sign_up = |password: &'static str| json!({ "authRequest": request, "email": "jane@acme.test", "password": password });

    let first = h.post("/sign-up", None, sign_up(PASSWORD)).await;
    assert_eq!(first.step(), "needs_email_verification");

    // Back from the code screen and submitted again: the sign-up goes on,
    // with a new code.
    let again = h.post("/sign-up", None, sign_up(PASSWORD)).await;
    assert_eq!(again.step(), "needs_email_verification");
    assert_eq!(h.provider.sent().len(), 2);

    // Somebody else trying the address learns only that it is taken.
    let other = h.post("/sign-up", None, sign_up("Another456")).await;
    assert_eq!(other.status, StatusCode::CONFLICT);
    assert_eq!(other.error(), "EMAIL_TAKEN");

    // So does anybody once the address is verified, password or not.
    h.provider.add_user("joe@acme.test", PASSWORD);
    let verified = h
        .post(
            "/sign-up",
            None,
            json!({ "authRequest": request, "email": "joe@acme.test", "password": PASSWORD }),
        )
        .await;
    assert_eq!(verified.error(), "EMAIL_TAKEN");
}

#[tokio::test(start_paused = true)]
async fn sign_up_waits_for_a_provider_that_does_not_know_the_new_account_yet() {
    let h = harness();
    let request = h.provider.add_auth_request(&[]);
    // The provider's read side trails the write: the first sessions of a new
    // account are refused as if the password were wrong.
    h.provider.lag_new_accounts(3);

    let created = h
        .post(
            "/sign-up",
            None,
            json!({ "authRequest": request, "email": "jane@acme.test", "password": PASSWORD }),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK);
    assert_eq!(created.step(), "needs_email_verification");
    assert!(created.cookie.is_some());
    assert_eq!(h.provider.session_count(), 1);
    // One account, one code: the waiting made nothing twice.
    assert_eq!(h.provider.sent().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_new_account_the_provider_keeps_not_knowing_goes_on_at_sign_in() {
    let h = harness();
    let request = h.provider.add_auth_request(&[]);
    h.provider.lag_new_accounts(u32::MAX);

    let lost = h
        .post(
            "/sign-up",
            None,
            json!({ "authRequest": request, "email": "jane@acme.test", "password": PASSWORD }),
        )
        .await;
    // Not "invalid email or password": the account was made, and the screen
    // sends the person to sign in.
    assert_eq!(lost.status, StatusCode::UNAUTHORIZED);
    assert_eq!(lost.error(), "NO_SESSION");
    assert!(lost.cookie.is_none());
    assert!(h.provider.user_by_email("jane@acme.test").is_some());
    assert_eq!(h.provider.session_count(), 0);
}

#[tokio::test]
async fn sign_up_is_refused_where_the_provider_has_it_closed() {
    let h = harness();
    h.provider.set_settings(SignInSettings::default());
    let request = h.provider.add_auth_request(&[]);

    let refused = h
        .post(
            "/sign-up",
            None,
            json!({ "authRequest": request, "email": "jane@acme.test", "password": PASSWORD }),
        )
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN);
    assert_eq!(refused.error(), "SIGN_UP_DISABLED");
    assert!(h.provider.user_by_email("jane@acme.test").is_none());
}

#[tokio::test]
async fn an_unverified_address_is_asked_for_at_sign_in_and_the_emailed_link_verifies_it() {
    let h = harness();
    let user = h.provider.add_user("jane@acme.test", PASSWORD);
    h.provider
        .update_user(&user, |user| user.user.email_verified = false);
    let request = h.provider.add_auth_request(&[]);

    let after_password = h.sign_in(&request, "jane@acme.test", PASSWORD).await;
    assert_eq!(after_password.step(), "needs_email_verification");
    assert_eq!(h.provider.sent(), vec![("verify", user.clone())]);
    let cookie = after_password.cookie.expect("session cookie");

    // The link in the email, opened anywhere: no session needed.
    let linked = h
        .post(
            "/email-verification/link",
            None,
            json!({ "userId": user, "code": MemorySignIn::CODE }),
        )
        .await;
    assert_eq!(linked.status, StatusCode::NO_CONTENT);

    // Back in the browser that signed in, the sign-in goes on.
    let resumed = h
        .get(&format!("/request?authRequest={request}"), Some(&cookie))
        .await;
    assert_eq!(resumed.step(), "complete");
}

#[tokio::test]
async fn a_password_reset_says_nothing_about_which_addresses_have_accounts() {
    let h = harness();
    let user = h.provider.add_user("jane@acme.test", PASSWORD);

    let unknown = h
        .post(
            "/password-reset",
            None,
            json!({ "email": "nobody@acme.test" }),
        )
        .await;
    let known = h
        .post(
            "/password-reset",
            None,
            json!({ "email": "jane@acme.test" }),
        )
        .await;
    assert_eq!(unknown.status, StatusCode::NO_CONTENT);
    assert_eq!(known.status, StatusCode::NO_CONTENT);
    assert_eq!(h.provider.sent(), vec![("reset", user.clone())]);

    // A wrong code, and a code for an address nobody has, read the same.
    let wrong = h
        .post(
            "/password-reset/confirm",
            None,
            json!({ "email": "jane@acme.test", "code": "WRONG1", "password": "Changed456" }),
        )
        .await;
    let nobody = h
        .post(
            "/password-reset/confirm",
            None,
            json!({ "email": "nobody@acme.test", "code": MemorySignIn::CODE, "password": "Changed456" }),
        )
        .await;
    assert_eq!(wrong.error(), "INVALID_CODE");
    assert_eq!(wrong.body, nobody.body);

    let weak = h
        .post(
            "/password-reset/confirm",
            None,
            json!({ "userId": user, "code": MemorySignIn::CODE, "password": "short" }),
        )
        .await;
    assert_eq!(weak.error(), "WEAK_PASSWORD");

    let reset = h
        .post(
            "/password-reset/confirm",
            None,
            json!({ "email": "jane@acme.test", "code": "abc123", "password": "Changed456" }),
        )
        .await;
    assert_eq!(reset.status, StatusCode::NO_CONTENT);

    let request = h.provider.add_auth_request(&[]);
    assert_eq!(
        h.sign_in(&request, "jane@acme.test", PASSWORD)
            .await
            .error(),
        "INVALID_CREDENTIALS"
    );
    assert_eq!(
        h.sign_in(&request, "jane@acme.test", "Changed456")
            .await
            .step(),
        "complete"
    );
}

#[tokio::test]
async fn a_cookie_that_names_no_session_is_dropped_and_the_form_is_shown() {
    let h = harness();
    h.provider.add_user("jane@acme.test", PASSWORD);
    let first = h.provider.add_auth_request(&[]);
    let cookie = h
        .sign_in(&first, "jane@acme.test", PASSWORD)
        .await
        .cookie
        .expect("session cookie");

    // Signed out: the provider ends the session, the browser drops the cookie.
    let signed_out = h.send(Method::POST, "/sign-out", Some(&cookie), None).await;
    assert_eq!(signed_out.status, StatusCode::NO_CONTENT);
    assert!(signed_out.cleared);
    assert_eq!(h.provider.session_count(), 0);

    // The old cookie, replayed, signs nobody in.
    let second = h.provider.add_auth_request(&[]);
    let replayed = h
        .get(&format!("/request?authRequest={second}"), Some(&cookie))
        .await;
    assert_eq!(replayed.step(), "needs_credentials");
    assert!(replayed.cleared);
    assert_eq!(h.provider.completed_for(&second), None);

    // Nor does a code without a session behind it.
    let orphan = h
        .post(
            "/second-factor",
            None,
            json!({ "authRequest": second, "factor": "totp", "code": MemorySignIn::TOTP }),
        )
        .await;
    assert_eq!(orphan.status, StatusCode::UNAUTHORIZED);
    assert_eq!(orphan.error(), "NO_SESSION");
}

#[tokio::test]
async fn prompt_none_is_answered_without_a_screen() {
    let h = harness();
    let user = h.provider.add_user("jane@acme.test", PASSWORD);

    // Nobody signed in: the request is refused back to the platform.
    let silent = h.provider.add_auth_request(&[Prompt::None]);
    let refused = h.get(&format!("/request?authRequest={silent}"), None).await;
    assert_eq!(refused.step(), "complete");
    assert!(
        refused.body["data"]["redirectUrl"]
            .as_str()
            .is_some_and(|url| url.contains("error=login_required"))
    );
    assert_eq!(h.provider.completed_for(&silent), None);

    // Somebody is: it is answered for them.
    let first = h.provider.add_auth_request(&[]);
    let cookie = h
        .sign_in(&first, "jane@acme.test", PASSWORD)
        .await
        .cookie
        .expect("session cookie");
    let silent = h.provider.add_auth_request(&[Prompt::None]);
    let answered = h
        .get(&format!("/request?authRequest={silent}"), Some(&cookie))
        .await;
    assert_eq!(answered.step(), "complete");
    assert_eq!(h.provider.completed_for(&silent), Some(user));
}

#[tokio::test]
async fn an_auth_request_the_provider_does_not_know_has_expired() {
    let h = harness();
    h.provider.add_user("jane@acme.test", PASSWORD);

    for path in [
        "/request?authRequest=V2_404",
        "/request",
        "/request?authRequest=..%2F..%2Fv2%2Fusers",
    ] {
        let reply = h.get(path, None).await;
        assert_eq!(reply.status, StatusCode::OK, "{path}");
        assert_eq!(reply.step(), "expired", "{path}");
    }
    let reply = h.sign_in("V2_404", "jane@acme.test", PASSWORD).await;
    assert_eq!(reply.step(), "expired");
    assert!(reply.cookie.is_none());
}

#[tokio::test]
async fn an_account_without_a_password_goes_to_the_providers_page() {
    let h = harness();
    let user = h.provider.add_user("jane@acme.test", PASSWORD);
    h.provider.update_user(&user, |user| {
        user.methods.password = false;
        user.methods.passkey = true;
    });
    let request = h.provider.add_auth_request(&[]);

    let reply = h.sign_in(&request, "jane@acme.test", "anything").await;
    assert_eq!(reply.step(), "hosted");
    assert_eq!(
        reply.body["data"]["url"],
        format!("https://id.test/ui/v2/login/login?authRequest={request}")
    );

    // Where the provider hides which accounts exist, so does this.
    h.provider.set_settings(SignInSettings {
        hide_unknown_accounts: true,
        ..SignInSettings::default()
    });
    let hidden = h.sign_in(&request, "jane@acme.test", "anything").await;
    assert_eq!(hidden.error(), "INVALID_CREDENTIALS");
}

#[tokio::test]
async fn password_guesses_are_counted_per_account() {
    let h = harness();
    h.provider.add_user("jane@acme.test", PASSWORD);
    let request = h.provider.add_auth_request(&[]);

    for _ in 0..10 {
        let reply = h.sign_in(&request, "jane@acme.test", "guess").await;
        assert_eq!(reply.error(), "INVALID_CREDENTIALS");
    }
    // The eleventh is not tried, right password or not.
    let limited = h.sign_in(&request, "JANE@acme.test", PASSWORD).await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.error(), "RATE_LIMITED");
    assert_eq!(h.provider.completed_for(&request), None);

    // Another account is not held up by it.
    h.provider.add_user("joe@acme.test", PASSWORD);
    assert_eq!(
        h.sign_in(&request, "joe@acme.test", PASSWORD).await.step(),
        "complete"
    );
}

#[tokio::test]
async fn code_guesses_are_counted_per_account_whatever_the_session() {
    let h = harness();
    let user = h.provider.add_user("jane@acme.test", PASSWORD);
    h.provider
        .update_user(&user, |user| user.methods.totp = true);
    let request = h.provider.add_auth_request(&[]);

    // Ten guesses, over two sessions of the same account: the password
    // again opens a new session, not a new count.
    let mut sessions = Vec::new();
    for _ in 0..2 {
        let signed_in = h.sign_in(&request, "jane@acme.test", PASSWORD).await;
        let cookie = signed_in.cookie.expect("session cookie");
        for _ in 0..5 {
            let wrong = h.totp(&request, &cookie, "000000").await;
            assert_eq!(wrong.error(), "INVALID_CODE");
        }
        sessions.push(cookie);
    }
    assert_ne!(sessions[0], sessions[1]);

    // The eleventh is not tried, in a third session and with the right code.
    let third = h.sign_in(&request, "jane@acme.test", PASSWORD).await;
    let cookie = third.cookie.expect("session cookie");
    let limited = h.totp(&request, &cookie, "654321").await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.error(), "RATE_LIMITED");
    assert_eq!(h.provider.completed_for(&request), None);
}

#[tokio::test]
async fn emailed_codes_are_counted_per_account_whatever_the_session() {
    let h = harness();
    let user = h.provider.add_user("jane@acme.test", PASSWORD);
    h.provider
        .update_user(&user, |user| user.methods.email_code = true);
    let request = h.provider.add_auth_request(&[]);

    // Each sign-in emails a code: five of them fill the account's window.
    for _ in 0..5 {
        let signed_in = h.sign_in(&request, "jane@acme.test", PASSWORD).await;
        assert_eq!(signed_in.step(), "needs_second_factor");
    }
    assert_eq!(h.provider.sent().len(), 5);

    // A sixth session gets the step, but no sixth email, and no "Resend".
    let sixth = h.sign_in(&request, "jane@acme.test", PASSWORD).await;
    assert_eq!(sixth.step(), "needs_second_factor");
    assert_eq!(h.provider.sent().len(), 5);
    let resend = h
        .post(
            "/second-factor/email-code",
            sixth.cookie.as_deref(),
            json!({}),
        )
        .await;
    assert_eq!(resend.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(resend.error(), "RATE_LIMITED");
    assert_eq!(h.provider.sent().len(), 5);
}

#[tokio::test]
async fn a_body_that_is_not_json_has_no_fields() {
    let h = harness();
    let request = Request::builder()
        .method(Method::POST)
        .uri("/password")
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from("email=jane%40acme.test&password=x"))
        .expect("request");
    let response = h.app.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let reply = h
        .post(
            "/password",
            None,
            json!({ "email": "not-an-address", "password": "x" }),
        )
        .await;
    assert_eq!(reply.error(), "VALIDATION_ERROR");
}

#[tokio::test]
async fn the_password_policy_is_the_providers() {
    let h = harness();
    let reply = h.get("/password-policy", None).await;
    assert_eq!(
        reply.body["data"],
        json!({
            "minLength": 8,
            "uppercase": true,
            "lowercase": true,
            "number": true,
            "symbol": false,
        })
    );
}

#[tokio::test]
async fn with_system_mail_weldsuite_emails_the_sign_up_code_itself() {
    let h = mailing_harness(Some("nl-NL,nl;q=0.9,en;q=0.8"));
    let request = h.provider.add_auth_request(&[Prompt::Create]);
    let created = h
        .post(
            "/sign-up",
            None,
            json!({
                "authRequest": request,
                "firstName": "Jane",
                "lastName": "Doe",
                "email": "jane@acme.test",
                "password": PASSWORD,
            }),
        )
        .await;
    assert_eq!(created.step(), "needs_email_verification");
    let user = h
        .provider
        .user_by_email("jane@acme.test")
        .expect("created")
        .user;
    // The provider handed the code back and mailed nothing itself.
    assert_eq!(h.provider.sent(), Vec::new());
    assert_eq!(h.provider.returned(), vec![("verify", user.id.clone())]);
    let mailed = h.mailed();
    assert_eq!(mailed.len(), 1);
    let (to, subject, text) = &mailed[0];
    assert_eq!(to, "jane@acme.test");
    // In the browser's language.
    assert_eq!(subject, "Bevestig je e-mailadres voor WeldSuite");
    assert!(text.contains(&format!(
        "https://app.test/auth/login?verifyUser={}&verifyCode=ABC123",
        user.id
    )));

    // "Resend" mails a new one the same way.
    let cookie = created.cookie.expect("session cookie");
    let resent = h
        .post("/email-verification/resend", Some(&cookie), json!({}))
        .await;
    assert_eq!(resent.status, StatusCode::NO_CONTENT);
    assert_eq!(h.mailed().len(), 2);
    assert_eq!(h.provider.sent(), Vec::new());
}

#[tokio::test]
async fn with_system_mail_the_second_factor_and_the_reset_come_from_weldsuite() {
    let h = mailing_harness(None);
    let user = h.provider.add_user("jane@acme.test", PASSWORD);
    h.provider
        .update_user(&user, |user| user.methods.email_code = true);
    let request = h.provider.add_auth_request(&[]);

    let after_password = h.sign_in(&request, "jane@acme.test", PASSWORD).await;
    assert_eq!(after_password.step(), "needs_second_factor");
    let mailed = h.mailed();
    assert_eq!(mailed.len(), 1);
    assert_eq!(mailed[0].0, "jane@acme.test");
    assert_eq!(mailed[0].1, "Your WeldSuite sign-in code: ABC123");
    assert_eq!(h.provider.sent(), Vec::new());

    let reset = h
        .post(
            "/password-reset",
            None,
            json!({ "email": "jane@acme.test" }),
        )
        .await;
    assert_eq!(reset.status, StatusCode::NO_CONTENT);
    let mailed = h.mailed_after(2).await;
    assert_eq!(mailed.len(), 2);
    assert_eq!(mailed[1].1, "Reset your WeldSuite password");
    assert!(mailed[1].2.contains(&format!(
        "https://app.test/auth/reset-password?userId={user}&code=ABC123"
    )));
    assert_eq!(h.provider.sent(), Vec::new());
}

#[tokio::test]
async fn without_the_platform_address_the_provider_sends_its_own_even_with_system_mail() {
    let h = built(None, Some(Arc::new(RecordingSystemMail::new())), None);
    let user = h.provider.add_user("jane@acme.test", PASSWORD);
    let reset = h
        .post(
            "/password-reset",
            None,
            json!({ "email": "jane@acme.test" }),
        )
        .await;
    assert_eq!(reset.status, StatusCode::NO_CONTENT);
    assert_eq!(h.provider.sent(), vec![("reset", user)]);
    assert_eq!(h.mailed(), Vec::new());
}
