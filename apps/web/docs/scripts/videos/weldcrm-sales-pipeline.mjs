/**
 * Support video: "How to move a deal through your pipeline" (WeldCRM).
 * Embedded in src/app/weldcrm/sales-pipeline/page.md.
 */
import { mockApi } from '../mock-api.mjs'

const PIPELINE_ID = 'pip_sales'
const NOW = '2026-01-15T12:00:00.000Z'
const list = (data) => ({ data, pagination: { totalCount: data.length, hasMore: false, cursor: null } })

const pipeline = {
  id: PIPELINE_ID,
  name: 'Sales',
  description: 'Main sales pipeline',
  color: 'bg-blue-500',
  icon: 'TrendingUp',
  template: 'sales',
  isDefault: true,
  isArchived: false,
  createdAt: NOW,
  updatedAt: NOW,
}

const stage = (id, name, position, probability, color, extra = {}) => ({
  id: `stg_${id}`,
  name,
  color,
  probability,
  pipeline: PIPELINE_ID,
  position,
  isDefault: position === 0,
  isWon: false,
  isLost: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
})

const stages = [
  stage('lead', 'Lead', 0, 10, '#94a3b8'),
  stage('qualified', 'Qualified', 1, 30, '#3b82f6'),
  stage('proposal', 'Proposal', 2, 50, '#8b5cf6'),
  stage('negotiation', 'Negotiation', 3, 75, '#f59e0b'),
  stage('won', 'Won', 4, 100, '#10b981', { isWon: true }),
  stage('lost', 'Lost', 5, 0, '#ef4444', { isLost: true }),
]

const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString()

function deal(id, { name, company, amount, stageKey, probability, closeInDays }) {
  return {
    id: `opp_${id}`,
    name,
    customerId: `cmp_${id}`,
    customerName: company,
    amount: String(amount),
    value: amount,
    currency: 'USD',
    stage: `stg_${stageKey}`,
    stageId: `stg_${stageKey}`,
    status: 'open',
    probability,
    closeDate: inDays(closeInDays),
    ownerId: 'usr_preview',
    pipeline: PIPELINE_ID,
    tags: [],
    createdAt: NOW,
    updatedAt: NOW,
  }
}

const MOVING_DEAL = 'Website redesign'

const seedDeals = () => [
  deal('1', { name: MOVING_DEAL, company: 'Northfield Studio', amount: 12000, stageKey: 'lead', probability: 10, closeInDays: 45 }),
  deal('2', { name: 'Annual support plan', company: 'Bergman & Co', amount: 8400, stageKey: 'lead', probability: 10, closeInDays: 38 }),
  deal('3', { name: 'CRM rollout', company: 'Harbor Logistics', amount: 24500, stageKey: 'qualified', probability: 30, closeInDays: 30 }),
  deal('4', { name: 'Office fit-out contract', company: 'Chen Interiors', amount: 18750, stageKey: 'proposal', probability: 50, closeInDays: 21 }),
  deal('5', { name: 'Training workshop', company: 'Marino Foods', amount: 6200, stageKey: 'proposal', probability: 50, closeInDays: 18 }),
  deal('6', { name: 'Equipment lease', company: 'Okafor Media', amount: 31000, stageKey: 'negotiation', probability: 75, closeInDays: 9 }),
  deal('7', { name: 'Brand refresh', company: 'Rivera Design', amount: 9800, stageKey: 'won', probability: 100, closeInDays: -3 }),
]

const people = ['Priya Shah', 'Daniel Okafor', 'Mia Chen'].map((displayName, i) => {
  const [firstName, lastName] = displayName.split(' ')
  return {
    id: `per_${i + 1}`, version: 1, createdAt: NOW, updatedAt: NOW, firstName, lastName, fullName: displayName, displayName,
    title: ['Procurement Manager', 'Marketing Lead', 'Event Coordinator'][i],
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`, directPhone: `+1 555 01${20 + i}`,
    status: 'active', isSupplier: false, isLead: false, isFavorite: false, inCrm: true, tags: [], customFields: {},
  }
})

function mockRoutes(page, env) {
  const deals = seedDeals()

  return mockApi(page, new URL(env.platformBase).origin, [
    ['GET /api/pipelines', () => list([pipeline])],
    [`GET /api/pipelines/${PIPELINE_ID}`, () => ({ data: pipeline })],
    ['GET /api/pipeline-stages', () => list(stages)],
    ['GET /api/opportunities', () => list(deals)],
    [
      /^PATCH \/api\/opportunities\/[^/]+$/,
      ({ url, json }) => {
        const found = deals.find((d) => d.id === url.pathname.split('/').pop())
        if (found && json?.stageId) {
          found.stageId = json.stageId
          found.stage = json.stageId
          found.probability = stages.find((s) => s.id === json.stageId)?.probability ?? found.probability
        }
        return { data: found }
      },
    ],
    ['GET /api/companies', () => list([])],
    ['GET /api/people', () => list(people)],
    ['GET /api/lists', () => list([])],
  ])
}

async function run(d, page) {
  await d.pause(700)
  await d.caption('Open WeldCRM and choose your pipeline in the sidebar')
  await d.click(page.getByRole('link', { name: 'Sales', exact: true }).first())
  await page.getByText(MOVING_DEAL).first().waitFor({ state: 'visible' })
  await d.pause(1500)

  await d.caption('Each stage is a column, each deal is a card')
  await d.moveTo(page.getByText('Lead', { exact: true }).first(), { durationMs: 900 })
  await d.pause(700)
  await d.moveTo(page.getByText('Qualified', { exact: true }).first(), { durationMs: 900 })
  await d.pause(700)

  await d.caption('Drag the deal card to the next stage column')
  const card = page.getByText(MOVING_DEAL, { exact: true }).first()
  const from = await card.boundingBox()
  const target = await page.getByText('CRM rollout', { exact: true }).first().boundingBox()
  await d.moveTo(card, { durationMs: 900 })
  await page.mouse.down()
  await d.pause(250)
  // Small first move so the drag sensor activates, then glide to the column.
  await page.mouse.move(from.x + 70, from.y + 20, { steps: 6 })
  await page.mouse.move(target.x + 60, target.y + 40, { steps: 45 })
  await d.pause(700)
  await page.mouse.up()
  await d.pause(1200)


  await d.caption('Done! The deal is now in Qualified and its win probability updated', { numbered: false })
  await d.pause(3000)
  await d.hideCaption()
}

export default {
  name: 'weldcrm-sales-pipeline',
  url: (env) => `${env.platformBase}/preview/weldcrm/people`,
  readySelector: 'body:has([href*="pip_sales"]):has-text("Priya Shah")',
  intro: { eyebrow: 'WeldCRM', title: 'How to move a deal through your pipeline', subtitle: 'Open a pipeline and drag a deal to the next stage' },
  outro: { eyebrow: 'WeldCRM', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
