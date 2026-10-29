//! Identity: the port behind the identity provider's management API (ADR
//! SEC-012). The Global edition's workers call Clerk's Backend API directly
//! (`fetch('https://api.clerk.com/v1/…')` and `@clerk/backend`); the
//! Kubernetes editions put the provider behind this trait, with a Zitadel
//! adapter in phase P5.
//!
//! Only what the ported routes use is here, one method per call they make,
//! so a route keeps the exact sequence of calls (and the same answers to
//! each failure) whatever the provider:
//!
//! | Method | Clerk Backend API | Used by |
//! |---|---|---|
//! | [`Identity::organization`] | `GET /organizations/{org}` | invite (seat cap) |
//! | [`Identity::update_organization`] | `PATCH /organizations/{org}` | rename, slug, seat cap |
//! | [`Identity::delete_organization`] | `DELETE /organizations/{org}` | delete workspace, delete account |
//! | [`Identity::memberships`] | `GET /organizations/{org}/memberships` | sync, member count, seat cap |
//! | [`Identity::add_membership`] | `POST /organizations/{org}/memberships` | guest invite |
//! | [`Identity::set_membership_role`] | `PATCH /organizations/{org}/memberships/{user}` | role change |
//! | [`Identity::remove_membership`] | `DELETE /organizations/{org}/memberships/{user}` | remove member |
//! | [`Identity::invitations`] | `GET /organizations/{org}/invitations` | sync, seat cap |
//! | [`Identity::invitation`] | `GET /organizations/{org}/invitations/{id}` | invitation details |
//! | [`Identity::invite`] | `POST /organizations/{org}/invitations` | invite, resend |
//! | [`Identity::revoke_invitation`] | `POST /organizations/{org}/invitations/{id}/revoke` | cancel, resend |
//! | [`Identity::users_by_email`] | `GET /users?email_address=…` | guest invite |
//! | [`Identity::user_memberships`] | `GET /users/{user}/organization_memberships` | accept invitation |
//! | [`Identity::delete_user`] | `DELETE /users/{user}` | delete account |
//! | [`Identity::user_profile`] | `GET /users/{user}` | onboarding, labels |
//! | [`Identity::update_user`] | `PATCH /users/{user}` | onboarding profile |
//! | [`Identity::update_user_metadata`] | `PATCH /users/{user}/metadata` | onboarding role, profile |
//! | [`Identity::create_organization`] | `POST /organizations` | onboarding (a new workspace) |
//! | [`Identity::update_organization_metadata`] | `PATCH /organizations/{org}/metadata` | onboarding |
//! | [`Identity::changes_since`] | (Clerk pushes webhooks instead) | the identity sync |
//!
//! The methods from [`Identity::user_profile`] on have default
//! implementations that answer [`IdentityError::Unavailable`], so an adapter
//! that doesn't offer them compiles unchanged.
//!
//! Without a provider (`None` in the app state) every call is
//! [`IdentityError::Unavailable`], which the routes answer as the workers do
//! when Clerk cannot be reached.
//!
//! The trait is object safe (boxed futures) rather than the native-`async`
//! plus `Dyn*` pair the other ports have: the provider is always picked at
//! run time and never used generically, so the pair would only add a copy.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::Value;

use crate::BoxFuture;

/// Why an identity call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityError {
    /// No provider is configured, or it could not be reached (the workers'
    /// `fetch` throwing).
    Unavailable(String),
    /// The provider answered with an error status. `code` and `message` are
    /// its first error's (`errors[0].code`, `long_message ?? message`).
    Rejected {
        status: u16,
        code: Option<String>,
        message: Option<String>,
    },
}

impl IdentityError {
    /// The HTTP status of a refusal, if the provider answered.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Rejected { status, .. } => Some(*status),
            Self::Unavailable(_) => None,
        }
    }

    /// The provider's error code, if it sent one.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Rejected { code, .. } => code.as_deref(),
            Self::Unavailable(_) => None,
        }
    }

    /// The provider answered 404.
    pub fn is_not_found(&self) -> bool {
        self.status() == Some(404)
    }

    /// A 4xx refusal about the organization's slug (taken, or not a slug the
    /// provider accepts): `isClerkSlugError`. Onboarding retries with another
    /// slug, then without one.
    pub fn is_slug_error(&self) -> bool {
        match self {
            Self::Rejected {
                status,
                code,
                message,
            } if (400..500).contains(status) => [code, message]
                .iter()
                .any(|text| text.as_deref().is_some_and(mentions_slug)),
            _ => false,
        }
    }
}

