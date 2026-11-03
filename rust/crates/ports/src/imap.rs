//! IMAP: an authenticated session on someone's mailbox, with the commands
//! the WeldReach warmup network needs (`@weldsuite/imap`'s `ImapSession`):
//! select a folder, find a message by its Message-ID, find a SPECIAL-USE
//! folder (Junk, Trash, Sent, …), move, add flags, delete, log out.
//!
//! The TypeScript worker speaks IMAP over `cloudflare:sockets`; the
//! Kubernetes editions over TCP and rustls (`weldsuite-adapters-oss`'s
//! `AsyncImapConnector`). Every failure is an [`ImapError`] whose
//! [`ImapErrorKind`] says whether retrying can help: a rejected login
//! ([`ImapError::auth_failed`]) needs a person, a connection error or a
//! timeout is usually transient.
//!
//! [`MemoryImap`] is a mailbox server in memory, for tests.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use crate::BoxFuture;

/// `ImapConfig`: where and as whom to log in.
#[derive(Clone, PartialEq, Eq)]
pub struct ImapConfig {
    pub host: String,
    /// 993 (implicit TLS). Plain 143 / STARTTLS is not supported.
    pub port: u16,
    pub username: String,
    pub password: String,
    /// Per-command timeout (`commandTimeoutMs`, default 20 s).
    pub command_timeout: Duration,
}

/// `DEFAULT_COMMAND_TIMEOUT_MS`.
pub const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
/// The one port IMAP is spoken on: implicit TLS.
pub const IMAPS_PORT: u16 = 993;

impl ImapConfig {
    pub fn new(host: &str, port: u16, username: &str, password: &str) -> Self {
        Self {
            host: host.to_owned(),
            port,
            username: username.to_owned(),
            password: password.to_owned(),
            command_timeout: DEFAULT_COMMAND_TIMEOUT,
        }
    }
}

impl fmt::Debug for ImapConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ImapConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .field("command_timeout", &self.command_timeout)
            .finish()
    }
}

/// `ImapErrorKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImapErrorKind {
    /// TCP/TLS connect failed or the connection dropped.
    Connect,
    /// LOGIN rejected: credentials or account need attention.
    Auth,
    /// The server answered NO/BAD to a command.
    Command,
    /// The server's reply could not be parsed.
    Protocol,
    /// No reply within the command timeout.
    Timeout,
}

impl ImapErrorKind {
    /// The kind as TypeScript names it (`imap_<kind>` in stored errors).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::Auth => "auth",
            Self::Command => "command",
            Self::Protocol => "protocol",
            Self::Timeout => "timeout",
        }
    }
}

/// `ImapError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImapError {
    pub kind: ImapErrorKind,
    pub message: String,
    /// The command that failed, e.g. `UID MOVE`.
    pub command: Option<String>,
    /// Server text of a NO/BAD reply.
    pub response: Option<String>,
}

impl ImapError {
    pub fn new(kind: ImapErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            command: None,
            response: None,
        }
    }

    #[must_use]
    pub fn with_command(mut self, command: &str) -> Self {
        self.command = Some(command.to_owned());
        self
    }

    #[must_use]
    pub fn with_response(mut self, response: impl Into<String>) -> Self {
        self.response = Some(response.into());
        self
    }

    /// Login failures need a person (new password, unlocked account);
    /// retrying won't help.
    pub fn auth_failed(&self) -> bool {
        self.kind == ImapErrorKind::Auth
    }

    /// `err.response ?? err.message`.
    pub fn detail(&self) -> &str {
        self.response.as_deref().unwrap_or(&self.message)
    }
}

impl fmt::Display for ImapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ImapError {}

/// RFC 6154 SPECIAL-USE attributes the warmup engine cares about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SpecialUse {
    Junk,
    Trash,
    Sent,
    Drafts,
    Archive,
    All,
}

impl SpecialUse {
    pub const ALL_USES: [Self; 6] = [
        Self::Junk,
        Self::Trash,
        Self::Sent,
        Self::Drafts,
        Self::Archive,
        Self::All,
    ];

