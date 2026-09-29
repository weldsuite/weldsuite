/**
 * Support video: "How to handle a support conversation" (WeldDesk).
 * Embedded in src/app/welddesk/handle-tickets/page.md.
 */
import { mockApi } from '../mock-api.mjs'

const ME = { id: 'user_alex', name: 'Alex Morgan' }
const TARGET_ID = 'dsk_conv_1'

const REPLY = [
  'Hi Sarah, I am sorry the mug arrived damaged.',
  'I have just sent a replacement, you will get a tracking link by email today. No need to return the broken one.',
]
const NOTE = 'Replacement mug shipped from stock. Refund not needed.'

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString()

const members = [
  { id: 'mem_alex', userId: ME.id, name: ME.name, email: 'alex@acme.example', picture: null, role: 'OWNER', status: 'active' },
  { id: 'mem_noor', userId: 'user_noor', name: 'Noor Haddad', email: 'noor@acme.example', picture: null, role: 'ADMIN', status: 'active' },
  { id: 'mem_tom', userId: 'user_tom', name: 'Tom Jansen', email: 'tom@acme.example', picture: null, role: 'MEMBER', status: 'active' },
]

function conversation(n, { name, email, title, preview, minutes, channel = 'email', assigneeId = null, waiting = false }) {
  return {
    id: `dsk_conv_${n}`,
    createdAt: minutesAgo(minutes + 5),
    updatedAt: minutesAgo(minutes),
    conversationNumber: 1040 + n,
    title,
    state: 'open',
    channel,
    visitorId: null,
    name,
    email,
    contactId: null,
    assigneeId,
    waitingSince: waiting ? minutesAgo(minutes) : null,
    lastMessageAt: minutesAgo(minutes),
    lastMessagePreview: preview,
  }
}

function message(id, conversationId, { kind = 'message', body, authorType, authorId = null, minutes, metadata = null }) {
  return {
    id,
    createdAt: minutesAgo(minutes),
    conversationId,
    kind,
    body,
    authorType,
    authorId,
    attachments: null,
    metadata,
  }
}

const conversations = [
  conversation(1, {
    name: 'Sarah Whitfield',
    email: 'sarah.whitfield@example.com',
    title: 'Damaged mug #4821',
    preview: 'The mug from my last order arrived cracked. Can you help?',
    minutes: 9,
    waiting: true,
  }),
  conversation(2, {
    name: 'Marco Bellini',
    email: 'marco.bellini@example.org',
    title: 'Question about invoice 2026-0317',
    preview: 'Could you resend the invoice with our VAT number on it?',
    minutes: 34,
    waiting: true,
  }),
  conversation(3, {
    name: 'Yuki Tanaka',
    email: 'yuki.tanaka@example.net',
    title: 'Can I change my delivery address?',
    preview: 'I moved last week and forgot to update my address.',
    minutes: 71,
    assigneeId: 'user_noor',
  }),
  conversation(4, {
    name: 'Elena Petrova',
    email: 'elena.petrova@example.com',
    title: 'Discount code not working',
    preview: 'The code SPRING10 says it has expired, but the email said it runs until Friday.',
    minutes: 140,
    assigneeId: 'user_tom',
  }),
  conversation(5, {
    name: 'Omar Farouk',
    email: 'omar.farouk@example.org',
    title: 'Bulk order pricing',
    preview: 'We are planning to order 200 units in June. Is there a volume discount?',
    minutes: 60 * 26,
    assigneeId: 'user_noor',
  }),
]

const threads = {
  [TARGET_ID]: [
    message('dsk_msg_1', TARGET_ID, {
      body: 'Hello, the mug from my last order (#4821) arrived cracked. I took a photo of the box, it looks like it was dropped. Can you help?',
      authorType: 'visitor',
      minutes: 9,
    }),
  ],
}