fn mentions_slug(text: &str) -> bool {
    text.to_ascii_lowercase().contains("slug")
}

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(reason) => write!(f, "identity provider unavailable: {reason}"),
            Self::Rejected { status, code, .. } => {
                write!(f, "identity provider refused ({status}")?;
                if let Some(code) = code {
                    write!(f, ", {code}")?;
                }
                f.write_str(")")
            }
        }
    }
}

impl std::error::Error for IdentityError {}

pub type IdentityResult<T> = Result<T, IdentityError>;

/// A page of a list call. `None` leaves the provider's default (and keeps
/// the parameter out of the request, as the workers do).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ListPage {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

impl ListPage {
    pub fn limit(limit: u32) -> Self {
        Self {
            limit: Some(limit),
            offset: None,
        }
    }

    pub fn at(limit: u32, offset: u32) -> Self {
        Self {
            limit: Some(limit),
            offset: Some(offset),
        }
    }
}

/// One page of a list, with the provider's total when it reports one.
#[derive(Debug, Clone, PartialEq)]
pub struct Listing<T> {
    pub data: Vec<T>,
    pub total_count: Option<u64>,
}

/// An organization (a workspace, provider side).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Organization {
    pub id: String,
    pub name: String,
    pub slug: Option<String>,
    /// The membership cap (`max_allowed_memberships`); `None` or `0` is no cap.
    pub max_memberships: Option<i64>,
    /// What the workspace's creator chose at onboarding (`selectedApps`,
    /// `country`, …); `Null` when the provider has none.
    pub public_metadata: Value,
    /// Server-only metadata (partner onboarding's markers); `Null` when none.
    pub private_metadata: Value,
}

/// What [`Identity::create_organization`] sends.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NewOrganization {
    pub name: String,
    /// `None` lets the provider pick one.
    pub slug: Option<String>,
    /// The user who becomes its first member, as an admin (`created_by`);
    /// `None` for an organization nobody belongs to yet.
    pub created_by: Option<String>,
    /// Left out of the request when `None`.
    pub public_metadata: Option<Value>,
    /// Left out of the request when `None`.
    pub private_metadata: Option<Value>,
}

/// What [`Identity::update_user`] changes. `None` leaves a field (and keeps
/// it out of the request, as `JSON.stringify` drops `undefined`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserChanges {
    pub first_name: Option<String>,
    pub last_name: Option<String>,
}

/// One change the provider reports for [`Identity::changes_since`]: which
/// user, organization or membership to look at again. A change only says
/// what moved, never to what: the reader asks the provider for the current
/// state, so a change seen twice, late or out of order does no harm.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum IdentityChange {
    /// A user was added, changed or (`removed`) deleted.
    User { user_id: String, removed: bool },
    /// An organization was added, changed or (`removed`) deleted.
    Organization { org: String, removed: bool },
    /// A user's membership of (or invitation to) an organization was added,
    /// changed or removed.
    Membership { org: String, user_id: String },
}

/// A change and when the provider recorded it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeEvent {
    /// RFC 3339; the feed is in this order.
    pub at: String,
    pub change: IdentityChange,
}

/// What [`Identity::update_organization`] changes; `None` leaves a field.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrganizationChanges {
    pub name: Option<String>,
    pub slug: Option<String>,
    /// `Some(0)` removes the cap.
    pub max_memberships: Option<i64>,
}

/// The organization a membership belongs to, as a user's memberships list it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrganizationRef {
    pub id: String,
    pub name: String,
    pub slug: String,
}

/// The user behind a membership.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemberUser {
    pub user_id: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    /// The sign-in identifier, usually the email address.
    pub identifier: String,
    pub image_url: Option<String>,
}

/// A user's membership of an organization.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Membership {
    pub id: String,
    /// The provider's role key (`org:admin`, `org:member`).
    pub role: String,
    /// Milliseconds since the epoch.
    pub created_at: Option<i64>,
    /// Provider-side metadata (`member_type` marks a guest).
    pub public_metadata: Value,
    pub user: MemberUser,
    /// Set on [`Identity::user_memberships`].
    pub organization: Option<OrganizationRef>,
}

/// A pending (or past) invitation to an organization.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Invitation {
    pub id: String,
    pub email_address: String,
    pub role: String,
    /// `pending`, `accepted`, `revoked` or `expired`.
    pub status: String,
    pub public_metadata: Value,
    /// Milliseconds since the epoch.
    pub created_at: Option<i64>,
    /// Milliseconds since the epoch.
    pub expires_at: Option<i64>,
}

/// What [`Identity::invite`] sends. The provider emails the invitee.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NewInvitation {
    pub email_address: String,
    pub role: String,
    /// Where the invitation link lands.
    pub redirect_url: Option<String>,
    /// Left out of the request when `None`.
    pub public_metadata: Option<Value>,
    /// Who invites (`inviter_user_id`); left out of the request when `None`.
    pub inviter_user_id: Option<String>,
}

