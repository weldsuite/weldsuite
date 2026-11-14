//! Sign-in: the port behind the identity provider's login API (ADR SEC-016).
//!
//! Global signs people in on Clerk, from the browser. On the Kubernetes
//! editions the platform shows the same screens, and the backend plays the
//! provider's *login client* behind them (`modules/core-signin`): it checks
//! the password and the second factor with the provider, and hands the
//! finished session to the OIDC sign-in the browser started. The provider
//! keeps passwords, factors, sessions and tokens; WeldSuite keeps none.
//!
//! A sign-in is two things on the provider's side:
//!
//! - the **auth request**: the OIDC authorization the platform asked for,
//!   waiting for somebody to sign in ([`AuthRequest`]);
//! - the **session**: who signed in, and with which factors
//!   ([`SessionRef`], [`SessionState`]). One session can answer any number of
//!   auth requests, which is how switching workspace needs no password.
//!
//! The provider enforces little of its own sign-in policy on this API (a
//! second factor, a verified address, whether sign-up is open): the caller
//! reads the policy ([`SignInSettings`], [`AuthMethods`]) and applies it.
//!
//! The trait is object safe (boxed futures), like [`crate::Identity`]: the
//! provider is picked at run time.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::BoxFuture;

/// Why a sign-in call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInError {
    /// No provider is configured, it could not be reached, or it answered
    /// something this port has no name for.
    Unavailable(String),
    /// The password is wrong.
    InvalidCredentials,
    /// The account has no password: it signs in another way (a passkey, an
    /// external identity provider).
    NoPassword,
    /// The code is wrong, used or expired.
    InvalidCode,
    /// The account is locked or deactivated.
    Locked,
    /// The provider's rules refuse the new password.
    WeakPassword,
    /// Another account has the address.
    EmailTaken,
    /// The session ended, expired, or is not the caller's.
    NoSession,
    /// The auth request is unknown or already answered.
    Expired,
    /// The provider refuses its own service user (a role it lacks).
    Forbidden(String),
}

impl fmt::Display for SignInError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(reason) => write!(f, "sign-in provider unavailable: {reason}"),
            Self::InvalidCredentials => f.write_str("wrong password"),
            Self::NoPassword => f.write_str("account has no password"),
            Self::InvalidCode => f.write_str("wrong or expired code"),
            Self::Locked => f.write_str("account locked"),
            Self::WeakPassword => f.write_str("password refused by the provider's rules"),
            Self::EmailTaken => f.write_str("address already has an account"),
            Self::NoSession => f.write_str("no session"),
            Self::Expired => f.write_str("sign-in no longer known"),
            Self::Forbidden(reason) => {
                write!(f, "sign-in provider refused the service user: {reason}")
            }
        }
    }
}

impl std::error::Error for SignInError {}

pub type SignInResult<T> = Result<T, SignInError>;

/// What the OIDC authorization asked of the sign-in (`prompt`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prompt {
    /// Answer without showing anything, or refuse.
    None,
    /// Ask for the credentials again, whatever session there is.
    Login,
    /// Let the person pick an account.
    SelectAccount,
    /// Show sign-up rather than sign-in.
    Create,
}

/// An OIDC authorization waiting for a sign-in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AuthRequest {
    pub id: String,
    /// Milliseconds since the epoch.
    pub created_at: Option<i64>,
    pub prompts: Vec<Prompt>,
    /// The address the platform expects to sign in (`login_hint`).
    pub login_hint: Option<String>,
    /// The oldest password check the platform accepts (`max_age`).
    pub max_age: Option<Duration>,
}

impl AuthRequest {
    pub fn asks(&self, prompt: Prompt) -> bool {
        self.prompts.contains(&prompt)
    }
}

/// A session at the provider, as the browser's cookie holds it. The token
/// changes whenever a factor is checked.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionRef {
    pub id: String,
    pub token: String,
}

impl fmt::Debug for SessionRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionRef")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

/// Who a session belongs to and which factors it has checked, each with when
/// (milliseconds since the epoch).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionState {
    pub user_id: String,
    pub password_at: Option<i64>,
    /// A passkey, checked with user verification: both factors in one.
    pub passkey_at: Option<i64>,
    /// Signed in at an external identity provider.
    pub external_at: Option<i64>,
    pub totp_at: Option<i64>,
    pub email_code_at: Option<i64>,
    pub sms_code_at: Option<i64>,
    /// A security key, without user verification.
    pub security_key_at: Option<i64>,
}

