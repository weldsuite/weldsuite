/**
 * Support video: "How to add a task and mark it complete" (WeldFlow, My Tasks).
 * Embedded in src/app/weldflow/my-tasks/page.md.
 */
import { mockApi } from '../mock-api.mjs'

const ME = { id: 'usr_alex', name: 'Alex Morgan', email: 'alex@acme.example' }
const NEW_TASK = 'Prepare kickoff agenda'
const DONE_TASK = 'Update project plan'

const PROJECTS = [
  { id: 'prj_onboarding', name: 'Customer Onboarding', color: 'bg-green-500', icon: 'Layers' },
  { id: 'prj_website', name: 'Website Relaunch', color: 'bg-blue-500', icon: 'Target' },
  { id: 'prj_marketing', name: 'Q4 Marketing Campaign', color: 'bg-orange-500', icon: 'Zap' },
]

const project = (p) => ({
  ...p,
  workspaceId: 'ws_preview',
  description: null,
  status: 'active',
  priority: 'medium',
  health: null,
  derivedStatus: 'active',
  progress: 0,
  derivedProgress: 0,
  startDate: null,
  endDate: null,
  createdAt: '2026-01-10T09:00:00.000Z',
  updatedAt: '2026-01-10T09:00:00.000Z',
  canWrite: true,
  isAdmin: true,
  clientName: null,
})

const daysFromNow = (d) => new Date(Date.now() + d * 86_400_000).toISOString()
const pagination = (n) => ({ totalCount: n, hasMore: false, cursor: null })

let counter = 0
function task({ title, status = 'todo', priority = 'medium', projectId, due = null, number }) {
  const proj = PROJECTS.find((p) => p.id === projectId)
  return {
    id: `tsk_${++counter}`,
    workspaceId: 'ws_preview',
    createdAt: '2026-01-12T09:00:00.000Z',
    updatedAt: '2026-01-12T09:00:00.000Z',
    projectId,
    title,
    number,
    status,
    priority,
    progress: 0,
    labels: [],
    tags: [],
    assigneeId: ME.id,
    assigneeIds: [ME.id],
    dueDate: due === null ? undefined : daysFromNow(due),
    position: counter,
    isBillable: false,
    project: { id: proj.id, name: proj.name },
    assignee: ME,
    assignees: [ME],
  }
}

function mockRoutes(page, env) {
  counter = 0
  const tasks = [
    task({ title: 'Review homepage copy', status: 'in_progress', priority: 'high', projectId: 'prj_website', due: 1, number: 118 }),
    task({ title: 'Send campaign brief to design', priority: 'medium', projectId: 'prj_marketing', due: 3, number: 121 }),
    task({ title: DONE_TASK, priority: 'low', projectId: 'prj_onboarding', due: 5, number: 124 }),
    task({ title: 'Book venue for launch event', status: 'done', priority: 'medium', projectId: 'prj_marketing', due: -2, number: 109 }),
  ]

  return mockApi(page, new URL(env.platformBase).origin, [
    ['GET /api/projects', () => ({ data: PROJECTS.map(project), pagination: pagination(PROJECTS.length) })],
    ['GET /api/my-tasks', () => ({ data: tasks, pagination: pagination(tasks.length) })],
    [
      'POST /api/tasks',
      ({ json }) => {
        const created = task({
          title: json?.title ?? NEW_TASK,
          status: json?.status ?? 'todo',
          priority: json?.priority ?? 'medium',
          projectId: json?.projectId ?? PROJECTS[0].id,
          number: 130,
        })
        created.createdAt = new Date().toISOString()
        tasks.unshift(created)
        return { data: created }
      },
    ],
    [
      /^PATCH \/api\/tasks\/[^/]+\/toggle$/,
      ({ url }) => {
        const found = tasks.find((t) => url.pathname.includes(t.id))
        if (found) found.status = found.status === 'done' ? 'todo' : 'done'
        return { data: { id: found?.id, status: found?.status } }
      },
    ],
    ['GET /api/project-labels', () => ({ data: [], pagination: pagination(0) })],
    [
      'GET /api/project-members',
      () => ({
        data: [
          { id: 'mem_1', projectId: PROJECTS[0].id, userId: ME.id, role: 'admin', isActive: true, joinedAt: '2026-01-10T09:00:00.000Z', user: ME },
        ],
        pagination: pagination(1),
      }),
    ],
    [/.*/, ({ url }) => { if (process.env.VIDEO_DEBUG) console.log('UNMOCKED', url.pathname + url.search); return { status: 404, body: { error: {} } } }],
  ])
}

async function run(d, page) {
  // Park the cursor in the content area so it does not sweep over the app rail tooltips.
  await page.mouse.move(760, 420)
  await d.pause(700)

  await d.caption('Open WeldFlow: My Tasks lists everything assigned to you', { holdMs: 2200 })

  await d.caption('Click New Task')
  await d.click(page.getByRole('button', { name: 'New Task' }).first())
  const titleField = page.getByPlaceholder('Task name...')
  await titleField.waitFor({ state: 'visible' })
  await d.pause(600)

  await d.caption('Enter a title for the task')
  await d.type(titleField, NEW_TASK)

  await d.caption('Set a priority')
  await d.click(page.getByRole('button', { name: 'Priority', exact: true }))
  await d.click(page.getByRole('button', { name: 'High', exact: true }))

  await d.caption('Click Create task')
  await d.click(page.getByRole('button', { name: 'Create task' }))
  await page.getByText('Task created').first().waitFor({ state: 'visible' })
  await d.pause(1600)

  await d.caption('Your new task appears in the list', { numbered: false, holdMs: 1800 })

  await d.caption('When the work is finished, tick the checkbox')
  const row = page.locator('div.cursor-pointer', { hasText: DONE_TASK })
  await d.click(row.getByRole('checkbox'))
  await d.pause(1800)

  await d.caption('Done! Completed tasks are crossed out and move to Done', { numbered: false })
  await d.pause(2600)
  await d.hideCaption()
}

export default {
  name: 'weldflow-my-tasks',
  url: (env) => `${env.platformBase}/preview/weldflow`,
  readySelector: 'text=Review homepage copy',
  intro: { eyebrow: 'WeldFlow', title: 'How to manage your tasks', subtitle: 'Add a task in My Tasks and mark work as done' },
  outro: { eyebrow: 'WeldFlow', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