    /// The LIST attribute, e.g. `\Junk`.
    pub fn attribute(self) -> &'static str {
        match self {
            Self::Junk => "\\Junk",
            Self::Trash => "\\Trash",
            Self::Sent => "\\Sent",
            Self::Drafts => "\\Drafts",
            Self::Archive => "\\Archive",
            Self::All => "\\All",
        }
    }

    /// `FALLBACK_NAMES`: well-known folder names, in order of preference,
    /// for servers that do not label them with SPECIAL-USE.
    pub fn fallback_names(self) -> &'static [&'static str] {
        match self {
            Self::Junk => &[
                "junk",
                "spam",
                "[gmail]/spam",
                "junk e-mail",
                "junk email",
                "bulk mail",
            ],
            Self::Trash => &[
                "trash",
                "deleted items",
                "deleted messages",
                "deleted",
                "[gmail]/trash",
                "bin",
                "[gmail]/bin",
            ],
            Self::Sent => &[
                "sent",
                "sent items",
                "sent messages",
                "sent mail",
                "[gmail]/sent mail",
            ],
            Self::Drafts => &["drafts", "draft", "[gmail]/drafts"],
            Self::Archive => &["archive", "archives"],
            Self::All => &["all mail", "[gmail]/all mail"],
        }
    }
}

/// `ImapMailboxInfo`: one LIST entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailboxInfo {
    /// The mailbox name as the server reports it.
    pub name: String,
    pub delimiter: Option<String>,
    /// Attributes from LIST, e.g. `\HasNoChildren`, `\Junk`.
    pub attributes: Vec<String>,
    pub special_use: Option<SpecialUse>,
}

impl MailboxInfo {
    pub fn new(name: &str, delimiter: Option<&str>, attributes: Vec<String>) -> Self {
        let special_use = special_use_of(&attributes);
        Self {
            name: name.to_owned(),
            delimiter: delimiter.map(str::to_owned),
            attributes,
            special_use,
        }
    }

    fn is_selectable(&self) -> bool {
        !self.attributes.iter().any(|attribute| {
            let lower = attribute.to_lowercase();
            lower == "\\noselect" || lower == "\\nonexistent"
        })
    }

    fn last_segment(&self) -> &str {
        match self.delimiter.as_deref() {
            None | Some("") => &self.name,
            Some(delimiter) => self
                .name
                .rfind(delimiter)
                .map_or(self.name.as_str(), |at| &self.name[at + delimiter.len()..]),
        }
    }
}

/// `specialUseOf(attributes)`.
pub fn special_use_of(attributes: &[String]) -> Option<SpecialUse> {
    attributes.iter().find_map(|attribute| {
        let lower = attribute.to_lowercase();
        SpecialUse::ALL_USES
            .into_iter()
            .find(|use_| use_.attribute().to_lowercase() == lower)
    })
}

/// `findSpecialUse`'s choice: the selectable mailbox carrying the
/// attribute, else the first well-known name (whole name first, then the
/// last path segment).
pub fn pick_special_use(mailboxes: &[MailboxInfo], use_: SpecialUse) -> Option<String> {
    let selectable: Vec<&MailboxInfo> = mailboxes.iter().filter(|m| m.is_selectable()).collect();
    if let Some(labelled) = selectable.iter().find(|m| m.special_use == Some(use_)) {
        return Some(labelled.name.clone());
    }
    let names = use_.fallback_names();
    for candidate in names {
        if let Some(exact) = selectable
            .iter()
            .find(|m| m.name.to_lowercase() == *candidate)
        {
            return Some(exact.name.clone());
        }
    }
    for candidate in names {
        if let Some(nested) = selectable
            .iter()
            .find(|m| m.last_segment().to_lowercase() == *candidate)
        {
            return Some(nested.name.clone());
        }
    }
    None
}

/// `bracketed(messageId)`: `<id@host>`, the angle brackets added when
/// missing. An empty id or one with CR, LF or NUL is refused.
pub fn bracketed_message_id(message_id: &str) -> Result<String, ImapError> {
    let mut inner = message_id.trim();
    inner = inner.strip_prefix('<').unwrap_or(inner);
    inner = inner.strip_suffix('>').unwrap_or(inner);
    if inner.is_empty() || inner.contains(['\r', '\n', '\0']) {
        return Err(
            ImapError::new(ImapErrorKind::Command, "Invalid Message-ID").with_command("UID SEARCH")
        );
    }
    Ok(format!("<{inner}>"))
}

/// `ImapSelectResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectResult {
    pub exists: u32,
    pub uid_validity: Option<u32>,
}

