/**
 * Support video: "How to find and save leads" (WeldData).
 * Embedded in src/app/welddata/find-leads/page.md.
 */
import { mockApi } from '../mock-api.mjs'

const now = '2026-09-01T09:00:00.000Z'

const FILTERS = { title: 'Head of Sales', seniority: 'Department Leadership' }
const TARGET_LIST = { id: 'wdl_q4', name: 'Q4 outreach' }

const lists = [
  { id: TARGET_LIST.id, createdAt: now, updatedAt: now, kind: 'person', name: TARGET_LIST.name, description: null, color: 'bg-blue-500', icon: 'Database', leadCount: 0 },
  { id: 'wdl_events', createdAt: now, updatedAt: now, kind: 'person', name: 'Event contacts', description: null, color: 'bg-emerald-500', icon: 'Database', leadCount: 12 },
  { id: 'wdl_partners', createdAt: now, updatedAt: now, kind: 'company', name: 'Partner companies', description: null, color: 'bg-violet-500', icon: 'Database', leadCount: 8 },
]

function person(n, name, title, companyName, domain, industry, location, country, companySize) {
  return {
    id: `lem_${n}`,
    kind: 'person',
    name,
    email: null,
    title,
    companyName,
    domain,
    industry,
    location,
    country,
    companySize,
    linkedinUrl: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\W+/g, '-')}`,
    avatarUrl: null,
    raw: {},
  }
}

const results = [
  person(1, 'Marta Lindqvist', 'Head of Sales', 'Brightwave Software', 'brightwave.example', 'Technology, Information and Internet', 'Stockholm', 'Sweden', '51-200'),
  person(2, 'Tobias Reinhardt', 'Head of Sales', 'Northgate Logistics', 'northgate.example', 'Freight and Package Transportation', 'Hamburg', 'Germany', '51-200'),
  person(3, 'Chloe Fontaine', 'Head of Sales, EMEA', 'Lumen Analytics', 'lumen-analytics.example', 'IT Services and IT Consulting', 'Lyon', 'France', '51-200'),
  person(4, 'Ravi Menon', 'Head of Sales', 'Copperleaf Foods', 'copperleaf.example', 'Food and Beverage Manufacturing', 'Manchester', 'United Kingdom', '51-200'),
  person(5, 'Sofia Alvarez', 'Head of Sales', 'Harborview Insurance', 'harborview.example', 'Insurance', 'Madrid', 'Spain', '51-200'),
  person(6, 'Jonas Vermeulen', 'Head of Sales Operations', 'Pixelforge Studios', 'pixelforge.example', 'Design Services', 'Antwerp', 'Belgium', '51-200'),
  person(7, 'Hannah Whitfield', 'Head of Sales', 'Evergreen Energy', 'evergreen-energy.example', 'Electric Power Generation', 'Dublin', 'Ireland', '51-200'),
  person(8, 'Luca Bianchi', 'Head of Sales', 'Solstice Travel', 'solstice-travel.example', 'Travel Arrangements', 'Milan', 'Italy', '51-200'),
]

/** Initials avatar as an inline SVG, so saved leads never load an external favicon. */
function initialsAvatar(name) {
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#e5e7eb"/><text x="32" y="40" font-family="sans-serif" font-size="24" font-weight="600" text-anchor="middle" fill="#374151">${initials}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

function mockRoutes(page, env) {
  // Leads saved during the recording, per list.
  const saved = new Map()
  const listWithCount = (l) => ({ ...l, leadCount: l.leadCount + (saved.get(l.id)?.length ?? 0) })

  return mockApi(page, new URL(env.platformBase).origin, [
    ['GET /api/welddata/lists', () => ({ data: lists.map(listWithCount), pagination: { totalCount: lists.length, hasMore: false, cursor: null } })],
    [/^GET \/api\/welddata\/lists\/[^/]+$/, ({ url }) => ({ data: listWithCount(lists.find((l) => url.pathname.endsWith(l.id)) ?? lists[0]) })],
    [
      /^GET \/api\/welddata\/lists\/[^/]+\/leads$/,
      ({ url }) => {
        const id = url.pathname.split('/')[4]
        const data = saved.get(id) ?? []
        return { data, pagination: { totalCount: data.length, hasMore: false, cursor: null } }
      },
    ],
    [/^GET \/api\/welddata\/lists\/[^/]+\/columns$/, () => ({ data: [] })],
    [/^GET \/api\/welddata\/lists\/[^/]+\/cells$/, () => ({ data: [] })],
    [
      'POST /api/welddata/search/people',
      () => ({ data: { rows: results, page: 1, size: 100, total: 1248, hasMore: false } }),
    ],
    [
      /^POST \/api\/welddata\/lists\/[^/]+\/leads$/,
      ({ url, json }) => {
        const id = url.pathname.split('/')[4]
        const leads = (json?.leads ?? []).map((l, i) => ({
          id: `wdlead_${id}_${(saved.get(id)?.length ?? 0) + i}`,
          createdAt: now,
          updatedAt: now,
          listId: id,
          ...l,
          data: { ...l.data, lead_picture_url: initialsAvatar(l.name ?? '') },
          convertedStatus: 'pending',
        }))
        saved.set(id, [...(saved.get(id) ?? []), ...leads])
        return { data: { added: leads.length, skipped: 0 } }
      },
    ],
  ])
}

async function run(d, page) {
  await d.pause(700)

  await d.caption('Open WeldData and choose People')
  await d.click(page.getByRole('tab', { name: 'People' }))

  await d.caption('Set your filters: job title')
  await d.type(page.getByLabel('Current job title'), FILTERS.title, { delay: 70 })

  await d.caption('Narrow it down: pick a seniority level')
  await d.click(page.getByLabel('Seniority', { exact: true }))
  await d.click(page.getByRole('option', { name: FILTERS.seniority }))

  await d.caption('Click Search')
  await d.click(page.getByRole('button', { name: 'Search', exact: true }))
  await page.getByText(results[0].name).first().waitFor({ state: 'visible' })
  await d.pause(1600)

  await d.caption('Tick the leads you want to keep')
  const boxes = page.locator('main').getByRole('checkbox')
  for (const i of [1, 2, 3]) await d.click(boxes.nth(i), { durationMs: 450 })
  await d.pause(500)

  await d.caption('Click Add to list')
  await d.click(page.getByText('Add to list', { exact: true }))

  await d.caption('Pick a list')
  await d.click(page.getByRole('option', { name: TARGET_LIST.name }).or(page.getByText(TARGET_LIST.name, { exact: true }).last()))
  await page.getByText(/Saved 3 leads/).first().waitFor({ state: 'visible' })
  await d.pause(1600)

  await d.caption('Done! Open the list in the sidebar to see your saved leads', { numbered: false })
  await d.click(page.getByRole('link', { name: TARGET_LIST.name }))
  await page.getByText(results[0].name).first().waitFor({ state: 'visible' })
  await d.pause(2600)
  await d.hideCaption()
}

export default {
  name: 'welddata-find-leads',
  url: (env) => `${env.platformBase}/preview/welddata`,
  readySelector: 'text=Current job title',
  intro: { eyebrow: 'WeldData', title: 'How to find and save leads', subtitle: 'Search the lead database and save prospects to a list' },
  outro: { eyebrow: 'WeldData', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