/// What [`Identity::add_membership`] sends.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NewMembership {
    pub user_id: String,
    pub role: String,
    /// Left out of the request when `None`.
    pub public_metadata: Option<Value>,
}

/// A user account.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct User {
    pub id: String,
}

/// The identity provider's management API. See the module docs for the
/// calls each method stands for.
pub trait Identity: Send + Sync {
    /// A missing organization is a 404 refusal.
    fn organization<'a>(&'a self, org: &'a str) -> BoxFuture<'a, IdentityResult<Organization>>;

    fn update_organization<'a>(
        &'a self,
        org: &'a str,
        changes: &'a OrganizationChanges,
    ) -> BoxFuture<'a, IdentityResult<()>>;

    fn delete_organization<'a>(&'a self, org: &'a str) -> BoxFuture<'a, IdentityResult<()>>;

    fn memberships<'a>(
        &'a self,
        org: &'a str,
        page: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Membership>>>;

    fn add_membership<'a>(
        &'a self,
        org: &'a str,
        membership: &'a NewMembership,
    ) -> BoxFuture<'a, IdentityResult<Membership>>;

    /// Addressed by user id, as Clerk addresses memberships.
    fn set_membership_role<'a>(
        &'a self,
        org: &'a str,
        user_id: &'a str,
        role: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>>;

    /// Addressed by user id. A 404 (not a member) is
    /// [`IdentityError::Rejected`] with status 404.
    fn remove_membership<'a>(
        &'a self,
        org: &'a str,
        user_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>>;

    /// Invitations with `status` (`Some("pending")`), or all.
    fn invitations<'a>(
        &'a self,
        org: &'a str,
        status: Option<&'a str>,
        page: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Invitation>>>;

    fn invitation<'a>(
        &'a self,
        org: &'a str,
        invitation_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Invitation>>;

    fn invite<'a>(
        &'a self,
        org: &'a str,
        invitation: &'a NewInvitation,
    ) -> BoxFuture<'a, IdentityResult<Invitation>>;

    fn revoke_invitation<'a>(
        &'a self,
        org: &'a str,
        invitation_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>>;

    /// Users with this email address, at most `limit`.
    fn users_by_email<'a>(
        &'a self,
        email: &'a str,
        limit: u32,
    ) -> BoxFuture<'a, IdentityResult<Vec<User>>>;

    /// The organizations a user belongs to, at most `limit`.
    fn user_memberships<'a>(
        &'a self,
        user_id: &'a str,
        limit: u32,
    ) -> BoxFuture<'a, IdentityResult<Vec<Membership>>>;

    fn delete_user<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, IdentityResult<()>>;

    /// A user's profile (`users.getUser`): the email addresses, for a label.
    /// Providers without the call answer [`IdentityError::Unavailable`].
    fn user_profile<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, IdentityResult<UserProfile>> {
        let _ = user_id;
        Box::pin(async { Err(IdentityError::Unavailable("no user profiles".to_owned())) })
    }

    /// A short-lived, single-use sign-in token for `user_id`
    /// (`signInTokens.createSignInToken`), as the desktop shell's handoff
    /// uses. Providers without one answer [`IdentityError::Unavailable`].
    fn create_sign_in_token<'a>(
        &'a self,
        user_id: &'a str,
        expires_in_seconds: u32,
    ) -> BoxFuture<'a, IdentityResult<String>> {
        let _ = (user_id, expires_in_seconds);
        Box::pin(async { Err(IdentityError::Unavailable("no sign-in tokens".to_owned())) })
    }

    /// Change a user's name (`users.updateUser`).
    fn update_user<'a>(
        &'a self,
        user_id: &'a str,
        changes: &'a UserChanges,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        let _ = (user_id, changes);
        unavailable("no user updates")
    }

    /// Merge `public_metadata` into the user's (`users.updateUserMetadata`):
    /// top-level keys are replaced, a `null` value removes its key.
    fn update_user_metadata<'a>(
        &'a self,
        user_id: &'a str,
        public_metadata: &'a Value,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        let _ = (user_id, public_metadata);
        unavailable("no user metadata")
    }

    /// Create an organization (a new workspace, provider side), with its
    /// creator as an admin member when `created_by` is set.
    fn create_organization<'a>(
        &'a self,
        organization: &'a NewOrganization,
    ) -> BoxFuture<'a, IdentityResult<Organization>> {
        let _ = organization;
        unavailable("no organization creation")
    }

    /// Merge metadata into the organization's, like
    /// [`Identity::update_user_metadata`]; `None` leaves that kind alone.
    fn update_organization_metadata<'a>(
        &'a self,
        org: &'a str,
        public_metadata: Option<&'a Value>,
        private_metadata: Option<&'a Value>,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        let _ = (org, public_metadata, private_metadata);
        unavailable("no organization metadata")
    }

    /// The changes recorded at or after `since` (RFC 3339; `None`: from the
    /// start), oldest first, at most `limit`. What a provider without
    /// webhooks offers instead, for the identity sync to poll.
    fn changes_since<'a>(
        &'a self,
        since: Option<&'a str>,
        limit: u32,
    ) -> BoxFuture<'a, IdentityResult<Vec<ChangeEvent>>> {
        let _ = (since, limit);
        unavailable("no change feed")
    }
}

