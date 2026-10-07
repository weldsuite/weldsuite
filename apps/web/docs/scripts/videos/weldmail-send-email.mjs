/**
 * Support video: "How to send an email" (WeldMail).
 * Embedded in src/app/weldmail/send-email/page.md.
 */
import { mockApi } from '../mock-api.mjs'

const ACCOUNT_ID = 'acc_preview'
const ME = { name: 'Alex Morgan', email: 'alex@acme.example' }
const RECIPIENT = { id: 'per_jamie', firstName: 'Jamie', lastName: 'Rivera', email: 'jamie.rivera@example.com' }

const EMAIL = {
  subject: 'Project kickoff next week',
  body: [
    'Hi Jamie,',
    '',
    'Thanks for signing off on the proposal! Could we schedule the kickoff for Tuesday at 10:00?',
    '',
    'Best,',
    'Alex',
  ],
}

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString()

function thread(id, { sender, email, subject, preview, minutes, unread = false, labels = ['INBOX'] }) {
  return {
    threadId: `thr_${id}`,
    accountId: ACCOUNT_ID,
    subject,
    participants: [email],
    latestMessageId: `msg_${id}`,
    latestSender: sender,
    latestSenderEmail: email,
    latestSenderAvatarUrl: null,
    latestDate: minutesAgo(minutes),
    preview,
    messageCount: 1,
    unreadCount: unread ? 1 : 0,
    hasAttachments: false,
    isStarred: false,
    labels,
    scheduledFor: null,
    sendStatus: null,
    messages: [],
  }
}

const inbox = [
  thread('1', { sender: 'Priya Shah', email: 'priya@northfield.example', subject: 'Invoice #1042 received', preview: 'Thanks, we received your invoice and scheduled payment for Friday.', minutes: 12, unread: true }),
  thread('2', { sender: 'Daniel Okafor', email: 'daniel@example.org', subject: 'Re: Website copy review', preview: 'I left a few comments on the homepage draft, mostly small wording tweaks.', minutes: 48, unread: true }),
  thread('3', { sender: 'Mia Chen', email: 'mia.chen@example.net', subject: 'Photos from the workshop', preview: 'Here are the photos from Thursday. Feel free to use them on the blog.', minutes: 95 }),
  thread('4', { sender: 'Lucas Berg', email: 'lucas@example.com', subject: 'Quote for the new office chairs', preview: 'As discussed, attached is the quote for 12 chairs including delivery.', minutes: 180 }),
  thread('5', { sender: 'WeldSuite', email: 'hello@weldsuite.example', subject: 'Your weekly workspace summary', preview: '5 tasks completed, 3 new contacts and 2 deals moved forward this week.', minutes: 60 * 26 }),
]

const account = {
  id: ACCOUNT_ID,
  name: ME.name,
  email: ME.email,
  displayName: ME.name,
  provider: 'weldmail',
  authType: null,
  status: 'active',
  isDefault: true,
  isShared: false,
  assignedUserIds: null,
  syncEnabled: true,
  syncFrequency: 5,
  syncStatus: 'idle',
  lastSyncAt: minutesAgo(1),
  sentToday: 3,
  dailySendLimit: 500,
  imapHost: null,
  imapPort: null,
  imapSecure: null,
  smtpHost: null,
  smtpPort: null,
  smtpSecure: null,
  signature: null,
  aiSettings: null,
  providerConfig: null,
  createdAt: '2026-01-15T12:00:00.000Z',
  updatedAt: '2026-01-15T12:00:00.000Z',
  deletedAt: null,
}