/// An authenticated IMAP connection. Always [`ImapSession::logout`] it (also
/// after an error) to free the socket.
pub trait ImapSession: Send {
    /// `LIST "" "*"` (with `RETURN (SPECIAL-USE)` when supported).
    fn list_mailboxes(&mut self) -> BoxFuture<'_, Result<Vec<MailboxInfo>, ImapError>>;
    /// The mailbox carrying a SPECIAL-USE attribute, or a well-known name
    /// ([`pick_special_use`]); `None` when there is none. Lists once per
    /// session.
    fn find_special_use(
        &mut self,
        use_: SpecialUse,
    ) -> BoxFuture<'_, Result<Option<String>, ImapError>>;
    fn select<'a>(&'a mut self, mailbox: &'a str)
    -> BoxFuture<'a, Result<SelectResult, ImapError>>;
    /// UIDs in the selected mailbox whose Message-ID header matches (angle
    /// brackets optional), ascending, without duplicates.
    fn search_by_message_id<'a>(
        &'a mut self,
        message_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u32>, ImapError>>;
    /// `UID STORE +FLAGS.SILENT` (e.g. `\Seen`, `\Flagged`).
    fn add_flags<'a>(
        &'a mut self,
        uids: &'a [u32],
        flags: &'a [&'a str],
    ) -> BoxFuture<'a, Result<(), ImapError>>;
    /// `UID MOVE` when supported, else `UID COPY` + `\Deleted` + expunge.
    fn move_messages<'a>(
        &'a mut self,
        uids: &'a [u32],
        destination: &'a str,
    ) -> BoxFuture<'a, Result<(), ImapError>>;
    /// Mark `\Deleted` and expunge only these UIDs (`UID EXPUNGE` with
    /// UIDPLUS, else `EXPUNGE`).
    fn delete_messages<'a>(&'a mut self, uids: &'a [u32]) -> BoxFuture<'a, Result<(), ImapError>>;
    /// LOGOUT and close the connection. Never fails.
    fn logout(self: Box<Self>) -> BoxFuture<'static, ()>;
}

/// Opens sessions: `connectImap(config)`. Object safe.
pub trait ImapConnector: Send + Sync {
    fn connect<'a>(
        &'a self,
        config: &'a ImapConfig,
    ) -> BoxFuture<'a, Result<Box<dyn ImapSession>, ImapError>>;
}

impl<T: ImapConnector + ?Sized> ImapConnector for Arc<T> {
    fn connect<'a>(
        &'a self,
        config: &'a ImapConfig,
    ) -> BoxFuture<'a, Result<Box<dyn ImapSession>, ImapError>> {
        (**self).connect(config)
    }
}

/// One message in a [`MemoryImap`] folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryMessage {
    pub uid: u32,
    /// The Message-ID header, with angle brackets.
    pub message_id: String,
    pub flags: BTreeSet<String>,
}

#[derive(Debug, Clone)]
struct MemoryFolder {
    special_use: Option<SpecialUse>,
    messages: Vec<MemoryMessage>,
    next_uid: u32,
}

#[derive(Debug, Clone)]
struct MemoryAccount {
    password: String,
    folders: BTreeMap<String, MemoryFolder>,
}

#[derive(Debug, Default)]
struct MemoryState {
    accounts: HashMap<String, MemoryAccount>,
    /// Errors the next connects of a user fail with, in order.
    connect_failures: HashMap<String, Vec<ImapError>>,
    /// Commands that fail once for a user: `(command, error)`.
    command_failures: HashMap<String, Vec<(String, ImapError)>>,
    log: Vec<String>,
}