fn unavailable<T: Send + 'static>(what: &str) -> BoxFuture<'static, IdentityResult<T>> {
    let error = IdentityError::Unavailable(what.to_owned());
    Box::pin(async move { Err(error) })
}

/// A user's email addresses and name, as [`Identity::user_profile`] reads
/// them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UserProfile {
    pub id: String,
    /// `(id, address)`, in the provider's order.
    pub email_addresses: Vec<(String, String)>,
    pub primary_email_address_id: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub image_url: Option<String>,
}

impl UserProfile {
    /// The primary address, else the first one.
    pub fn primary_email(&self) -> Option<&str> {
        self.email_addresses
            .iter()
            .find(|(id, _)| Some(id) == self.primary_email_address_id.as_ref())
            .or_else(|| self.email_addresses.first())
            .map(|(_, address)| address.as_str())
    }

    /// The first address, primary or not (`email_addresses?.[0]`).
    pub fn first_email(&self) -> Option<&str> {
        self.email_addresses
            .first()
            .map(|(_, address)| address.as_str())
    }
}

/// The provider a request uses: the app's, or (conformance mode) the
/// test's, as a request extension.
#[derive(Clone)]
pub struct IdentityProvider(pub Arc<dyn Identity>);

impl fmt::Debug for IdentityProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("IdentityProvider")
    }
}

