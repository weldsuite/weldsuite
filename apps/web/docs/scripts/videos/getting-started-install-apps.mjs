/**
 * Support video: "How to install an app" (App Store).
 * Embedded in src/app/getting-started/install-apps/page.md.
 */
import { mockApi } from '../mock-api.mjs'

const TARGET = { code: 'welddesk', name: 'WeldDesk' }

function app(code, name, category, description, overview, installed) {
  return {
    code,
    name,
    description,
    overview,
    icon: code,
    category,
    provider: 'WeldSuite',
    verified: true,
    isInstalled: installed,
    features: [],
    version: '1.0.0',
    releasedAt: '2025-03-01T00:00:00.000Z',
    websiteUrl: null,
    documentationUrl: null,
    contactUrl: null,
  }
}

const catalog = [
  app('weldcrm', 'WeldCRM', 'Sales & CRM', 'Contacts, companies, leads and deals in one pipeline.', null, true),
  app('welddesk', 'WeldDesk', 'Customer support', 'Answer customer questions from one shared inbox with tickets, live chat and SLAs.', 'WeldDesk brings every customer conversation into one shared inbox. Turn emails and chat messages into tickets, assign them to your team, set response targets and keep customers up to date, without switching tools.', false),
  app('weldcommerce', 'WeldCommerce', 'E-commerce', 'Sell online with products, orders and a website builder.', null, false),
  app('weldmail', 'WeldMail', 'Email', 'A shared business inbox with labels, templates and scheduling.', null, true),
  app('weldchat', 'WeldChat', 'Team chat', 'Channels, direct messages and calls for your team.', null, true),
  app('weldmeet', 'WeldMeet', 'Video meetings', 'Host video meetings with recording and transcripts.', null, false),
  app('weldflow', 'WeldFlow', 'Project management', 'Plan projects, track tasks and hit deadlines together.', null, true),
  app('weldcalendar', 'WeldCalendar', 'Calendar', 'Shared calendars, booking pages and reminders.', null, true),
  app('weldknow', 'WeldKnow', 'Knowledge base', 'Write and share internal docs and wikis.', null, false),
  app('welddrive', 'WeldDrive', 'File storage', 'Store, share and organise files for the whole workspace.', null, true),
  app('weldhost', 'WeldHost', 'Domains & hosting', 'Register domains and manage DNS records.', null, false),
  app('weldbooks', 'WeldBooks', 'Accounting', 'Invoices, bills and bookkeeping for your business.', null, false),
]

const installedCodes = () => catalog.filter((a) => a.isInstalled).map((a) => a.code)

function mockRoutes(page, env) {
  // Fresh state per recording.
  for (const a of catalog) a.isInstalled = !['welddesk', 'weldcommerce', 'weldmeet', 'weldknow', 'weldhost', 'weldbooks'].includes(a.code)

  return mockApi(page, new URL(env.platformBase).origin, [
    ['GET /api/appstore/can-manage-apps', () => ({ data: { canManage: true } })],
    ['GET /api/app-catalog', () => ({ data: catalog })],
    ['GET /api/app-catalog/categories', () => ({ data: ['Customers', 'Communication', 'Work', 'Storage', 'Finance'] })],
    ['GET /api/dashboard/installed-apps', () => ({ data: installedCodes() })],
    ['GET /api/user-apps/store', () => ({ data: [] })],
    ['GET /api/user-apps/installed', () => ({ data: [] })],
    [
      /^POST \/api\/app-catalog\/[^/]+\/install$/,
      ({ url }) => {
        const code = url.pathname.split('/')[3]
        const target = catalog.find((a) => a.code === code)
        if (target) target.isInstalled = true
        return { data: { appCode: code, installed: true } }
      },
    ],
  ])
}

async function run(d, page) {
  await d.pause(700)

  await d.caption('Click the + App Store button in the left rail')
  await d.click(page.getByTestId('app-nav-appstore'))
  await d.pause(600)

  await d.caption(`Click the app you want, here ${TARGET.name}`)
  await d.click(page.getByRole('link', { name: new RegExp(TARGET.name) }))
  await page.getByRole('heading', { name: TARGET.name, level: 1 }).waitFor({ state: 'visible' })
  await d.pause(1500)

  await d.caption('Read the description, then click Install')
  await d.pause(700)
  await d.click(page.getByRole('button', { name: 'Install', exact: true }))
  await page.getByRole('button', { name: 'Uninstall', exact: true }).waitFor({ state: 'visible' })
  await d.pause(900)

  await d.caption(`${TARGET.name} now appears in the left rail`)
  const railIcon = page.getByTestId(`app-nav-${TARGET.code}`)
  await d.moveTo(railIcon, { durationMs: 900 })
  await d.pause(2200)

  await d.caption('Back in the App Store, the app is marked Installed', { numbered: false })
  await d.click(page.getByRole('button', { name: 'Back' }))
  await page.getByText('Installed', { exact: true }).first().waitFor({ state: 'visible' })
  await d.pause(2600)
  await d.hideCaption()
}

export default {
  name: 'getting-started-install-apps',
  url: (env) => `${env.platformBase}/preview/appstore`,
  readySelector: 'text=WeldCommerce',
  intro: { eyebrow: 'Getting started', title: 'How to install an app', subtitle: 'Add apps to your workspace from the App Store' },
  outro: { eyebrow: 'Getting started', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