impl SessionState {
    /// When the person last proved who they are with a first factor.
    pub fn first_factor_at(&self) -> Option<i64> {
        [self.password_at, self.passkey_at, self.external_at]
            .into_iter()
            .flatten()
            .max()
    }

    /// A second factor was checked (a passkey counts as both).
    pub fn has_second_factor(&self) -> bool {
        self.passkey_at.is_some()
            || self.totp_at.is_some()
            || self.email_code_at.is_some()
            || self.sms_code_at.is_some()
            || self.security_key_at.is_some()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum UserStatus {
    #[default]
    Active,
    /// Created, not yet set up (an invitation nobody accepted).
    Initial,
    Locked,
    Inactive,
}

/// The account behind a sign-in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SignInUser {
    pub id: String,
    /// The provider organization the account lives in; its sign-in policy applies.
    pub organization_id: Option<String>,
    pub email: Option<String>,
    pub email_verified: bool,
    pub status: UserStatus,
    /// The provider wants a new password before anything else.
    pub password_change_required: bool,
}

/// How an account can sign in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // one flag per method the provider knows
pub struct AuthMethods {
    pub password: bool,
    pub passkey: bool,
    pub external: bool,
    pub totp: bool,
    pub email_code: bool,
    pub sms_code: bool,
    pub security_key: bool,
}

impl AuthMethods {
    /// The account has a second factor set up.
    pub fn any_second_factor(&self) -> bool {
        self.totp || self.email_code || self.sms_code || self.security_key
    }
}

/// The provider's sign-in policy for an organization.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // the provider's own switches
pub struct SignInSettings {
    pub allow_password: bool,
    pub allow_register: bool,
    pub allow_password_reset: bool,
    /// Everybody needs a second factor.
    pub force_second_factor: bool,
    /// Everybody who signs in with a password needs one.
    pub force_second_factor_local: bool,
    /// An unknown account is answered like a wrong password.
    pub hide_unknown_accounts: bool,
    /// The email address signs in, not only the login name.
    pub sign_in_with_email: bool,
    /// How long a password check counts; a session lives that long.
    pub password_lifetime: Option<Duration>,
}

impl Default for SignInSettings {
    fn default() -> Self {
        Self {
            allow_password: true,
            allow_register: false,
            allow_password_reset: true,
            force_second_factor: false,
            force_second_factor_local: false,
            hide_unknown_accounts: false,
            sign_in_with_email: true,
            password_lifetime: None,
        }
    }
}

/// What the provider asks of a new password.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)] // one flag per rule
pub struct PasswordRules {
    pub min_length: u32,
    pub uppercase: bool,
    pub lowercase: bool,
    pub number: bool,
    pub symbol: bool,
}

/// Which emailed code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CodeKind {
    /// Proves the address at sign-up.
    EmailVerification,
    /// The second factor by email.
    EmailSecondFactor,
    /// Lets somebody set a new password.
    PasswordReset,
}

/// How the provider writes a code it emails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodeFormat {
    pub length: u32,
    /// Letters as well as digits.
    pub letters: bool,
    /// Its letters are capitals only, so a code typed in lower case still matches.
    pub uppercase: bool,
    /// How long a code stays valid, when the provider says.
    pub expires_in: Option<Duration>,
}

/// A new account.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct NewUser {
    pub email: String,
    pub password: String,
    pub first_name: String,
    pub last_name: String,
}

impl fmt::Debug for NewUser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NewUser")
            .field("email", &self.email)
            .finish_non_exhaustive()
    }
}

/// Where a link in the provider's email points: a platform URL with `{user}`
/// and `{code}` where the provider writes the account's id and the code.
pub type LinkTemplate<'a> = Option<&'a str>;

/// Who emails a code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeDelivery<'a> {
    /// The provider, in its own email, its link pointing at the template
    /// (`None`: the provider's own pages). The code is not handed back.
    Provider(LinkTemplate<'a>),
    /// Nobody: the provider hands the code back and the caller emails it
    /// (WeldSuite's own templates).
    Return,
}

impl CodeDelivery<'_> {
    pub fn returns(self) -> bool {
        matches!(self, Self::Return)
    }
}

