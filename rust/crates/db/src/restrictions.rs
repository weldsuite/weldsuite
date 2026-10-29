//! What a workspace's billing mode, licence and partner allow
//! (`computeWorkspaceRestrictions` in `worker-kit/src/read-only.ts`).

/// Why a workspace may only be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadOnlyReason {
    /// The partner is suspended (unpaid statement): 403 `WORKSPACE_READ_ONLY`.
    PartnerSuspended,
    /// The licence is not active: 403 `WORKSPACE_READ_ONLY`.
    LicenceInactive,
    /// The tenant database is being moved: 503 `WORKSPACE_MOVING`.
    DatabaseMove,
}

impl ReadOnlyReason {
    /// The wire value: `partner_suspended`, `licence_inactive`, `database_move`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PartnerSuspended => "partner_suspended",
            Self::LicenceInactive => "licence_inactive",
            Self::DatabaseMove => "database_move",
        }
    }
}

/// The outcome of [`compute_workspace_restrictions`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkspaceRestrictions {
    /// App codes the workspace is licensed for; `None` = every app.
    pub licensed_apps: Option<Vec<String>>,
    pub read_only: bool,
    pub read_only_reason: Option<ReadOnlyReason>,
}

/// The master-DB facts the restrictions are computed from.
#[derive(Debug, Clone, Default)]
pub struct RestrictionInput<'a> {
    pub billing_mode: Option<&'a str>,
    /// `workspace_licences.status` and `allowed_apps`, for a partner workspace.
    pub licence: Option<(&'a str, &'a [String])>,
    pub partner_status: Option<&'a str>,
    /// A database move in a write-blocking status.
    pub database_move_in_progress: bool,
}

/// Direct workspaces are unrestricted. A partner workspace may use the apps
/// in its licence (none without a licence row, failing closed) and is
/// read-only while its partner is suspended or its licence is not active. A
/// database move outranks both: the answer is "try again".
pub fn compute_workspace_restrictions(input: &RestrictionInput<'_>) -> WorkspaceRestrictions {
    let mut restrictions = if input.billing_mode == Some("partner") {
        let reason = if input.partner_status == Some("suspended") {
            Some(ReadOnlyReason::PartnerSuspended)
        } else if input.licence.map(|(status, _)| status) != Some("active") {
            Some(ReadOnlyReason::LicenceInactive)
        } else {
            None
        };
        WorkspaceRestrictions {
            licensed_apps: Some(
                input
                    .licence
                    .map(|(_, apps)| apps.to_vec())
                    .unwrap_or_default(),
            ),
            read_only: reason.is_some(),
            read_only_reason: reason,
        }
    } else {
        WorkspaceRestrictions::default()
    };
    if input.database_move_in_progress {
        restrictions.read_only = true;
        restrictions.read_only_reason = Some(ReadOnlyReason::DatabaseMove);
    }
    restrictions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partner_rules() {
        let apps = ["weldcrm".to_owned()];
        assert_eq!(
            compute_workspace_restrictions(&RestrictionInput::default()),
            WorkspaceRestrictions::default()
        );
        let active = compute_workspace_restrictions(&RestrictionInput {
            billing_mode: Some("partner"),
            licence: Some(("active", &apps)),
            ..RestrictionInput::default()
        });
        assert_eq!(active.licensed_apps, Some(apps.to_vec()));
        assert!(!active.read_only);

        let no_licence = compute_workspace_restrictions(&RestrictionInput {
            billing_mode: Some("partner"),
            ..RestrictionInput::default()
        });
        assert_eq!(no_licence.licensed_apps, Some(Vec::new()));
        assert_eq!(
            no_licence.read_only_reason,
            Some(ReadOnlyReason::LicenceInactive)
        );

        let suspended = compute_workspace_restrictions(&RestrictionInput {
            billing_mode: Some("partner"),
            licence: Some(("active", &apps)),
            partner_status: Some("suspended"),
            database_move_in_progress: false,
        });
        assert_eq!(
            suspended.read_only_reason,
            Some(ReadOnlyReason::PartnerSuspended)
        );

        let moving = compute_workspace_restrictions(&RestrictionInput {
            database_move_in_progress: true,
            ..RestrictionInput::default()
        });
        assert_eq!(moving.licensed_apps, None);
        assert_eq!(moving.read_only_reason, Some(ReadOnlyReason::DatabaseMove));
    }
}