function mockRoutes(page, env) {
  const state = new Map(conversations.map((c) => [c.id, { ...c }]))
  const messages = new Map(Object.entries(threads))
  let seq = 100

  const detail = (id) => ({ ...state.get(id), messages: messages.get(id) ?? [] })
  const event = (id, eventType, extra = {}) =>
    message(`dsk_msg_${++seq}`, id, {
      kind: 'event',
      body: null,
      authorType: 'system',
      authorId: ME.id,
      minutes: 0,
      metadata: { eventType, ...extra },
    })
  const push = (id, m) => messages.set(id, [...(messages.get(id) ?? []), m])

  return mockApi(page, new URL(env.platformBase).origin, [
    ['GET /api/team-members', () => ({ data: members })],
    [
      'GET /api/desk/conversations',
      ({ url }) => {
        const wanted = url.searchParams.get('state') ?? 'open'
        let rows = [...state.values()].filter((c) => c.state === wanted)
        if (url.searchParams.get('unassigned') === 'true') rows = rows.filter((c) => !c.assigneeId)
        const assignee = url.searchParams.get('assigneeId')
        if (assignee) rows = rows.filter((c) => c.assigneeId === assignee)
        rows.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt))
        return { data: rows, pagination: { totalCount: rows.length, hasMore: false, cursor: null } }
      },
    ],
    [/^GET \/api\/desk\/conversations\/[^/]+$/, ({ url }) => ({ data: detail(url.pathname.split('/').pop()) })],
    [
      /^POST \/api\/desk\/conversations\/[^/]+\/reply$/,
      ({ url, json }) => {
        const id = url.pathname.split('/').at(-2)
        const sent = message(`dsk_msg_${++seq}`, id, {
          kind: json.kind,
          body: json.body,
          authorType: 'agent',
          authorId: ME.id,
          minutes: 0,
        })
        push(id, sent)
        if (json.kind === 'message') {
          Object.assign(state.get(id), { waitingSince: null, lastMessageAt: sent.createdAt, lastMessagePreview: json.body })
        }
        return { data: { conversation: state.get(id), message: sent } }
      },
    ],
    [
      /^POST \/api\/desk\/conversations\/[^/]+\/manage$/,
      ({ url, json }) => {
        const id = url.pathname.split('/').at(-2)
        const conv = state.get(id)
        let ev
        if (json.action === 'assign') {
          conv.assigneeId = json.assigneeId ?? null
          ev = event(id, json.assigneeId ? 'assigned' : 'unassigned', { assigneeId: json.assigneeId ?? null })
        } else {
          conv.state = json.action === 'close' ? 'closed' : 'open'
          ev = event(id, json.action === 'close' ? 'closed' : 'reopened')
        }
        push(id, ev)
        return { data: { conversation: conv, message: ev } }
      },
    ],
  ])
}

async function run(d, page) {
  await d.pause(700)

  await d.caption('Open WeldDesk and pick a conversation from the inbox')
  await d.click(page.getByText('Damaged mug #4821').first())
  await page.getByTestId('desk-inbox-composer-textarea').waitFor({ state: 'visible' })
  await page.getByTestId('desk-inbox-timeline').getByText('arrived cracked. I took a photo').waitFor({ state: 'visible' })
  await d.pause(1800)

  await d.caption('Assign it to yourself so your team knows who owns it')
  await d.click(page.getByRole('button', { name: 'Assign', exact: true }).last())
  await d.click(page.getByRole('option', { name: /Alex Morgan/ }))
  await d.pause(1400)

  await d.caption('Type your reply to the customer and send it')
  await d.type(page.getByTestId('desk-inbox-composer-textarea'), REPLY.join(' '), { delay: 32 })
  await d.pause(700)
  await d.click(page.getByTestId('desk-inbox-composer-send'))
  await page.getByTestId('desk-inbox-timeline').getByText('No need to return the broken one.').waitFor({ state: 'visible' })
  await d.pause(1500)

  await d.caption('Switch to Note to leave an internal comment for your team')
  await d.click(page.getByRole('button', { name: 'Note', exact: true }))
  await d.type(page.getByTestId('desk-inbox-composer-textarea'), NOTE, { delay: 36 })
  await d.click(page.getByTestId('desk-inbox-composer-send'))
  await page.getByTestId('desk-inbox-timeline').getByText(NOTE).waitFor({ state: 'visible' })
  await d.pause(1600)

  await d.caption('When the issue is solved, close the conversation')
  await d.click(page.getByTitle('Close', { exact: true }))
  await d.pause(2600)
  await d.hideCaption()
}

export default {
  name: 'welddesk-handle-tickets',
  url: (env) => `${env.platformBase}/preview/welddesk/inbox`,
  readySelector: 'text=Damaged mug #4821',
  intro: { eyebrow: 'WeldDesk', title: 'How to handle a support conversation', subtitle: 'Pick it up, reply to the customer and close it' },
  outro: { eyebrow: 'WeldDesk', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
