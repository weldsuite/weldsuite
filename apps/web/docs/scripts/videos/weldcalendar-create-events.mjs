/**
 * Support video: "How to create an event" (WeldCalendar).
 * Embedded in src/app/weldcalendar/create-events/page.md.
 */
import { mockApi } from '../mock-api.mjs'

const MY_CALENDAR = 'cal_alex'
const TEAM_CALENDAR = 'cal_team'

const EVENT = {
  title: 'Project kickoff',
  start: '10:00',
  end: '11:00',
  guestSearch: 'Jam',
  guest: 'Jamie Rivera',
  location: 'Meeting room 2',
  description: 'Walk through scope and first milestones.',
}

const calendars = [
  { id: MY_CALENDAR, name: 'Alex Morgan', color: '#3b82f6', ownerId: 'user_alex', isDefault: true, isActive: true, isOwn: true, permission: 'manage' },
  { id: TEAM_CALENDAR, name: 'Team calendar', color: '#10b981', ownerId: 'user_alex', isDefault: false, isActive: true, isOwn: true, permission: 'manage' },
]

const people = [
  { id: 'per_jamie', firstName: 'Jamie', lastName: 'Rivera', fullName: 'Jamie Rivera', email: 'jamie.rivera@example.com' },
]

const members = [
  { id: 'mem_priya', userId: 'user_priya', name: 'Priya Shah', email: 'priya@acme.example', role: 'member', picture: null },
  { id: 'mem_daniel', userId: 'user_daniel', name: 'Daniel Okafor', email: 'daniel@acme.example', role: 'member', picture: null },
]

/**
 * The month grid starts on the Monday of the week containing the 1st. Events are
 * laid out relative to that Monday so the month looks populated whatever day
 * the video is recorded on.
 */
