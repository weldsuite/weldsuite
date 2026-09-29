/**
 * Support video: "How to create a booking page" (WeldCalendar).
 * Embedded in src/app/weldcalendar/booking-pages/page.md.
 */
import { mockApi } from '../mock-api.mjs'

const PAGE = {
  title: 'Intro call',
  slug: 'intro-call',
  duration: 30,
  fridayEnd: '13:00',
  bufferAfter: '10',
  description: 'A short call to get to know each other and see how we can help.',
}

const calendars = [
  { id: 'cal_alex', name: 'Alex Morgan', color: '#3b82f6', ownerId: 'user_alex', isDefault: true, isActive: true, isOwn: true, permission: 'manage' },
]

const page1 = (data) => ({ data, pagination: { totalCount: data.length, hasMore: false, cursor: null } })

/** Monday of the week containing the 1st (the month grid's first cell) plus `dayOffset`, at "HH:MM". */
function dateAt(dayOffset, time) {
  const [h, m] = time.split(':').map(Number)
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + dayOffset)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

function event(id, title, dayOffset, start, end) {
  return {
    id, calendarId: 'cal_alex', type: 'meeting', title, allDay: false, status: 'confirmed', priority: 'normal',
    startTime: dateAt(dayOffset, start), endTime: dateAt(dayOffset, end),
    createdAt: '2026-01-15T12:00:00.000Z', updatedAt: '2026-01-15T12:00:00.000Z',
  }
}

const calendarEvents = [
  event('evt_1', 'Team standup', 0, '09:30', '10:00'),
  event('evt_2', 'Design review', 1, '14:00', '15:00'),
  event('evt_3', 'Client call: Northfield', 2, '11:00', '12:00'),
  event('evt_4', 'Team standup', 7, '09:30', '10:00'),
  event('evt_5', 'Sprint planning', 8, '13:00', '14:30'),
  event('evt_6', 'Team standup', 14, '09:30', '10:00'),
  event('evt_7', '1:1 with Priya', 16, '11:00', '11:30'),
  event('evt_8', 'Team standup', 21, '09:30', '10:00'),
]

async function mockRoutes(page, env) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(env.platformBase).origin }).catch(() => {})

  // The booking link field shows "<portal origin>/<workspace slug>/". Without a
  // signed-in workspace that is the dev server origin, so show what a real
  // workspace sees instead.
  await page.addInitScript(() => {
    const relabel = () => {
      for (const el of document.querySelectorAll('span.select-none')) {
        if (/^[\w.:-]+\/\/$/.test(el.textContent ?? '')) el.textContent = 'book.example.com/acme/'
      }
    }
    new MutationObserver(relabel).observe(document, { childList: true, subtree: true })
  })

  const bookingPages = []

  return mockApi(page, new URL(env.platformBase).origin, [
    ['GET /api/calendars', () => ({ data: calendars })],
    ['GET /api/booking-pages', () => page1(bookingPages)],
    [
      /^GET \/api\/booking-pages\/[^/]+$/,
      ({ url }) => {
        const id = url.pathname.split('/').pop()
        const found = bookingPages.find((p) => p.id === id)
        return found ? { data: found } : { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } }
      },
    ],
    [
      'POST /api/booking-pages',
      ({ json }) => {
        const id = `bp_${bookingPages.length + 1}`
        bookingPages.push({
          isActive: true,
          ...json,
          id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        return { data: { id } }
      },
    ],
    ['GET /api/calendar-events/range', () => ({ data: calendarEvents })],
    ['GET /api/calendar-events/upcoming', () => ({ data: [] })],
    ['GET /api/integrations/connections', () => page1([])],
  ])
}

const FAST = { durationMs: 450 }

/** Scroll the week grid so the working day (8 AM) is at the top. */
async function showWorkingHours(page) {
  await page.evaluate(() => {
    const scrollers = [...document.querySelectorAll('div')].filter((el) => {
      const overflow = getComputedStyle(el).overflowY
      return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 200 && (el.textContent ?? '').includes('9 AM')
    })
    const grid = scrollers.at(-1)
    if (grid) grid.scrollTop = 8 * (grid.scrollHeight / 24)
  })
  await page.waitForTimeout(400)
}

async function run(d, page) {
  await d.pause(700)

  await d.caption('In the sidebar, click Add booking page', { holdMs: 600 })
  await d.click(page.getByRole('button', { name: 'Add booking page', exact: true }), FAST)
  const title = page.getByPlaceholder('Add title')
  await title.waitFor({ state: 'visible' })
  await showWorkingHours(page)
  await d.pause(600)

  await d.caption('Give the page a title', { holdMs: 600 })
  await title.fill('')
  await d.type(title, PAGE.title, { delay: 45 })

  await d.caption('Choose how long each appointment lasts', { holdMs: 600 })
  await d.click(page.getByRole('combobox').filter({ hasText: '2 hours' }), FAST)
  await d.click(page.getByRole('option', { name: '30 minutes' }), FAST)
  await d.pause(600)

  await d.caption('Define your availability: which days and hours can be booked', { holdMs: 600 })
  const fridayEnd = page.locator("xpath=//span[normalize-space()='Fri']/parent::div//input[@type='time']").nth(1)
  await d.moveTo(fridayEnd, FAST)
  await fridayEnd.fill(PAGE.fridayEnd)
  await d.pause(1200)

  await d.caption('Add buffer time between meetings', { holdMs: 600 })
  await d.click(page.getByText('Booked appointment settings'), FAST)
  const bufferAfter = page.locator("xpath=//label[normalize-space()='Buffer after']/following::input[1]")
  await d.click(bufferAfter, FAST)
  await bufferAfter.fill(PAGE.bufferAfter)
  await d.pause(1300)

  await d.caption('Click Continue', { holdMs: 600 })
  await d.click(page.getByRole('button', { name: 'Continue', exact: true }), FAST)
  const slug = page.getByPlaceholder('my-booking-page')
  await slug.waitFor({ state: 'visible' })
  await d.pause(900)

  await d.caption('Check the booking link people will use', { holdMs: 600 })
  await d.moveTo(slug, FAST)
  await d.pause(1400)

  await d.caption('Add a description for your guests', { holdMs: 600 })
  await d.click(page.getByPlaceholder('Add description'), FAST)
  await page.keyboard.type(PAGE.description, { delay: 20 })
  await d.pause(800)

  await d.caption('Click Create', { holdMs: 600 })
  await d.click(page.getByRole('button', { name: 'Create', exact: true }), FAST)
  await page.getByText('Booking page saved').first().waitFor({ state: 'visible' })
  await showWorkingHours(page)
  await d.pause(1400)

  await d.caption('Copy the public link from the sidebar and share it', { holdMs: 600 })
  const row = page.locator('[data-sidebar="menu-item"]', { hasText: PAGE.title })
  await d.moveTo(row.locator('[data-sidebar="menu-button"]'), FAST)
  await d.click(row.locator('button').nth(1), FAST)
  await page.getByText('Booking link copied').first().waitFor({ state: 'visible' })
  await d.pause(2200)

  await d.caption('Done! Share the link so guests can book a time', { numbered: false })
  await d.pause(2200)
  await d.hideCaption()
}

export default {
  name: 'weldcalendar-booking-pages',
  url: (env) => `${env.platformBase}/preview/weldcalendar`,
  readySelector: 'text=Add booking page',
  intro: { eyebrow: 'WeldCalendar', title: 'How to create a booking page', subtitle: 'Let people book time with you from a public link' },
  outro: { eyebrow: 'WeldCalendar', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
