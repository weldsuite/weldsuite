/**
 * Support video: "How to invite a teammate" (Settings > Team).
 * Embedded in src/app/settings/team-and-permissions/page.md.
 */
import { mockApi } from '../mock-api.mjs'

const INVITE = { email: 'sam.taylor@example.com', name: 'Sam Taylor' }

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString()

function member(id, name, email, role, { roleId = null, days = 90, status = 'ACTIVE' } = {}) {
  return {
    id: `mem_${id}`,
    userId: `user_${id}`,
    name,
    picture: null,
    email,
    role,
    roleId,
    status,
    memberType: 'INTERNAL',
    permissions: [],
    invitedBy: null,
    invitedAt: daysAgo(days),
    acceptedAt: status === 'ACTIVE' ? daysAgo(days) : null,
    createdAt: daysAgo(days),
  }
}

const roles = [
  { id: 'role_owner', name: 'OWNER', description: 'Full access including billing', isSystemRole: true, canDelete: false, canModify: false, memberCount: 1, createdAt: daysAgo(200) },
  { id: 'role_admin', name: 'ADMIN', description: 'Team management and most settings', isSystemRole: true, canDelete: false, canModify: false, memberCount: 1, createdAt: daysAgo(200) },
  { id: 'role_member', name: 'MEMBER', description: 'Apps granted by permissions', isSystemRole: true, canDelete: false, canModify: false, memberCount: 2, createdAt: daysAgo(200) },
  { id: 'role_viewer', name: 'VIEWER', description: 'Read-only access', isSystemRole: true, canDelete: false, canModify: false, memberCount: 1, createdAt: daysAgo(200) },
  { id: 'role_sales', name: 'Sales team', description: 'WeldCRM and WeldMail access', isSystemRole: false, canDelete: true, canModify: true, memberCount: 1, createdAt: daysAgo(60) },
]

const active = [
  member('alex', 'Alex Morgan', 'alex@acme.example', 'OWNER', { roleId: 'role_owner', days: 200 }),
  member('priya', 'Priya Shah', 'priya@acme.example', 'ADMIN', { roleId: 'role_admin', days: 150 }),
  member('daniel', 'Daniel Okafor', 'daniel@acme.example', 'MEMBER', { roleId: 'role_member', days: 90 }),
  member('mia', 'Mia Chen', 'mia.chen@acme.example', 'MEMBER', { roleId: 'role_sales', days: 45 }),
]

function mockRoutes(page, env) {
  const pending = []
  const list = (data) => ({ data, pagination: { totalCount: data.length, hasMore: false, cursor: null } })

  return mockApi(page, new URL(env.platformBase).origin, [
    [
      'GET /api/team-members',
      ({ url }) => (url.searchParams.get('status') === 'PENDING' ? list(pending) : list(active)),
    ],
    ['POST /api/team-members/sync', () => ({ data: { synced: true } })],
    ['GET /api/roles', () => ({ data: roles })],
    ['GET /api/member-limits', () => ({ data: { limit: null, current: active.length, atLimit: false, planName: 'Business' } })],
    ['GET /api/prepaid-seats', () => ({ data: { prepaidSeats: 10, usedSeats: active.length, availableSeats: 10 - active.length, canAddMore: true } })],
    ['GET /api/dashboard/installed-apps', () => ({ data: ['weldcrm', 'weldmail', 'weldflow', 'weldchat', 'weldcalendar', 'welddrive'] })],
    ['GET /api/user-apps/installed', () => ({ data: [] })],
    [
      'POST /api/team-members/invite',
      ({ json }) => {
        const role = roles.find((r) => r.id === json?.roleId) ?? roles[2]
        pending.unshift(
          member('sam', json?.name ?? INVITE.name, json?.email ?? INVITE.email, role.name, {
            roleId: role.id,
            days: 0,
            status: 'PENDING',
          }),
        )
        return { data: { memberId: 'mem_sam', memberType: 'INTERNAL', activated: false } }
      },
    ],
  ])
}

async function run(d, page) {
  await d.pause(700)

  await d.caption('Open Settings and choose Team Members')
  await d.click(page.getByRole('link', { name: 'Team Members' }))
  await d.pause(500)

  await d.caption('Click Invite Member')
  await d.click(page.getByRole('button', { name: 'Invite Member', exact: true }))
  await page.getByPlaceholder('Email').waitFor({ state: 'visible' })
  await d.pause(700)

  await d.caption('Enter their email address and name')
  await d.type(page.getByPlaceholder('Email'), INVITE.email, { delay: 55 })
  await d.type(page.getByPlaceholder('Name'), INVITE.name, { delay: 70 })

  await d.caption('Choose a role')
  await d.click(page.getByRole('dialog').getByRole('combobox'))
  await page.getByRole('option', { name: 'Member' }).waitFor({ state: 'visible' })
  await d.pause(900)
  await d.click(page.getByRole('option', { name: 'Member' }))

  await d.caption('Click Send Invite')
  await d.click(page.getByRole('button', { name: /^Send 1 Invite/ }))
  await page.getByText('1 invitation sent').waitFor({ state: 'visible' })
  await d.pause(700)

  await page.getByText(INVITE.email).first().waitFor({ state: 'visible' })
  await d.caption('Pending invites stay listed until they are accepted', { numbered: false })
  await d.pause(3200)
  await d.hideCaption()
}

export default {
  name: 'settings-team-and-permissions',
  url: (env) => `${env.platformBase}/preview/settings/team`,
  readySelector: 'text=Priya Shah',
  intro: { eyebrow: 'Settings', title: 'How to invite a teammate', subtitle: 'Add people to your workspace and choose their role' },
  outro: { eyebrow: 'Settings', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