/// An IMAP server in memory, for tests: accounts with folders and
/// messages, logins checked against a password, failures injected per user,
/// and a log of the commands sessions ran (`user: COMMAND args`).
#[derive(Debug, Clone, Default)]
pub struct MemoryImap {
    state: Arc<Mutex<MemoryState>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl MemoryImap {
    pub fn new() -> Self {
        Self::default()
    }

    /// An account with an empty INBOX.
    pub fn add_account(&self, username: &str, password: &str) {
        let mut folders = BTreeMap::new();
        folders.insert(
            "INBOX".to_owned(),
            MemoryFolder {
                special_use: None,
                messages: Vec::new(),
                next_uid: 1,
            },
        );
        lock(&self.state).accounts.insert(
            username.to_owned(),
            MemoryAccount {
                password: password.to_owned(),
                folders,
            },
        );
    }

    pub fn add_folder(&self, username: &str, name: &str, special_use: Option<SpecialUse>) {
        if let Some(account) = lock(&self.state).accounts.get_mut(username) {
            account.folders.insert(
                name.to_owned(),
                MemoryFolder {
                    special_use,
                    messages: Vec::new(),
                    next_uid: 1,
                },
            );
        }
    }

    /// Puts a message in a folder; its UID.
    pub fn deliver(&self, username: &str, folder: &str, message_id: &str) -> Option<u32> {
        let id = bracketed_message_id(message_id).ok()?;
        let mut state = lock(&self.state);
        let folder = state.accounts.get_mut(username)?.folders.get_mut(folder)?;
        let uid = folder.next_uid;
        folder.next_uid += 1;
        folder.messages.push(MemoryMessage {
            uid,
            message_id: id,
            flags: BTreeSet::new(),
        });
        Some(uid)
    }

    /// The messages of a folder, by UID.
    pub fn messages(&self, username: &str, folder: &str) -> Vec<MemoryMessage> {
        lock(&self.state)
            .accounts
            .get(username)
            .and_then(|account| account.folders.get(folder))
            .map(|folder| folder.messages.clone())
            .unwrap_or_default()
    }

    /// The user's next connect fails with `error` (after any queued before).
    pub fn fail_connect(&self, username: &str, error: ImapError) {
        lock(&self.state)
            .connect_failures
            .entry(username.to_owned())
            .or_default()
            .push(error);
    }

    /// The user's next `command` (e.g. `UID SEARCH`) fails with `error`.
    pub fn fail_command(&self, username: &str, command: &str, error: ImapError) {
        lock(&self.state)
            .command_failures
            .entry(username.to_owned())
            .or_default()
            .push((command.to_owned(), error));
    }

    /// Every command run, as `user: COMMAND args`.
    pub fn log(&self) -> Vec<String> {
        lock(&self.state).log.clone()
    }

    /// How many sessions logged in (`LOGIN` lines in the log).
    pub fn logins(&self, username: &str) -> usize {
        let line = format!("{username}: LOGIN");
        lock(&self.state)
            .log
            .iter()
            .filter(|entry| **entry == line)
            .count()
    }
}

impl ImapConnector for MemoryImap {
    fn connect<'a>(
        &'a self,
        config: &'a ImapConfig,
    ) -> BoxFuture<'a, Result<Box<dyn ImapSession>, ImapError>> {
        let result = (|| {
            let mut state = lock(&self.state);
            if let Some(queue) = state.connect_failures.get_mut(&config.username)
                && !queue.is_empty()
            {
                return Err(queue.remove(0));
            }
            let accepted = state
                .accounts
                .get(&config.username)
                .is_some_and(|account| account.password == config.password);
            if !accepted {
                return Err(ImapError::new(
                    ImapErrorKind::Auth,
                    "IMAP login rejected: NO [AUTHENTICATIONFAILED] Authentication failed.",
                )
                .with_command("LOGIN")
                .with_response("[AUTHENTICATIONFAILED] Authentication failed."));
            }
            state.log.push(format!("{}: LOGIN", config.username));
            Ok(Box::new(MemorySession {
                server: self.clone(),
                username: config.username.clone(),
                selected: None,
            }) as Box<dyn ImapSession>)
        })();
        Box::pin(std::future::ready(result))
    }
}

struct MemorySession {
    server: MemoryImap,
    username: String,
    selected: Option<String>,
}

impl MemorySession {
    /// Logs the command and takes an injected failure for it.
    fn run<T>(
        &mut self,
        command: &str,
        args: &str,
        body: impl FnOnce(&mut MemoryAccount, Option<&str>) -> Result<T, ImapError>,
    ) -> Result<T, ImapError> {
        let mut state = lock(&self.server.state);
        let line = if args.is_empty() {
            format!("{}: {command}", self.username)
        } else {
            format!("{}: {command} {args}", self.username)
        };
        state.log.push(line);
        if let Some(queue) = state.command_failures.get_mut(&self.username)
            && let Some(at) = queue.iter().position(|(c, _)| c == command)
        {
            return Err(queue.remove(at).1);
        }
        let account = state
            .accounts
            .get_mut(&self.username)
            .ok_or_else(|| ImapError::new(ImapErrorKind::Connect, "connection lost"))?;
        body(account, self.selected.as_deref())
    }