/// Call `f` on the provider, or fail with [`IdentityError::Unavailable`]
/// when there is none.
pub async fn with_identity<'a, T, F>(
    provider: Option<&'a Arc<dyn Identity>>,
    f: F,
) -> IdentityResult<T>
where
    F: FnOnce(&'a dyn Identity) -> BoxFuture<'a, IdentityResult<T>>,
{
    match provider {
        Some(identity) => f(identity.as_ref()).await,
        None => Err(IdentityError::Unavailable(
            "no identity provider is configured".to_owned(),
        )),
    }
}

// ── the in-memory double ─────────────────────────────────────────────────────

/// One call [`MemoryIdentity`] received, for assertions.
#[derive(Debug, Clone, PartialEq)]
pub enum IdentityCall {
    Organization(String),
    UpdateOrganization(String, OrganizationChanges),
    DeleteOrganization(String),
    Memberships(String, ListPage),
    AddMembership(String, NewMembership),
    SetMembershipRole(String, String, String),
    RemoveMembership(String, String),
    Invitations(String, Option<String>, ListPage),
    Invitation(String, String),
    Invite(String, NewInvitation),
    RevokeInvitation(String, String),
    UsersByEmail(String, u32),
    UserMemberships(String, u32),
    DeleteUser(String),
    UserProfile(String),
    UpdateUser(String, UserChanges),
    UpdateUserMetadata(String, Value),
    CreateOrganization(NewOrganization),
    UpdateOrganizationMetadata(String, Option<Value>, Option<Value>),
    ChangesSince(Option<String>, u32),
}

#[derive(Debug, Default)]
struct MemoryState {
    organizations: BTreeMap<String, Organization>,
    /// Per organization.
    memberships: BTreeMap<String, Vec<Membership>>,
    /// Per organization.
    invitations: BTreeMap<String, Vec<Invitation>>,
    /// Email → user ids.
    users: BTreeMap<String, Vec<String>>,
    /// User id → profile.
    profiles: BTreeMap<String, UserProfile>,
    /// User id → public metadata.
    user_metadata: BTreeMap<String, Value>,
    /// The change feed, oldest first.
    changes: Vec<ChangeEvent>,
    calls: Vec<IdentityCall>,
    next_id: u64,
    /// Refuse every call with this error, when set.
    failure: Option<IdentityError>,
}

/// An identity provider in memory: organizations, memberships, invitations
/// and users seeded by the test, every call recorded.
#[derive(Debug, Default)]
pub struct MemoryIdentity {
    state: Mutex<MemoryState>,
}

fn not_found() -> IdentityError {
    IdentityError::Rejected {
        status: 404,
        code: Some("resource_not_found".to_owned()),
        message: None,
    }
}

impl MemoryIdentity {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, MemoryState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[must_use]
    pub fn with_organization(self, organization: Organization) -> Self {
        self.lock()
            .organizations
            .insert(organization.id.clone(), organization);
        self
    }

    #[must_use]
    pub fn with_membership(self, org: &str, membership: Membership) -> Self {
        self.lock()
            .memberships
            .entry(org.to_owned())
            .or_default()
            .push(membership);
        self
    }

    #[must_use]
    pub fn with_invitation(self, org: &str, invitation: Invitation) -> Self {
        self.lock()
            .invitations
            .entry(org.to_owned())
            .or_default()
            .push(invitation);
        self
    }

    #[must_use]
    pub fn with_user(self, email: &str, user_id: &str) -> Self {
        self.lock()
            .users
            .entry(email.to_ascii_lowercase())
            .or_default()
            .push(user_id.to_owned());
        self
    }

    /// A user with a profile (and their first address findable by email).
    #[must_use]
    pub fn with_profile(self, profile: UserProfile) -> Self {
        {
            let mut state = self.lock();
            if let Some(email) = profile.first_email() {
                state
                    .users
                    .entry(email.to_ascii_lowercase())
                    .or_default()
                    .push(profile.id.clone());
            }
            state.profiles.insert(profile.id.clone(), profile);
        }
        self
    }

    /// Record a change for [`Identity::changes_since`] (the feed of a
    /// provider without webhooks), at `at` (RFC 3339).
    pub fn record_change(&self, at: &str, change: IdentityChange) {
        self.lock().changes.push(ChangeEvent {
            at: at.to_owned(),
            change,
        });
    }

    /// Remove a user: their profile, email and memberships go.
    pub fn remove_user(&self, user_id: &str) {
        let mut state = self.lock();
        state.profiles.remove(user_id);
        for ids in state.users.values_mut() {
            ids.retain(|id| id != user_id);
        }
        for list in state.memberships.values_mut() {
            list.retain(|m| m.user.user_id != user_id);
        }
    }

    /// The organization now, when it exists.
    pub fn organization_now(&self, org: &str) -> Option<Organization> {
        self.lock().organizations.get(org).cloned()
    }

    /// A user's public metadata now.
    pub fn user_metadata_of(&self, user_id: &str) -> Value {
        self.lock()
            .user_metadata
            .get(user_id)
            .cloned()
            .unwrap_or(Value::Null)
    }

    /// Every later call fails with `error`.
    pub fn fail_with(&self, error: IdentityError) {
        self.lock().failure = Some(error);
    }

    pub fn calls(&self) -> Vec<IdentityCall> {
        self.lock().calls.clone()
    }

    /// The organization's memberships now.
    pub fn memberships_of(&self, org: &str) -> Vec<Membership> {
        self.lock()
            .memberships
            .get(org)
            .cloned()
            .unwrap_or_default()
    }

    /// The organization's invitations now.
    pub fn invitations_of(&self, org: &str) -> Vec<Invitation> {
        self.lock()
            .invitations
            .get(org)
            .cloned()
            .unwrap_or_default()
    }

    /// Record `call`, then answer with `f` unless a failure is set.
    fn answer<T: Send + 'static>(
        &self,
        call: IdentityCall,
        f: impl FnOnce(&mut MemoryState) -> IdentityResult<T>,
    ) -> BoxFuture<'static, IdentityResult<T>> {
        let mut state = self.lock();
        state.calls.push(call);
        let result = match state.failure.clone() {
            Some(error) => Err(error),
            None => f(&mut state),
        };
        Box::pin(std::future::ready(result))
    }
}

impl MemoryState {
    fn next(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}_{}", self.next_id)
    }
}

