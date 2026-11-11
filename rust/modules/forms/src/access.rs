//! Who may see and change a form (`services/access.ts`).
//!
//! The workspace permissions (`forms:*`, `form_responses:*`) say what a
//! member may do at all; a restricted form then narrows that to its owner,
//! its access list and `forms:manage`. A restricted form a member cannot see
//! is a 404, never a 403.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::permission_keys::{
    FORM_RESPONSES_DELETE, FORM_RESPONSES_EXPORT, FORM_RESPONSES_READ, FORMS_DELETE, FORMS_MANAGE,
    FORMS_PUBLISH, FORMS_READ, FORMS_SEND, FORMS_UPDATE,
};
use weldsuite_permissions::Permissions;

use crate::common::{FormsResult, not_found, one, text};

/// `MemberGrants`: what the member's workspace permissions allow.
#[allow(
    clippy::struct_excessive_bools,
    reason = "one flag per permission, as `MemberGrants`"
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct Grants {
    pub(crate) read: bool,
    pub(crate) update: bool,
    pub(crate) delete: bool,
    pub(crate) publish: bool,
    pub(crate) send: bool,
    pub(crate) manage: bool,
    pub(crate) responses_read: bool,
    pub(crate) responses_export: bool,
    pub(crate) responses_delete: bool,
}

/// `resolveGrants(c)`.
pub(crate) fn resolve_grants(permissions: &Permissions) -> Grants {
    let has = |key: &str| permissions.has_any(&[key]);
    Grants {
        read: has(FORMS_READ),
        update: has(FORMS_UPDATE),
        delete: has(FORMS_DELETE),
        publish: has(FORMS_PUBLISH),
        send: has(FORMS_SEND),
        manage: has(FORMS_MANAGE),
        responses_read: has(FORM_RESPONSES_READ),
        responses_export: has(FORM_RESPONSES_EXPORT),
        responses_delete: has(FORM_RESPONSES_DELETE),
    }
}

/// `FormRelation`: `workspace`, `owner`, `manage`, `editor` or `results`.
pub(crate) type Relation = &'static str;

/// `relationTo(form, userId, grants, entry)`.
pub(crate) fn relation_to(
    form: &Value,
    user_id: &str,
    grants: &Grants,
    entry: Option<Relation>,
) -> Option<Relation> {
    if text(form, "ownerUserId") == user_id {
        return Some("owner");
    }
    if grants.manage {
        return Some("manage");
    }
    if text(form, "access") == "workspace" {
        return Some("workspace");
    }
    entry
}

fn can_change(relation: Relation) -> bool {
    matches!(relation, "workspace" | "owner" | "manage" | "editor")
}

fn can_see_answers(relation: Relation) -> bool {
    can_change(relation) || relation == "results"
}

/// `FormDetail['permissions']`.
#[allow(
    clippy::struct_excessive_bools,
    reason = "one flag per action, as the DTO"
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FormPermissions {
    pub(crate) edit: bool,
    pub(crate) publish: bool,
    pub(crate) delete: bool,
    pub(crate) send: bool,
    pub(crate) read_responses: bool,
    pub(crate) export_responses: bool,
    pub(crate) delete_responses: bool,
    pub(crate) manage_access: bool,
}

impl FormPermissions {
    pub(crate) fn to_json(self) -> Value {
        json!({
            "edit": self.edit,
            "publish": self.publish,
            "delete": self.delete,
            "send": self.send,
            "readResponses": self.read_responses,
            "exportResponses": self.export_responses,
            "deleteResponses": self.delete_responses,
            "manageAccess": self.manage_access,
        })
    }
}

/// What a route needs the member to be allowed on the form (`keyof permissions`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Need {
    Edit,
    Publish,
    Delete,
    Send,
    ReadResponses,
    ExportResponses,
    DeleteResponses,
    ManageAccess,
}

impl FormPermissions {
    pub(crate) fn allows(self, need: Need) -> bool {
        match need {
            Need::Edit => self.edit,
            Need::Publish => self.publish,
            Need::Delete => self.delete,
            Need::Send => self.send,
            Need::ReadResponses => self.read_responses,
            Need::ExportResponses => self.export_responses,
            Need::DeleteResponses => self.delete_responses,
            Need::ManageAccess => self.manage_access,
        }
    }
}

/// `formPermissions(relation, grants)`.
pub(crate) fn form_permissions(relation: Relation, grants: &Grants) -> FormPermissions {
    let full = matches!(relation, "workspace" | "owner" | "manage");
    FormPermissions {
        edit: grants.update && can_change(relation),
        publish: grants.publish && can_change(relation),
        delete: grants.delete && full,
        send: grants.send && can_change(relation),
        read_responses: grants.responses_read && can_see_answers(relation),
        export_responses: grants.responses_export && can_see_answers(relation),
        delete_responses: grants.responses_delete && can_change(relation),
        manage_access: matches!(relation, "owner" | "manage"),
    }
}

/// `AccessibleForm`.
#[derive(Debug, Clone)]
pub(crate) struct AccessibleForm {
    pub(crate) form: Value,
    pub(crate) relation: Relation,
    pub(crate) permissions: FormPermissions,
}

fn role_of(role: &str) -> Option<Relation> {
    match role {
        "editor" => Some("editor"),
        "results" => Some("results"),
        _ => None,
    }
}

/// A form row by id, as Drizzle returns it.
pub(crate) async fn form_row(db: &PgPool, id: &str) -> FormsResult<Option<Value>> {
    one(
        db,
        sqlx::query_scalar("select to_jsonb(f) from forms f where id = $1 limit 1").bind(id),
    )
    .await
}

/// `loadAccessibleForm(db, formId, userId, grants)`: 404 when it does not
/// exist or is restricted and the member is not on it.
pub(crate) async fn load_accessible_form(
    db: &PgPool,
    form_id: &str,
    user_id: &str,
    grants: &Grants,
) -> FormsResult<AccessibleForm> {
    let Some(form) = form_row(db, form_id).await? else {
        return Err(not_found("Form"));
    };
    let entry = if text(&form, "access") == "restricted"
        && text(&form, "ownerUserId") != user_id
        && !grants.manage
    {
        let role: Option<String> = sqlx::query_scalar(
            "select role from form_access where form_id = $1 and user_id = $2 limit 1",
        )
        .bind(text(&form, "id"))
        .bind(user_id)
        .fetch_optional(db)
        .await?;
        role.as_deref().and_then(role_of)
    } else {
        None
    };
    let Some(relation) = relation_to(&form, user_id, grants, entry) else {
        return Err(not_found("Form"));
    };
    Ok(AccessibleForm {
        permissions: form_permissions(relation, grants),
        form,
        relation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricted_relations_narrow_the_grants() {
        let grants = Grants {
            read: true,
            update: true,
            responses_read: true,
            ..Grants::default()
        };
        let results = form_permissions("results", &grants);
        assert!(!results.edit && results.read_responses && !results.manage_access);
        let editor = form_permissions("editor", &grants);
        assert!(editor.edit && !editor.delete);
        let form = json!({ "ownerUserId": "u_owner", "access": "restricted" });
        assert_eq!(relation_to(&form, "u_other", &grants, None), None);
        assert_eq!(relation_to(&form, "u_owner", &grants, None), Some("owner"));
    }
}