/// The provider's login API.
pub trait SignInProvider: Send + Sync {
    /// The auth request; [`SignInError::Expired`] when it is unknown or answered.
    fn auth_request<'a>(&'a self, id: &'a str) -> BoxFuture<'a, SignInResult<AuthRequest>>;

    /// The policy of `organization`, or of the organization people sign up in.
    fn settings<'a>(
        &'a self,
        organization: Option<&'a str>,
    ) -> BoxFuture<'a, SignInResult<SignInSettings>>;

    fn password_rules<'a>(
        &'a self,
        organization: Option<&'a str>,
    ) -> BoxFuture<'a, SignInResult<PasswordRules>>;

    /// Never fails: the provider's defaults when it cannot be asked.
    fn code_format(&self, kind: CodeKind) -> BoxFuture<'_, CodeFormat>;

    /// The one account that signs in as `identifier` (its login name, or its
    /// address when `by_email`); `None` for none, and for more than one.
    fn find_user<'a>(
        &'a self,
        identifier: &'a str,
        by_email: bool,
    ) -> BoxFuture<'a, SignInResult<Option<SignInUser>>>;

    fn user<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, SignInResult<Option<SignInUser>>>;

    fn auth_methods<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, SignInResult<AuthMethods>>;

    /// Check the password and open a session that lives `lifetime`.
    fn start_session<'a>(
        &'a self,
        user_id: &'a str,
        password: &'a str,
        lifetime: Option<Duration>,
    ) -> BoxFuture<'a, SignInResult<SessionRef>>;

    /// The session's state; `None` when it ended, expired or the token is not its.
    fn session<'a>(
        &'a self,
        session: &'a SessionRef,
    ) -> BoxFuture<'a, SignInResult<Option<SessionState>>>;

    /// Check an authenticator code; the session's new reference.
    fn check_totp<'a>(
        &'a self,
        session: &'a SessionRef,
        code: &'a str,
    ) -> BoxFuture<'a, SignInResult<SessionRef>>;

    /// Email the second-factor code to the session's account, or hand it
    /// back ([`CodeDelivery::Return`]); the session's new reference.
    fn send_email_code<'a>(
        &'a self,
        session: &'a SessionRef,
        delivery: CodeDelivery<'a>,
    ) -> BoxFuture<'a, SignInResult<(SessionRef, Option<String>)>>;

    fn check_email_code<'a>(
        &'a self,
        session: &'a SessionRef,
        code: &'a str,
    ) -> BoxFuture<'a, SignInResult<SessionRef>>;

    /// End the session at the provider (sign-out). A session that is already
    /// gone is no error.
    fn end_session<'a>(&'a self, session: &'a SessionRef) -> BoxFuture<'a, SignInResult<()>>;

    /// Answer the auth request with the session: the URL the browser
    /// continues on (the platform's OIDC callback, with the code).
    fn complete<'a>(
        &'a self,
        auth_request: &'a str,
        session: &'a SessionRef,
    ) -> BoxFuture<'a, SignInResult<String>>;

    /// Answer the auth request with "sign-in required" (`prompt=none` and no
    /// session): the callback URL carrying that error.
    fn refuse<'a>(&'a self, auth_request: &'a str) -> BoxFuture<'a, SignInResult<String>>;

    /// Create the account and email the code that verifies its address (or
    /// hand it back); the account's id.
    fn create_user<'a>(
        &'a self,
        user: &'a NewUser,
        delivery: CodeDelivery<'a>,
    ) -> BoxFuture<'a, SignInResult<(String, Option<String>)>>;

    /// A new code that verifies the account's address: emailed, or handed back.
    fn send_email_verification<'a>(
        &'a self,
        user_id: &'a str,
        delivery: CodeDelivery<'a>,
    ) -> BoxFuture<'a, SignInResult<Option<String>>>;

    fn verify_email<'a>(
        &'a self,
        user_id: &'a str,
        code: &'a str,
    ) -> BoxFuture<'a, SignInResult<()>>;

    /// A password reset code: emailed, or handed back.
    fn send_password_reset<'a>(
        &'a self,
        user_id: &'a str,
        delivery: CodeDelivery<'a>,
    ) -> BoxFuture<'a, SignInResult<Option<String>>>;

    fn reset_password<'a>(
        &'a self,
        user_id: &'a str,
        code: &'a str,
        password: &'a str,
    ) -> BoxFuture<'a, SignInResult<()>>;

    /// The provider's own page for this auth request, for what the
    /// platform's screens don't do (a passkey, enrolling a second factor).
    fn hosted_url(&self, auth_request: &str) -> Option<String>;
}

