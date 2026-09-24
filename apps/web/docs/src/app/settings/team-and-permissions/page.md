---
title: Team and permissions
nextjs:
  metadata:
    title: Team and permissions
    description: Invite teammates and control app access in WeldSuite settings.
---

Invite people to your workspace and control which apps and actions they can use. {% .lead %}

---

## Invite a teammate

1. Open **Settings** → **Team** (or **Members**).
2. Click **Invite member**.
3. Enter **email address** and choose a **role** (Owner, Admin, Member, or custom).
4. Send the invite.

They receive an email with a link to join the workspace. Pending invites appear in the list until accepted.

---

## Roles

| Role | Typical access |
| --- | --- |
| **Owner** | Everything including billing |
| **Admin** | Team management and most settings |
| **Member** | Apps granted by permissions |
| **Custom roles** | App-specific permission sets your admin defined |

Exact names may vary if your workspace uses custom role templates.

---

## App permissions

Permissions are set **per app**. Some objects appear in several apps. Companies, for example, show up in WeldCRM, WeldDesk and WeldMail, so you can let a role see companies in WeldCRM but not in WeldDesk.

1. Go to **Settings** → **Roles** and open a role.
2. Pick an app from the list on the left, or **Workspace** for settings that don't belong to one app.
3. Tick **Members with this role can open** the app, then choose what they can do with each object: view, create, edit, delete or manage.
4. Use **Read only**, **Grant all** or **Copy from…** to fill an app quickly from another app's settings.

### Exceptions for one member

1. Open **Settings** → **Team** and select the member.
2. Open the **Permissions** tab and pick an app.
3. Click a permission to change it for this member only. A permission the role doesn't give becomes **allowed**; one it does give becomes **denied**. Click again to go back to the role's setting.

A denied permission always wins, even if the role allows it.

Changes apply on next sign-in or within a few minutes for active sessions.

---

## Remove access

1. Open **Team**.
2. Select the member.
3. Choose **Remove from workspace** or downgrade their role.

Removing someone does not delete records they created; ownership may transfer per app rules.

---

## Next steps

- [Settings overview](/settings)
- [Install apps](/getting-started/install-apps)