function mockRoutes(page, env) {
  const sent = [
    thread('s1', { sender: ME.name, email: 'lucas@example.com', subject: 'Re: Quote for the new office chairs', preview: 'Looks good, please go ahead with the order.', minutes: 170, labels: ['SENT'] }),
  ]
  const threadsFor = (slug) => {
    if (slug === 'sent') return sent
    if (slug === 'inbox') return inbox
    return []
  }

  return mockApi(page, new URL(env.platformBase).origin, [
    ['GET /api/mail-accounts', () => ({ data: [account], pagination: { totalCount: 1, hasMore: false, cursor: null } })],
    ['GET /api/mail-labels', () => ({ data: [] })],
    [
      'GET /api/mail-labels/threads',
      ({ url }) => {
        const threads = threadsFor(url.searchParams.get('labelSlug'))
        return { data: { threads, totalCount: threads.length } }
      },
    ],
    [
      'GET /api/mail-messages/stats',
      () => ({
        data: {
          total: 42, unread: 2, inboxUnread: 2, starredUnread: 0, sentUnread: 0, drafts: 0,
          spam: 0, trashUnread: 0, snoozed: 0, scheduled: 0, importantUnread: 0, archiveUnread: 0,
        },
      }),
    ],
    ['GET /api/user-preferences', () => ({ data: { uiPreferences: { mailLastAccountId: ACCOUNT_ID } } })],
    ['GET /api/people/recent-correspondents', () => ({ data: [RECIPIENT] })],
    [
      'GET /api/people',
      ({ url }) => {
        const q = (url.searchParams.get('search') ?? '').toLowerCase()
        const hit = `${RECIPIENT.firstName} ${RECIPIENT.lastName} ${RECIPIENT.email}`.toLowerCase().includes(q)
        const data = hit ? [RECIPIENT] : []
        return { data, pagination: { totalCount: data.length, hasMore: false, cursor: null } }
      },
    ],
    [
      /^POST \/api\/mail-accounts\/[^/]+\/send$/,
      ({ json }) => {
        sent.unshift(
          thread('new', {
            sender: ME.name,
            email: RECIPIENT.email,
            subject: json?.subject ?? EMAIL.subject,
            preview: EMAIL.body.filter(Boolean).slice(0, 2).join(' '),
            minutes: 0,
            labels: ['SENT'],
          }),
        )
        return { data: { messageId: 'msg_sent_preview' } }
      },
    ],
  ])
}

async function run(d, page) {
  await d.pause(700)

  await d.caption('Open WeldMail and click Compose')
  await d.click(page.getByRole('button', { name: 'Compose', exact: true }))
  await page.getByTestId('compose-body').waitFor({ state: 'visible' })
  await d.pause(700)

  await d.caption('Add a recipient: start typing a name and pick the contact')
  await d.type(page.getByPlaceholder('Add recipients...'), 'Jam', { delay: 110 })
  const suggestion = page.getByRole('button', { name: /Jamie Rivera/ })
  await suggestion.waitFor({ state: 'visible' })
  await d.pause(500)
  await d.click(suggestion)

  await d.caption('Enter a subject')
  await d.type(page.getByPlaceholder('Subject', { exact: true }), EMAIL.subject)

  await d.caption('Write your message')
  await d.click(page.getByTestId('compose-body'))
  for (const [i, line] of EMAIL.body.entries()) {
    if (i > 0) await page.keyboard.press('Enter')
    if (line) await page.keyboard.type(line, { delay: 28 })
  }
  await d.pause(900)

  await d.caption('Click Send')
  await d.click(page.getByTestId('compose-send-btn'))
  await page.getByText('Email sent successfully').waitFor({ state: 'visible' })
  await d.pause(1400)

  await d.caption('Done! Sent messages appear in your Sent folder', { numbered: false })
  await d.click(page.getByRole('link', { name: /^Sent/ }).first())
  await page.getByText(EMAIL.subject).first().waitFor({ state: 'visible' })
  await d.pause(2600)
  await d.hideCaption()
}

export default {
  name: 'weldmail-send-email',
  url: (env) => `${env.platformBase}/preview/weldmail/${ACCOUNT_ID}/inbox`,
  readySelector: `text=${inbox[0].subject}`,
  intro: { eyebrow: 'WeldMail', title: 'How to send an email', subtitle: 'Compose, address and send a new message' },
  outro: { eyebrow: 'WeldMail', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