// ── the in-memory double ─────────────────────────────────────────────────────

/// An account in [`MemorySignIn`].
#[derive(Debug, Clone, Default)]
pub struct MemoryUser {
    pub user: SignInUser,
    pub password: String,
    pub methods: AuthMethods,
}

#[derive(Debug, Default)]
struct MemoryState {
    settings: SignInSettings,
    users: Vec<MemoryUser>,
    /// Session id → (token, state).
    sessions: HashMap<String, (String, SessionState)>,
    requests: HashMap<String, AuthRequest>,
    /// Auth request id → the user it was answered for.
    completed: HashMap<String, String>,
    /// Codes the provider "sent", newest last: (kind, account).
    sent: Vec<(&'static str, String)>,
    /// Codes handed back instead (`CodeDelivery::Return`), newest last.
    returned: Vec<(&'static str, String)>,
    next_id: u64,
    failure: Option<SignInError>,
    /// How many sessions a new account refuses before it is known.
    new_account_lag: u32,
    /// Account id → refusals left.
    unknown_yet: HashMap<String, u32>,
}

/// A provider in memory, for tests. Every emailed code is [`MemorySignIn::CODE`]
/// and every authenticator code [`MemorySignIn::TOTP`].
#[derive(Debug, Default)]
pub struct MemorySignIn {
    state: Mutex<MemoryState>,
}

impl MemorySignIn {
    pub const CODE: &'static str = "ABC123";
    pub const TOTP: &'static str = "654321";
    pub const RULES: PasswordRules = PasswordRules {
        min_length: 8,
        uppercase: true,
        lowercase: true,
        number: true,
        symbol: false,
    };

    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, MemoryState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn set_settings(&self, settings: SignInSettings) {
        self.lock().settings = settings;
    }

    /// Add an active, verified account with a password; its id.
    pub fn add_user(&self, email: &str, password: &str) -> String {
        let mut state = self.lock();
        state.next_id += 1;
        let id = format!("user_{}", state.next_id);
        state.users.push(MemoryUser {
            user: SignInUser {
                id: id.clone(),
                organization_id: Some("org_default".to_owned()),
                email: Some(email.to_owned()),
                email_verified: true,
                ..SignInUser::default()
            },
            password: password.to_owned(),
            methods: AuthMethods {
                password: true,
                ..AuthMethods::default()
            },
        });
        id
    }

    /// Change an account in place.
    pub fn update_user(&self, user_id: &str, change: impl FnOnce(&mut MemoryUser)) {
        if let Some(user) = self
            .lock()
            .users
            .iter_mut()
            .find(|user| user.user.id == user_id)
        {
            change(user);
        }
    }

    /// Open an auth request with these prompts; its id.
    pub fn add_auth_request(&self, prompts: &[Prompt]) -> String {
        let mut state = self.lock();
        state.next_id += 1;
        let id = format!("V2_{}", state.next_id);
        state.requests.insert(
            id.clone(),
            AuthRequest {
                id: id.clone(),
                created_at: Some(now_ms()),
                prompts: prompts.to_vec(),
                ..AuthRequest::default()
            },
        );
        id
    }

    /// The account an auth request was answered for.
    pub fn completed_for(&self, auth_request: &str) -> Option<String> {
        self.lock().completed.get(auth_request).cloned()
    }

    /// The codes handed back for the caller to email, oldest first: (kind, account).
    pub fn returned(&self) -> Vec<(&'static str, String)> {
        self.lock().returned.clone()
    }

    /// What was emailed, oldest first: (`verify` | `second-factor` | `reset`, account).
    pub fn sent(&self) -> Vec<(&'static str, String)> {
        self.lock().sent.clone()
    }

    pub fn user_by_email(&self, email: &str) -> Option<MemoryUser> {
        self.lock()
            .users
            .iter()
            .find(|user| user.user.email.as_deref() == Some(email))
            .cloned()
    }

    /// How many sessions are open.
    pub fn session_count(&self) -> usize {
        self.lock().sessions.len()
    }

    /// Make every call fail with `error` (`None` to stop).
    pub fn fail_with(&self, error: Option<SignInError>) {
        self.lock().failure = error;
    }

    /// Accounts created from now on refuse their first `sessions` sessions
    /// as a wrong password, like a provider whose read side trails its
    /// writes and does not know a new account for a moment.
    pub fn lag_new_accounts(&self, sessions: u32) {
        self.lock().new_account_lag = sessions;
    }

    fn run<T>(&self, f: impl FnOnce(&mut MemoryState) -> SignInResult<T>) -> SignInResult<T> {
        let mut state = self.lock();
        if let Some(error) = &state.failure {
            return Err(error.clone());
        }
        f(&mut state)
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or_default()
}

impl MemoryState {
    /// A code for `account`: "sent", or handed back.
    fn deliver(
        &mut self,
        delivery: CodeDelivery<'_>,
        kind: &'static str,
        account: String,
    ) -> Option<String> {
        if delivery.returns() {
            self.returned.push((kind, account));
            Some(MemorySignIn::CODE.to_owned())
        } else {
            self.sent.push((kind, account));
            None
        }
    }

    fn user_mut(&mut self, user_id: &str) -> SignInResult<&mut MemoryUser> {
        self.users
            .iter_mut()
            .find(|user| user.user.id == user_id)
            .ok_or(SignInError::Unavailable("unknown user".to_owned()))
    }

    /// The session's state after `check`, under a new token.
    fn update_session(
        &mut self,
        session: &SessionRef,
        check: impl FnOnce(&mut SessionState),
    ) -> SignInResult<SessionRef> {
        self.next_id += 1;
        let token = format!("token_{}", self.next_id);
        let (current, state) = self
            .sessions
            .get_mut(&session.id)
            .filter(|(token, _)| *token == session.token)
            .ok_or(SignInError::NoSession)?;
        check(state);
        current.clone_from(&token);
        Ok(SessionRef {
            id: session.id.clone(),
            token,
        })
    }
}

impl SignInProvider for MemorySignIn {
    fn auth_request<'a>(&'a self, id: &'a str) -> BoxFuture<'a, SignInResult<AuthRequest>> {
        Box::pin(async move {
            self.run(|state| state.requests.get(id).cloned().ok_or(SignInError::Expired))
        })
    }

    fn settings<'a>(
        &'a self,
        _organization: Option<&'a str>,
    ) -> BoxFuture<'a, SignInResult<SignInSettings>> {
        Box::pin(async move { self.run(|state| Ok(state.settings)) })
    }

    fn password_rules<'a>(
        &'a self,
        _organization: Option<&'a str>,
    ) -> BoxFuture<'a, SignInResult<PasswordRules>> {
        Box::pin(async move { self.run(|_| Ok(Self::RULES)) })
    }

    fn code_format(&self, kind: CodeKind) -> BoxFuture<'_, CodeFormat> {
        Box::pin(async move {
            match kind {
                CodeKind::EmailVerification
                | CodeKind::EmailSecondFactor
                | CodeKind::PasswordReset => CodeFormat {
                    length: 6,
                    letters: true,
                    uppercase: true,
                    expires_in: None,
                },
            }
        })
    }

    fn find_user<'a>(
        &'a self,
        identifier: &'a str,
        _by_email: bool,
    ) -> BoxFuture<'a, SignInResult<Option<SignInUser>>> {
        Box::pin(async move {
            self.run(|state| {
                let mut matches = state.users.iter().filter(|user| {
                    user.user
                        .email
                        .as_deref()
                        .is_some_and(|email| email.eq_ignore_ascii_case(identifier))
                });
                let first = matches.next().map(|user| user.user.clone());
                Ok(if matches.next().is_some() {
                    None
                } else {
                    first
                })
            })
        })
    }

    fn user<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, SignInResult<Option<SignInUser>>> {
        Box::pin(async move {
            self.run(|state| {
                Ok(state
                    .users
                    .iter()
                    .find(|user| user.user.id == user_id)
                    .map(|user| user.user.clone()))
            })
        })
    }

    fn auth_methods<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, SignInResult<AuthMethods>> {
        Box::pin(async move { self.run(|state| Ok(state.user_mut(user_id)?.methods)) })
    }

    fn start_session<'a>(
        &'a self,
        user_id: &'a str,
        password: &'a str,
        _lifetime: Option<Duration>,
    ) -> BoxFuture<'a, SignInResult<SessionRef>> {
        Box::pin(async move {
            self.run(|state| {
                if let Some(left) = state.unknown_yet.get_mut(user_id).filter(|left| **left > 0) {
                    *left -= 1;
                    return Err(SignInError::InvalidCredentials);
                }
                let user = state.user_mut(user_id)?;
                if matches!(user.user.status, UserStatus::Locked | UserStatus::Inactive) {
                    return Err(SignInError::Locked);
                }
                if !user.methods.password {
                    return Err(SignInError::NoPassword);
                }
                if user.password != password {
                    return Err(SignInError::InvalidCredentials);
                }
                state.next_id += 1;
                let session = SessionRef {
                    id: format!("session_{}", state.next_id),
                    token: format!("token_{}", state.next_id),
                };
                state.sessions.insert(
                    session.id.clone(),
                    (
                        session.token.clone(),
                        SessionState {
                            user_id: user_id.to_owned(),
                            password_at: Some(now_ms()),
                            ..SessionState::default()
                        },
                    ),
                );
                Ok(session)
            })
        })
    }

    fn session<'a>(
        &'a self,
        session: &'a SessionRef,
    ) -> BoxFuture<'a, SignInResult<Option<SessionState>>> {
        Box::pin(async move {
            self.run(|state| {
                Ok(state
                    .sessions
                    .get(&session.id)
                    .filter(|(token, _)| *token == session.token)
                    .map(|(_, state)| state.clone()))
            })
        })
    }

    fn check_totp<'a>(
        &'a self,
        session: &'a SessionRef,
        code: &'a str,
    ) -> BoxFuture<'a, SignInResult<SessionRef>> {
        Box::pin(async move {
            self.run(|state| {
                if code != Self::TOTP {
                    return Err(SignInError::InvalidCode);
                }
                state.update_session(session, |session| session.totp_at = Some(now_ms()))
            })
        })
    }

    fn send_email_code<'a>(
        &'a self,
        session: &'a SessionRef,
        delivery: CodeDelivery<'a>,
    ) -> BoxFuture<'a, SignInResult<(SessionRef, Option<String>)>> {
        Box::pin(async move {
            self.run(|state| {
                let next = state.update_session(session, |_| {})?;
                let user = state.sessions[&session.id].1.user_id.clone();
                Ok((next, state.deliver(delivery, "second-factor", user)))
            })
        })
    }

    fn check_email_code<'a>(
        &'a self,
        session: &'a SessionRef,
        code: &'a str,
    ) -> BoxFuture<'a, SignInResult<SessionRef>> {
        Box::pin(async move {
            self.run(|state| {
                if code != Self::CODE {
                    return Err(SignInError::InvalidCode);
                }
                state.update_session(session, |session| session.email_code_at = Some(now_ms()))
            })
        })
    }

    fn end_session<'a>(&'a self, session: &'a SessionRef) -> BoxFuture<'a, SignInResult<()>> {
        Box::pin(async move {
            self.run(|state| {
                if state
                    .sessions
                    .get(&session.id)
                    .is_some_and(|(token, _)| *token == session.token)
                {
                    state.sessions.remove(&session.id);
                }
                Ok(())
            })
        })
    }

    fn complete<'a>(
        &'a self,
        auth_request: &'a str,
        session: &'a SessionRef,
    ) -> BoxFuture<'a, SignInResult<String>> {
        Box::pin(async move {
            self.run(|state| {
                let user = state
                    .sessions
                    .get(&session.id)
                    .filter(|(token, _)| *token == session.token)
                    .map(|(_, state)| state.user_id.clone())
                    .ok_or(SignInError::NoSession)?;
                state
                    .requests
                    .remove(auth_request)
                    .ok_or(SignInError::Expired)?;
                state.completed.insert(auth_request.to_owned(), user);
                Ok(format!(
                    "https://app.test/auth/sso-callback?code={auth_request}"
                ))
            })
        })
    }

    fn refuse<'a>(&'a self, auth_request: &'a str) -> BoxFuture<'a, SignInResult<String>> {
        Box::pin(async move {
            self.run(|state| {
                state
                    .requests
                    .remove(auth_request)
                    .ok_or(SignInError::Expired)?;
                Ok("https://app.test/auth/sso-callback?error=login_required".to_owned())
            })
        })
    }

    fn create_user<'a>(
        &'a self,
        user: &'a NewUser,
        delivery: CodeDelivery<'a>,
    ) -> BoxFuture<'a, SignInResult<(String, Option<String>)>> {
        Box::pin(async move {
            self.run(|state| {
                if state.users.iter().any(|existing| {
                    existing
                        .user
                        .email
                        .as_deref()
                        .is_some_and(|email| email.eq_ignore_ascii_case(&user.email))
                }) {
                    return Err(SignInError::EmailTaken);
                }
                state.next_id += 1;
                let id = format!("user_{}", state.next_id);
                state.users.push(MemoryUser {
                    user: SignInUser {
                        id: id.clone(),
                        organization_id: Some("org_default".to_owned()),
                        email: Some(user.email.clone()),
                        ..SignInUser::default()
                    },
                    password: user.password.clone(),
                    methods: AuthMethods {
                        password: true,
                        ..AuthMethods::default()
                    },
                });
                let code = state.deliver(delivery, "verify", id.clone());
                if state.new_account_lag > 0 {
                    state.unknown_yet.insert(id.clone(), state.new_account_lag);
                }
                Ok((id, code))
            })
        })
    }

    fn send_email_verification<'a>(
        &'a self,
        user_id: &'a str,
        delivery: CodeDelivery<'a>,
    ) -> BoxFuture<'a, SignInResult<Option<String>>> {
        Box::pin(async move {
            self.run(|state| Ok(state.deliver(delivery, "verify", user_id.to_owned())))
        })
    }

    fn verify_email<'a>(
        &'a self,
        user_id: &'a str,
        code: &'a str,
    ) -> BoxFuture<'a, SignInResult<()>> {
        Box::pin(async move {
            self.run(|state| {
                if code != Self::CODE {
                    return Err(SignInError::InvalidCode);
                }
                state.user_mut(user_id)?.user.email_verified = true;
                Ok(())
            })
        })
    }

    fn send_password_reset<'a>(
        &'a self,
        user_id: &'a str,
        delivery: CodeDelivery<'a>,
    ) -> BoxFuture<'a, SignInResult<Option<String>>> {
        Box::pin(async move {
            self.run(|state| Ok(state.deliver(delivery, "reset", user_id.to_owned())))
        })
    }

    fn reset_password<'a>(
        &'a self,
        user_id: &'a str,
        code: &'a str,
        password: &'a str,
    ) -> BoxFuture<'a, SignInResult<()>> {
        Box::pin(async move {
            self.run(|state| {
                if code != Self::CODE {
                    return Err(SignInError::InvalidCode);
                }
                if password.len() < 8 {
                    return Err(SignInError::WeakPassword);
                }
                password.clone_into(&mut state.user_mut(user_id)?.password);
                Ok(())
            })
        })
    }

    fn hosted_url(&self, auth_request: &str) -> Option<String> {
        Some(format!(
            "https://id.test/ui/v2/login/login?authRequest={auth_request}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_session_answers_an_auth_request_once() {
        let provider = MemorySignIn::new();
        let user = provider.add_user("jane@acme.test", "Secret123");
        let request = provider.add_auth_request(&[]);

        let wrong = provider.start_session(&user, "nope", None).await;
        assert_eq!(wrong, Err(SignInError::InvalidCredentials));

        let session = provider
            .start_session(&user, "Secret123", None)
            .await
            .expect("session");
        let state = provider
            .session(&session)
            .await
            .expect("read")
            .expect("alive");
        assert_eq!(state.user_id, user);
        assert!(state.first_factor_at().is_some());
        assert!(!state.has_second_factor());

        let url = provider
            .complete(&request, &session)
            .await
            .expect("callback");
        assert!(url.contains(&request));
        assert_eq!(provider.completed_for(&request), Some(user));
        assert_eq!(
            provider.complete(&request, &session).await,
            Err(SignInError::Expired)
        );
    }

    #[tokio::test]
    async fn a_checked_factor_changes_the_token() {
        let provider = MemorySignIn::new();
        let user = provider.add_user("jane@acme.test", "Secret123");
        let session = provider
            .start_session(&user, "Secret123", None)
            .await
            .expect("session");

        assert_eq!(
            provider.check_totp(&session, "000000").await,
            Err(SignInError::InvalidCode)
        );
        let next = provider
            .check_totp(&session, MemorySignIn::TOTP)
            .await
            .expect("checked");
        assert_ne!(next.token, session.token);
        // The old reference is no longer the session's.
        assert_eq!(provider.session(&session).await, Ok(None));
        let state = provider.session(&next).await.expect("read").expect("alive");
        assert!(state.has_second_factor());
    }
}