    fn folder_of<'f>(
        account: &'f mut MemoryAccount,
        selected: Option<&str>,
        command: &str,
    ) -> Result<&'f mut MemoryFolder, ImapError> {
        selected
            .and_then(|name| account.folders.get_mut(name))
            .ok_or_else(|| {
                ImapError::new(
                    ImapErrorKind::Command,
                    format!("{command} failed: BAD No mailbox selected"),
                )
                .with_command(command)
                .with_response("No mailbox selected")
            })
    }
}

fn uid_list(uids: &[u32]) -> String {
    uids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

impl ImapSession for MemorySession {
    fn list_mailboxes(&mut self) -> BoxFuture<'_, Result<Vec<MailboxInfo>, ImapError>> {
        let result = self.run("LIST", "\"\" \"*\"", |account, _| {
            Ok(account
                .folders
                .iter()
                .map(|(name, folder)| {
                    let attributes = folder
                        .special_use
                        .map(|use_| vec![use_.attribute().to_owned()])
                        .unwrap_or_default();
                    MailboxInfo::new(name, Some("/"), attributes)
                })
                .collect())
        });
        Box::pin(std::future::ready(result))
    }

    fn find_special_use(
        &mut self,
        use_: SpecialUse,
    ) -> BoxFuture<'_, Result<Option<String>, ImapError>> {
        Box::pin(async move {
            let mailboxes = self.list_mailboxes().await?;
            Ok(pick_special_use(&mailboxes, use_))
        })
    }

    fn select<'a>(
        &'a mut self,
        mailbox: &'a str,
    ) -> BoxFuture<'a, Result<SelectResult, ImapError>> {
        let result = self.run("SELECT", mailbox, |account, _| {
            account
                .folders
                .get(mailbox)
                .map(|folder| SelectResult {
                    exists: u32::try_from(folder.messages.len()).unwrap_or(u32::MAX),
                    uid_validity: Some(1),
                })
                .ok_or_else(|| {
                    ImapError::new(
                        ImapErrorKind::Command,
                        "SELECT failed: NO Mailbox doesn't exist",
                    )
                    .with_command("SELECT")
                    .with_response("Mailbox doesn't exist")
                })
        });
        if result.is_ok() {
            self.selected = Some(mailbox.to_owned());
        }
        Box::pin(std::future::ready(result))
    }

    fn search_by_message_id<'a>(
        &'a mut self,
        message_id: &'a str,
    ) -> BoxFuture<'a, Result<Vec<u32>, ImapError>> {
        let result = bracketed_message_id(message_id).and_then(|id| {
            self.run(
                "UID SEARCH",
                &format!("HEADER Message-ID {id}"),
                |account, selected| {
                    let folder = Self::folder_of(account, selected, "UID SEARCH")?;
                    Ok(folder
                        .messages
                        .iter()
                        .filter(|m| m.message_id.eq_ignore_ascii_case(&id))
                        .map(|m| m.uid)
                        .collect())
                },
            )
        });
        Box::pin(std::future::ready(result))
    }

    fn add_flags<'a>(
        &'a mut self,
        uids: &'a [u32],
        flags: &'a [&'a str],
    ) -> BoxFuture<'a, Result<(), ImapError>> {
        let result = if uids.is_empty() || flags.is_empty() {
            Ok(())
        } else {
            let args = format!("{} +FLAGS.SILENT ({})", uid_list(uids), flags.join(" "));
            self.run("UID STORE", &args, |account, selected| {
                let folder = Self::folder_of(account, selected, "UID STORE")?;
                for message in folder.messages.iter_mut().filter(|m| uids.contains(&m.uid)) {
                    message.flags.extend(flags.iter().map(|f| (*f).to_owned()));
                }
                Ok(())
            })
        };
        Box::pin(std::future::ready(result))
    }

    fn move_messages<'a>(
        &'a mut self,
        uids: &'a [u32],
        destination: &'a str,
    ) -> BoxFuture<'a, Result<(), ImapError>> {
        let result = if uids.is_empty() {
            Ok(())
        } else {
            let args = format!("{} {destination}", uid_list(uids));
            self.run("UID MOVE", &args, |account, selected| {
                if !account.folders.contains_key(destination) {
                    return Err(ImapError::new(
                        ImapErrorKind::Command,
                        "UID MOVE failed: NO [TRYCREATE] Mailbox doesn't exist",
                    )
                    .with_command("UID MOVE"));
                }
                let folder = Self::folder_of(account, selected, "UID MOVE")?;
                let (moving, staying): (Vec<_>, Vec<_>) = folder
                    .messages
                    .drain(..)
                    .partition(|m| uids.contains(&m.uid));
                folder.messages = staying;
                if let Some(target) = account.folders.get_mut(destination) {
                    for mut message in moving {
                        message.uid = target.next_uid;
                        target.next_uid += 1;
                        target.messages.push(message);
                    }
                }
                Ok(())
            })
        };
        Box::pin(std::future::ready(result))
    }

    fn delete_messages<'a>(&'a mut self, uids: &'a [u32]) -> BoxFuture<'a, Result<(), ImapError>> {
        let result = if uids.is_empty() {
            Ok(())
        } else {
            self.run("UID EXPUNGE", &uid_list(uids), |account, selected| {
                let folder = Self::folder_of(account, selected, "UID EXPUNGE")?;
                folder.messages.retain(|m| !uids.contains(&m.uid));
                Ok(())
            })
        };
        Box::pin(std::future::ready(result))
    }

    fn logout(self: Box<Self>) -> BoxFuture<'static, ()> {
        lock(&self.server.state)
            .log
            .push(format!("{}: LOGOUT", self.username));
        Box::pin(std::future::ready(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(name: &str, attributes: &[&str]) -> MailboxInfo {
        MailboxInfo::new(
            name,
            Some("/"),
            attributes.iter().map(|a| (*a).to_owned()).collect(),
        )
    }

    #[test]
    fn special_use_prefers_the_attribute_then_names() {
        let labelled = [
            info("INBOX", &[]),
            info("Spam", &[]),
            info("Bulk", &["\\Junk"]),
        ];
        assert_eq!(
            pick_special_use(&labelled, SpecialUse::Junk).as_deref(),
            Some("Bulk")
        );
        let named = [
            info("INBOX", &[]),
            info("[Gmail]/Spam", &[]),
            info("Junk E-mail", &[]),
        ];
        assert_eq!(
            pick_special_use(&named, SpecialUse::Junk).as_deref(),
            Some("[Gmail]/Spam")
        );
        let nested = [info("INBOX", &[]), info("INBOX/Junk", &[])];
        assert_eq!(
            pick_special_use(&nested, SpecialUse::Junk).as_deref(),
            Some("INBOX/Junk")
        );
        let unselectable = [info("Junk", &["\\Noselect"]), info("Trash", &[])];
        assert_eq!(pick_special_use(&unselectable, SpecialUse::Junk), None);
        assert_eq!(
            pick_special_use(&unselectable, SpecialUse::Trash).as_deref(),
            Some("Trash")
        );
    }

    #[test]
    fn message_ids_are_bracketed() {
        assert_eq!(bracketed_message_id(" a@b ").expect("id"), "<a@b>");
        assert_eq!(bracketed_message_id("<a@b>").expect("id"), "<a@b>");
        assert!(bracketed_message_id("<>").is_err());
        assert!(bracketed_message_id("a\r\nb").is_err());
    }

    #[tokio::test]
    async fn the_memory_server_moves_flags_and_deletes() {
        let server = MemoryImap::new();
        server.add_account("u", "p");
        server.add_folder("u", "Junk", Some(SpecialUse::Junk));
        server.deliver("u", "Junk", "m1@x").expect("delivered");
        let bad = ImapConfig::new("imap.x", 993, "u", "wrong");
        assert!(
            server
                .connect(&bad)
                .await
                .err()
                .expect("refused")
                .auth_failed()
        );

        let mut session = server
            .connect(&ImapConfig::new("imap.x", 993, "u", "p"))
            .await
            .expect("session");
        let junk = session
            .find_special_use(SpecialUse::Junk)
            .await
            .expect("listed")
            .expect("junk");
        session.select(&junk).await.expect("selected");
        let uids = session.search_by_message_id("m1@x").await.expect("found");
        session.move_messages(&uids, "INBOX").await.expect("moved");
        session.select("INBOX").await.expect("inbox");
        let moved = session.search_by_message_id("<m1@x>").await.expect("found");
        session
            .add_flags(&moved, &["\\Seen"])
            .await
            .expect("flagged");
        assert!(server.messages("u", "INBOX")[0].flags.contains("\\Seen"));
        session.delete_messages(&moved).await.expect("deleted");
        session.logout().await;
        assert_eq!(server.messages("u", "INBOX"), Vec::new());
        assert_eq!(server.logins("u"), 1);
    }
}