function gridStart() {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

/** `dayOffset` days after the grid's first Monday, at "HH:MM" local time. */
function dateAt(dayOffset, time = '00:00') {
  const [h, m] = time.split(':').map(Number)
  const d = gridStart()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(h, m, 0, 0)
  return d
}

const dayKey = (d) =>
  [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')

function event(id, calendarId, title, dayOffset, start, end, extra = {}) {
  return {
    id,
    calendarId,
    type: 'meeting',
    title,
    startTime: dateAt(dayOffset, start).toISOString(),
    endTime: dateAt(dayOffset, end).toISOString(),
    allDay: false,
    status: 'confirmed',
    priority: 'normal',
    createdAt: '2026-01-15T12:00:00.000Z',
    updatedAt: '2026-01-15T12:00:00.000Z',
    ...extra,
  }
}

// The new event goes on the Thursday of the first row: near the top of the
// screen, so the quick-create card has room to grow.
const NEW_EVENT_DAY = 3

const events = [
  event('evt_01', TEAM_CALENDAR, 'Team standup', 0, '09:30', '10:00'),
  event('evt_02', MY_CALENDAR, 'Design review', 1, '14:00', '15:00'),
  event('evt_03', MY_CALENDAR, 'Client call: Northfield', 2, '11:00', '12:00'),
  event('evt_04', TEAM_CALENDAR, 'Team lunch', 4, '12:00', '13:00'),
  event('evt_05', TEAM_CALENDAR, 'Team standup', 7, '09:30', '10:00'),
  event('evt_06', MY_CALENDAR, 'Sprint planning', 8, '13:00', '14:30'),
  event('evt_07', MY_CALENDAR, 'Demo prep', 10, '15:00', '16:00'),
  event('evt_08', TEAM_CALENDAR, 'Quarterly review', 11, '10:00', '12:00'),
  event('evt_09', TEAM_CALENDAR, 'Team standup', 14, '09:30', '10:00'),
  event('evt_10', MY_CALENDAR, '1:1 with Priya', 16, '11:00', '11:30'),
  event('evt_11', MY_CALENDAR, 'Product workshop', 17, '14:00', '16:00'),
  event('evt_12', TEAM_CALENDAR, 'Team standup', 21, '09:30', '10:00'),
  event('evt_13', MY_CALENDAR, 'Vendor call', 23, '10:30', '11:00'),
  event('evt_14', TEAM_CALENDAR, 'Team standup', 28, '09:30', '10:00'),
]

const page1 = (data) => ({ data, pagination: { totalCount: data.length, hasMore: false, cursor: null } })

async function mockRoutes(page, env) {
  // Location autocomplete calls Mapbox; keep the video offline and deterministic.
  await page.route('https://api.mapbox.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ suggestions: [] }) }),
  )

  const created = []
  const workingDay = { isOpen: true, openTime: '09:00', closeTime: '17:00' }

  return mockApi(page, new URL(env.platformBase).origin, [
    ['GET /api/calendars', () => ({ data: calendars })],
    ['GET /api/booking-pages', () => page1([])],
    ['GET /api/calendar-events/range', () => ({ data: [...events, ...created] })],
    ['GET /api/calendar-events/upcoming', () => ({ data: [] })],
    [
      'GET /api/working-hours',
      () => ({
        data: {
          workingHours: {
            monday: workingDay, tuesday: workingDay, wednesday: workingDay, thursday: workingDay, friday: workingDay,
            saturday: { isOpen: false }, sunday: { isOpen: false },
          },
        },
      }),
    ],
    ['GET /api/integrations/connections', () => page1([])],
    [
      'GET /api/people',
      ({ url }) => {
        const q = (url.searchParams.get('search') ?? '').toLowerCase()
        return page1(people.filter((p) => `${p.fullName} ${p.email}`.toLowerCase().includes(q)))
      },
    ],
    ['GET /api/team-members', () => page1(members)],
    [
      'POST /api/calendar-events',
      ({ json }) => {
        const id = `evt_new_${created.length + 1}`
        created.push({
          ...json,
          id,
          type: json?.type ?? 'event',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        return { data: { id } }
      },
    ],
  ])
}

/**
 * Click an empty spot of the quick-create card so the open field commits.
 * (Its inline fields collapse on a short blur timer, which would otherwise
 * swallow the next row's click.)
 */
async function clickAway(d, page) {
  const tabs = page.getByRole('tablist').first()
  const card = await tabs.locator('xpath=ancestor::div[contains(@class,"fixed")][1]').boundingBox()
  const x = card.x + card.width - 30
  const y = card.y + 8
  await page.mouse.move(x, y, { steps: 20 })
  await page.mouse.click(x, y)
  await d.pause(450)
}

const FAST = { durationMs: 450 }

async function run(d, page) {
  const day = dateAt(NEW_EVENT_DAY)
  await d.pause(700)

  await d.caption('Open WeldCalendar and click a day on the calendar', { holdMs: 600 })
  await d.click(page.locator(`[data-date="${dayKey(day)}"]`), FAST)
  const title = page.getByPlaceholder('Add a title')
  await title.waitFor({ state: 'visible' })
  await d.pause(500)

  await d.caption('Enter a title', { holdMs: 600 })
  await d.type(title, EVENT.title, { ...FAST, delay: 35 })

  await d.caption('Set the start and end time', { holdMs: 600 })
  await d.click(page.getByText(/^\w+day, \w+ \d+/).first(), FAST)
  const times = page.locator('input[type="time"]')
  await times.first().waitFor({ state: 'visible' })
  await times.first().fill(EVENT.start)
  await d.pause(500)
  await times.nth(1).fill(EVENT.end)
  await d.pause(600)

  await d.caption('Choose which calendar to save the event in', { holdMs: 600 })
  await d.click(page.getByText('Alex Morgan', { exact: true }).last(), FAST)
  await d.click(page.locator('button', { hasText: 'Team calendar' }), FAST)
  await d.pause(600)

  await d.caption('Add a location and a description', { holdMs: 600 })
  await d.click(page.getByText('Add location'), FAST)
  await d.type(page.getByPlaceholder('Add location'), EVENT.location, { ...FAST, delay: 35 })
  await clickAway(d, page)
  await d.click(page.getByText(/^Add a description/), FAST)
  await page.keyboard.type(EVENT.description, { delay: 22 })
  await d.pause(500)
  await clickAway(d, page)

  await d.caption('Invite guests: search workspace members and contacts', { holdMs: 600 })
  await d.click(page.getByText('Add participants'), FAST)
  await d.type(page.getByPlaceholder(/Search team members/i), EVENT.guestSearch, { ...FAST, delay: 120 })
  const guest = page.getByText(EVENT.guest, { exact: true })
  await guest.waitFor({ state: 'visible' })
  await d.pause(500)
  await d.click(guest, FAST)
  await d.pause(700)

  await d.caption('Click Save', { holdMs: 600 })
  await d.click(page.getByRole('button', { name: 'Save', exact: true }), FAST)
  await page.getByText(EVENT.title, { exact: true }).first().waitFor({ state: 'visible' })
  await d.pause(900)

  await d.caption('Done! The event now appears on your calendar', { numbered: false })
  await d.moveTo(page.getByText(EVENT.title, { exact: true }).first())
  await d.pause(2000)
  await d.hideCaption()
}

export default {
  name: 'weldcalendar-create-events',
  url: (env) => `${env.platformBase}/preview/weldcalendar`,
  readySelector: 'text=Team standup',
  intro: { eyebrow: 'WeldCalendar', title: 'How to create an event', subtitle: 'Schedule a meeting and invite guests' },
  outro: { eyebrow: 'WeldCalendar', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