/// Clerk's metadata merge: `patch`'s top-level keys replace `current`'s, a
/// `null` removes its key.
pub fn merge_metadata(current: &Value, patch: &Value) -> Value {
    let mut merged = current.as_object().cloned().unwrap_or_default();
    if let Some(patch) = patch.as_object() {
        for (key, value) in patch {
            if value.is_null() {
                merged.remove(key);
            } else {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    Value::Object(merged)
}

fn page_of<T: Clone>(items: &[T], page: ListPage) -> Listing<T> {
    let offset = page.offset.unwrap_or(0) as usize;
    let limit = page.limit.map_or(usize::MAX, |l| l as usize);
    Listing {
        data: items.iter().skip(offset).take(limit).cloned().collect(),
        total_count: Some(items.len() as u64),
    }
}

impl Identity for MemoryIdentity {
    fn organization<'a>(&'a self, org: &'a str) -> BoxFuture<'a, IdentityResult<Organization>> {
        self.answer(IdentityCall::Organization(org.to_owned()), |s| {
            s.organizations.get(org).cloned().ok_or_else(not_found)
        })
    }

    fn update_organization<'a>(
        &'a self,
        org: &'a str,
        changes: &'a OrganizationChanges,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        self.answer(
            IdentityCall::UpdateOrganization(org.to_owned(), changes.clone()),
            |s| {
                let organization = s.organizations.get_mut(org).ok_or_else(not_found)?;
                if let Some(name) = &changes.name {
                    organization.name.clone_from(name);
                }
                if let Some(slug) = &changes.slug {
                    organization.slug = Some(slug.clone());
                }
                if let Some(cap) = changes.max_memberships {
                    organization.max_memberships = Some(cap);
                }
                Ok(())
            },
        )
    }

    fn delete_organization<'a>(&'a self, org: &'a str) -> BoxFuture<'a, IdentityResult<()>> {
        self.answer(IdentityCall::DeleteOrganization(org.to_owned()), |s| {
            s.organizations
                .remove(org)
                .map(|_| ())
                .ok_or_else(not_found)
        })
    }

    fn memberships<'a>(
        &'a self,
        org: &'a str,
        page: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Membership>>> {
        self.answer(IdentityCall::Memberships(org.to_owned(), page), |s| {
            Ok(page_of(
                s.memberships.get(org).map_or(&[][..], Vec::as_slice),
                page,
            ))
        })
    }

    fn add_membership<'a>(
        &'a self,
        org: &'a str,
        membership: &'a NewMembership,
    ) -> BoxFuture<'a, IdentityResult<Membership>> {
        self.answer(
            IdentityCall::AddMembership(org.to_owned(), membership.clone()),
            |s| {
                let list = s.memberships.entry(org.to_owned()).or_default();
                if list.iter().any(|m| m.user.user_id == membership.user_id) {
                    return Err(IdentityError::Rejected {
                        status: 400,
                        code: Some("already_a_member_in_organization".to_owned()),
                        message: None,
                    });
                }
                let id = s.next("orgmem");
                let created = Membership {
                    id,
                    role: membership.role.clone(),
                    created_at: None,
                    public_metadata: membership.public_metadata.clone().unwrap_or(Value::Null),
                    user: MemberUser {
                        user_id: membership.user_id.clone(),
                        ..MemberUser::default()
                    },
                    organization: None,
                };
                s.memberships
                    .entry(org.to_owned())
                    .or_default()
                    .push(created.clone());
                Ok(created)
            },
        )
    }

    fn set_membership_role<'a>(
        &'a self,
        org: &'a str,
        user_id: &'a str,
        role: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        self.answer(
            IdentityCall::SetMembershipRole(org.to_owned(), user_id.to_owned(), role.to_owned()),
            |s| {
                let membership = s
                    .memberships
                    .get_mut(org)
                    .and_then(|list| list.iter_mut().find(|m| m.user.user_id == user_id))
                    .ok_or_else(not_found)?;
                role.clone_into(&mut membership.role);
                Ok(())
            },
        )
    }

    fn remove_membership<'a>(
        &'a self,
        org: &'a str,
        user_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        self.answer(
            IdentityCall::RemoveMembership(org.to_owned(), user_id.to_owned()),
            |s| {
                let list = s.memberships.get_mut(org).ok_or_else(not_found)?;
                let before = list.len();
                list.retain(|m| m.user.user_id != user_id);
                if list.len() == before {
                    Err(not_found())
                } else {
                    Ok(())
                }
            },
        )
    }

    fn invitations<'a>(
        &'a self,
        org: &'a str,
        status: Option<&'a str>,
        page: ListPage,
    ) -> BoxFuture<'a, IdentityResult<Listing<Invitation>>> {
        self.answer(
            IdentityCall::Invitations(org.to_owned(), status.map(str::to_owned), page),
            |s| {
                let matching: Vec<Invitation> = s
                    .invitations
                    .get(org)
                    .map(|list| {
                        list.iter()
                            .filter(|i| status.is_none_or(|status| i.status == status))
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();
                Ok(page_of(&matching, page))
            },
        )
    }

    fn invitation<'a>(
        &'a self,
        org: &'a str,
        invitation_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<Invitation>> {
        self.answer(
            IdentityCall::Invitation(org.to_owned(), invitation_id.to_owned()),
            |s| {
                s.invitations
                    .get(org)
                    .and_then(|list| list.iter().find(|i| i.id == invitation_id))
                    .cloned()
                    .ok_or_else(not_found)
            },
        )
    }

    fn invite<'a>(
        &'a self,
        org: &'a str,
        invitation: &'a NewInvitation,
    ) -> BoxFuture<'a, IdentityResult<Invitation>> {
        self.answer(
            IdentityCall::Invite(org.to_owned(), invitation.clone()),
            |s| {
                let id = s.next("orginv");
                let created = Invitation {
                    id,
                    email_address: invitation.email_address.clone(),
                    role: invitation.role.clone(),
                    status: "pending".to_owned(),
                    public_metadata: invitation.public_metadata.clone().unwrap_or(Value::Null),
                    created_at: None,
                    expires_at: None,
                };
                s.invitations
                    .entry(org.to_owned())
                    .or_default()
                    .push(created.clone());
                Ok(created)
            },
        )
    }

    fn revoke_invitation<'a>(
        &'a self,
        org: &'a str,
        invitation_id: &'a str,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        self.answer(
            IdentityCall::RevokeInvitation(org.to_owned(), invitation_id.to_owned()),
            |s| {
                let invitation = s
                    .invitations
                    .get_mut(org)
                    .and_then(|list| list.iter_mut().find(|i| i.id == invitation_id))
                    .ok_or_else(not_found)?;
                "revoked".clone_into(&mut invitation.status);
                Ok(())
            },
        )
    }

    fn users_by_email<'a>(
        &'a self,
        email: &'a str,
        limit: u32,
    ) -> BoxFuture<'a, IdentityResult<Vec<User>>> {
        self.answer(IdentityCall::UsersByEmail(email.to_owned(), limit), |s| {
            Ok(s.users
                .get(&email.to_ascii_lowercase())
                .map(|ids| {
                    ids.iter()
                        .take(limit as usize)
                        .map(|id| User { id: id.clone() })
                        .collect()
                })
                .unwrap_or_default())
        })
    }

    fn user_memberships<'a>(
        &'a self,
        user_id: &'a str,
        limit: u32,
    ) -> BoxFuture<'a, IdentityResult<Vec<Membership>>> {
        self.answer(
            IdentityCall::UserMemberships(user_id.to_owned(), limit),
            |s| {
                let mut found = Vec::new();
                for (org, list) in &s.memberships {
                    for membership in list.iter().filter(|m| m.user.user_id == user_id) {
                        let organization = s.organizations.get(org);
                        found.push(Membership {
                            organization: Some(OrganizationRef {
                                id: org.clone(),
                                name: organization.map(|o| o.name.clone()).unwrap_or_default(),
                                slug: organization
                                    .and_then(|o| o.slug.clone())
                                    .unwrap_or_default(),
                            }),
                            ..membership.clone()
                        });
                    }
                }
                found.truncate(limit as usize);
                Ok(found)
            },
        )
    }

    fn delete_user<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, IdentityResult<()>> {
        self.answer(IdentityCall::DeleteUser(user_id.to_owned()), |s| {
            for list in s.memberships.values_mut() {
                list.retain(|m| m.user.user_id != user_id);
            }
            Ok(())
        })
    }

    fn user_profile<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, IdentityResult<UserProfile>> {
        self.answer(IdentityCall::UserProfile(user_id.to_owned()), |s| {
            s.profiles.get(user_id).cloned().ok_or_else(not_found)
        })
    }

    fn update_user<'a>(
        &'a self,
        user_id: &'a str,
        changes: &'a UserChanges,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        self.answer(
            IdentityCall::UpdateUser(user_id.to_owned(), changes.clone()),
            |s| {
                let profile = s.profiles.get_mut(user_id).ok_or_else(not_found)?;
                if let Some(first) = &changes.first_name {
                    profile.first_name = Some(first.clone());
                }
                if let Some(last) = &changes.last_name {
                    profile.last_name = Some(last.clone());
                }
                Ok(())
            },
        )
    }

    fn update_user_metadata<'a>(
        &'a self,
        user_id: &'a str,
        public_metadata: &'a Value,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        self.answer(
            IdentityCall::UpdateUserMetadata(user_id.to_owned(), public_metadata.clone()),
            |s| {
                let current = s.user_metadata.get(user_id).cloned().unwrap_or(Value::Null);
                s.user_metadata.insert(
                    user_id.to_owned(),
                    merge_metadata(&current, public_metadata),
                );
                Ok(())
            },
        )
    }

    fn create_organization<'a>(
        &'a self,
        organization: &'a NewOrganization,
    ) -> BoxFuture<'a, IdentityResult<Organization>> {
        self.answer(
            IdentityCall::CreateOrganization(organization.clone()),
            |s| {
                if let Some(slug) = &organization.slug
                    && s.organizations
                        .values()
                        .any(|o| o.slug.as_deref() == Some(slug))
                {
                    return Err(IdentityError::Rejected {
                        status: 422,
                        code: Some("form_identifier_exists".to_owned()),
                        message: Some("That slug is taken.".to_owned()),
                    });
                }
                let id = s.next("org");
                let created = Organization {
                    id: id.clone(),
                    name: organization.name.clone(),
                    slug: Some(
                        organization
                            .slug
                            .clone()
                            .unwrap_or_else(|| format!("slug-{id}")),
                    ),
                    max_memberships: None,
                    public_metadata: organization.public_metadata.clone().unwrap_or(Value::Null),
                    private_metadata: organization.private_metadata.clone().unwrap_or(Value::Null),
                };
                s.organizations.insert(id.clone(), created.clone());
                if let Some(creator) = &organization.created_by {
                    let membership_id = s.next("orgmem");
                    s.memberships.entry(id).or_default().push(Membership {
                        id: membership_id,
                        role: "org:admin".to_owned(),
                        created_at: None,
                        public_metadata: Value::Null,
                        user: MemberUser {
                            user_id: creator.clone(),
                            ..MemberUser::default()
                        },
                        organization: None,
                    });
                }
                Ok(created)
            },
        )
    }

    fn update_organization_metadata<'a>(
        &'a self,
        org: &'a str,
        public_metadata: Option<&'a Value>,
        private_metadata: Option<&'a Value>,
    ) -> BoxFuture<'a, IdentityResult<()>> {
        self.answer(
            IdentityCall::UpdateOrganizationMetadata(
                org.to_owned(),
                public_metadata.cloned(),
                private_metadata.cloned(),
            ),
            |s| {
                let organization = s.organizations.get_mut(org).ok_or_else(not_found)?;
                if let Some(patch) = public_metadata {
                    organization.public_metadata =
                        merge_metadata(&organization.public_metadata, patch);
                }
                if let Some(patch) = private_metadata {
                    organization.private_metadata =
                        merge_metadata(&organization.private_metadata, patch);
                }
                Ok(())
            },
        )
    }

    fn changes_since<'a>(
        &'a self,
        since: Option<&'a str>,
        limit: u32,
    ) -> BoxFuture<'a, IdentityResult<Vec<ChangeEvent>>> {
        self.answer(
            IdentityCall::ChangesSince(since.map(str::to_owned), limit),
            |s| {
                Ok(s.changes
                    .iter()
                    .filter(|event| since.is_none_or(|since| event.at.as_str() >= since))
                    .take(limit as usize)
                    .cloned()
                    .collect())
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_identity_invites_revokes_and_records() {
        let identity = MemoryIdentity::new().with_organization(Organization {
            id: "org_1".to_owned(),
            name: "Acme".to_owned(),
            ..Organization::default()
        });
        let invitation = identity
            .invite(
                "org_1",
                &NewInvitation {
                    email_address: "a@acme.test".to_owned(),
                    role: "org:member".to_owned(),
                    ..NewInvitation::default()
                },
            )
            .await
            .expect("invite");
        let pending = identity
            .invitations("org_1", Some("pending"), ListPage::limit(500))
            .await
            .expect("list");
        assert_eq!(pending.total_count, Some(1));
        identity
            .revoke_invitation("org_1", &invitation.id)
            .await
            .expect("revoke");
        let pending = identity
            .invitations("org_1", Some("pending"), ListPage::default())
            .await
            .expect("list");
        assert_eq!(pending.data.len(), 0);
        assert_eq!(identity.calls().len(), 4);
    }

    #[tokio::test]
    async fn a_missing_membership_is_a_404() {
        let identity = MemoryIdentity::new();
        let error = identity
            .remove_membership("org_1", "user_1")
            .await
            .expect_err("not a member");
        assert!(error.is_not_found());
    }

    #[tokio::test]
    async fn no_provider_is_unavailable() {
        let result = with_identity(None, |identity| identity.delete_user("user_1")).await;
        assert!(matches!(result, Err(IdentityError::Unavailable(_))));
    }

    #[tokio::test]
    async fn a_set_failure_refuses_every_call() {
        let identity: Arc<dyn Identity> = {
            let memory = MemoryIdentity::new();
            memory.fail_with(IdentityError::Rejected {
                status: 503,
                code: None,
                message: None,
            });
            Arc::new(memory)
        };
        let result = with_identity(Some(&identity), |i| i.organization("org_1")).await;
        assert_eq!(result.expect_err("refused").status(), Some(503));
    }
}
