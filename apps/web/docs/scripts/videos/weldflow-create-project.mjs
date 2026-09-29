/**
 * Support video: "How to create a project" (WeldFlow).
 * Embedded in src/app/weldflow/create-project/page.md.
 */
import { mockApi } from '../mock-api.mjs'

const NEW_PROJECT = { id: 'prj_onboarding', name: 'Customer Onboarding', color: 'bg-green-500' }

const project = (id, name, color, extra = {}) => ({
  id,
  workspaceId: 'ws_preview',
  name,
  description: null,
  status: 'active',
  priority: 'medium',
  health: null,
  derivedStatus: 'active',
  progress: 0,
  derivedProgress: 0,
  color,
  icon: 'Layers',
  startDate: null,
  endDate: null,
  createdAt: '2026-01-10T09:00:00.000Z',
  updatedAt: '2026-01-10T09:00:00.000Z',
  canWrite: true,
  isAdmin: true,
  clientName: null,
  ...extra,
})

const pagination = (n) => ({ totalCount: n, hasMore: false, cursor: null })

function mockRoutes(page, env) {
  const projects = [
    project('prj_website', 'Website Relaunch', 'bg-blue-500', { icon: 'Target' }),
    project('prj_marketing', 'Q4 Marketing Campaign', 'bg-orange-500', { icon: 'Zap' }),
  ]

  return mockApi(page, new URL(env.platformBase).origin, [
    ['GET /api/projects', () => ({ data: projects, pagination: pagination(projects.length) })],
    [
      'POST /api/projects',
      ({ json }) => {
        const created = project(NEW_PROJECT.id, json?.name ?? NEW_PROJECT.name, json?.color ?? NEW_PROJECT.color, {
          icon: json?.icon ?? 'Building',
          status: json?.status ?? 'planning',
          createdAt: new Date().toISOString(),
        })
        projects.push(created)
        return { data: created }
      },
    ],
    [/^GET \/api\/projects\/[^/]+$/, ({ url }) => ({ data: projects.find((p) => url.pathname.endsWith(p.id)) ?? projects[0] })],
    [/^GET \/api\/projects\/[^/]+\/permissions$/, () => ({ data: { role: 'admin', canRead: true, canWrite: true, isAdmin: true } })],
    ['GET /api/my-tasks', () => ({ data: [], pagination: pagination(0) })],
    ['GET /api/tasks', () => ({ data: [], pagination: pagination(0) })],
    ['GET /api/project-labels', () => ({ data: [], pagination: pagination(0) })],
    ['GET /api/project-members', () => ({ data: [], pagination: pagination(0) })],
    [/.*/, ({ url }) => { if (process.env.VIDEO_DEBUG) console.log('UNMOCKED', url.pathname + url.search); return { status: 404, body: { error: {} } } }],
  ])
}

async function run(d, page) {
  // Park the cursor in the content area so it does not sweep over the app rail tooltips.
  await page.mouse.move(760, 420)
  await d.pause(700)

  await d.caption('Open WeldFlow and find Projects in the sidebar')
  await d.moveTo(page.locator('[data-sidebar="group-label"]', { hasText: /^Projects$/ }))
  await d.pause(500)

  await d.caption('Click + next to Projects')
  await d.click(page.getByRole('button', { name: 'Add Projects' }))
  const nameInput = page.getByPlaceholder('e.g., Website Redesign')
  await nameInput.waitFor({ state: 'visible' })
  await d.pause(700)

  await d.caption('Enter a name for the project')
  await d.type(nameInput, NEW_PROJECT.name)

  await d.caption('Pick a color to recognise it in the sidebar')
  await d.click(page.getByTitle('Change color'))
  await d.click(page.getByTitle('Green'))

  await d.caption('Click Create Project')
  await d.click(page.getByRole('button', { name: 'Create Project' }))
  await page.getByText('Project created').first().waitFor({ state: 'visible' })
  await d.pause(1400)

  await d.caption('Click the new project in the sidebar to open it')
  await d.click(page.getByRole('link', { name: NEW_PROJECT.name }).first())
  await page.getByRole('heading', { name: NEW_PROJECT.name }).waitFor({ state: 'visible' })
  await d.pause(2200)

  await d.caption('Your project is ready: add tasks, members and files from its tabs', { numbered: false })
  await d.pause(2600)
  await d.hideCaption()
}

export default {
  name: 'weldflow-create-project',
  url: (env) => `${env.platformBase}/preview/weldflow`,
  readySelector: 'text=Website Relaunch',
  intro: { eyebrow: 'WeldFlow', title: 'How to create a project', subtitle: 'Set up a shared space for tasks, files and your team' },
  outro: { eyebrow: 'WeldFlow', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
