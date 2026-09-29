/**
 * Support video: "How to add a contact" (WeldCRM).
 * Embedded in src/app/weldcrm/manage-contacts/page.md.
 */
import { mockApi } from '../mock-api.mjs'

const NEW_PERSON = {
  firstName: 'Taylor',
  lastName: 'Brooks',
  email: 'taylor.brooks@example.com',
  title: 'Head of Operations',
  directPhone: '+1 555 0142',
}

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString()

let seq = 0
function person(id, { first, last, email, title, phone, status = 'active', days = 30 }) {
  const displayName = `${first} ${last}`
  return {
    id: `per_${id}`,
    version: 1,
    createdAt: daysAgo(days),
    updatedAt: daysAgo(days),
    deletedAt: null,
    archivedAt: null,
    firstName: first,
    lastName: last,
    fullName: displayName,
    displayName,
    title,
    department: null,
    role: null,
    email,
    directPhone: phone,
    mobilePhone: null,
    avatarUrl: null,
    ownerId: null,
    status,
    lifecycleStage: null,
    rating: null,
    source: null,
    isSupplier: false,
    isLead: false,
    isFavorite: false,
    inCrm: true,
    tags: [],
    customFields: {},
    notes: null,
    partyCode: `P-${1000 + ++seq}`,
  }
}

const seedPeople = () => [
  person('1', { first: 'Priya', last: 'Shah', email: 'priya.shah@northfield.example', title: 'Procurement Manager', phone: '+1 555 0118', days: 40 }),
  person('2', { first: 'Daniel', last: 'Okafor', email: 'daniel.okafor@example.org', title: 'Marketing Lead', phone: '+1 555 0127', days: 33 }),
  person('3', { first: 'Mia', last: 'Chen', email: 'mia.chen@example.net', title: 'Event Coordinator', phone: '+1 555 0163', status: 'prospect', days: 21 }),
  person('4', { first: 'Lucas', last: 'Berg', email: 'lucas.berg@example.com', title: 'Office Manager', phone: '+1 555 0179', days: 14 }),
  person('5', { first: 'Sofia', last: 'Marino', email: 'sofia.marino@example.com', title: 'Finance Director', phone: '+1 555 0184', days: 9 }),
]

function mockRoutes(page, env) {
  const people = seedPeople()
  const list = () => ({ data: people, pagination: { totalCount: people.length, hasMore: false, cursor: null } })

  return mockApi(page, new URL(env.platformBase).origin, [
    ['GET /api/people', list],
    [
      'POST /api/people',
      ({ json }) => {
        const created = person(String(people.length + 1), {
          first: json.firstName ?? '',
          last: json.lastName ?? '',
          email: json.email ?? null,
          title: json.title ?? null,
          phone: json.directPhone ?? null,
          days: 0,
        })
        people.unshift(created)
        return { data: created }
      },
    ],
    [/^GET \/api\/people\/[^/]+$/, ({ url }) => ({ data: people.find((p) => p.id === url.pathname.split('/').pop()) ?? people[0] })],
    [/^GET \/api\/people\/[^/]+\/companies$/, () => ({ data: [] })],
    ['GET /api/pipelines', () => ({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } })],
    ['GET /api/lists', () => ({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } })],
  ])
}

async function run(d, page) {
  await d.pause(700)
  await d.caption('Open WeldCRM and choose People')
  await d.click(page.getByRole('link', { name: 'People', exact: true }).first())
  await d.pause(1200)

  await d.caption('Click New person')
  await d.click(page.getByTestId('entity-grid-create-btn'))
  await d.pause(900)

  const dialog = page.getByRole('dialog')
  await d.caption('Enter the name, email, job title and phone number')
  await d.type(dialog.getByLabel('First Name'), NEW_PERSON.firstName)
  await d.type(dialog.getByLabel('Last Name'), NEW_PERSON.lastName)
  await d.type(dialog.getByLabel('Email'), NEW_PERSON.email, { delay: 30 })
  await d.type(dialog.getByLabel('Job Title'), NEW_PERSON.title, { delay: 30 })
  await d.type(dialog.getByLabel('Direct Phone'), NEW_PERSON.directPhone)

  await d.caption('Click Create person')
  await d.click(dialog.getByRole('button', { name: 'Create person' }))
  await page.getByText('Person created').waitFor({ state: 'visible' })
  await d.pause(1200)

  await d.caption('Click the new row to open the record in a side panel')
  await d.click(page.getByText('Taylor Brooks').first())
  await page.getByText('taylor.brooks@example.com').last().waitFor({ state: 'visible' })
  await d.pause(1400)

  await d.caption('Done! Your list stays in view while you work on the record', { numbered: false })
  await d.pause(2600)
  await d.hideCaption()
}

export default {
  name: 'weldcrm-manage-contacts',
  url: (env) => `${env.platformBase}/preview/weldcrm/people`,
  readySelector: 'text=Priya Shah',
  intro: { eyebrow: 'WeldCRM', title: 'How to add a contact', subtitle: 'Create a person and open their record' },
  outro: { eyebrow: 'WeldCRM', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
