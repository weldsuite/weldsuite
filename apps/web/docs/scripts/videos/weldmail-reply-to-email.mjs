/**
 * Support video: "How to reply to an email" (WeldMail).
 * Embedded in src/app/weldmail/send-email/page.md ("Reply or forward").
 */
import { mockApi } from '../mock-api.mjs'

const ACCOUNT_ID = 'acc_preview'
const ME = { name: 'Alex Morgan', email: 'alex@acme.example' }
const SENDER = { name: 'Priya Shah', email: 'priya@northfield.example' }

const INCOMING = {
  subject: 'Can we meet on Thursday?',
  paragraphs: [
    'Hi Alex,',
    'Thanks for sending over the proposal. Could we meet on Thursday afternoon to go through the details together?',
    'Let me know what time suits you.',
    'Best,\nPriya',
  ],
}

const REPLY = ['Hi Priya,', '', 'Thursday at 14:00 works for me. See you then!', '', 'Best,', 'Alex']

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
  thread('1', { sender: SENDER.name, email: SENDER.email, subject: INCOMING.subject, preview: 'Thanks for sending over the proposal. Could we meet on Thursday afternoon…', minutes: 12, unread: true }),
  thread('2', { sender: 'Daniel Okafor', email: 'daniel@example.org', subject: 'Re: Website copy review', preview: 'I left a few comments on the homepage draft, mostly small wording tweaks.', minutes: 48 }),
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

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

const message = {
  id: 'msg_1',
  accountId: ACCOUNT_ID,
  messageId: '<thursday-meeting@northfield.example>',
  threadId: 'thr_1',
  from: { email: SENDER.email, name: SENDER.name },
  to: [{ email: ME.email, name: ME.name }],
  cc: [],
  bcc: [],
  replyTo: null,
  subject: INCOMING.subject,
  preview: INCOMING.paragraphs[1],
  textBody: INCOMING.paragraphs.join('\n\n'),
  htmlBody: INCOMING.paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join(''),
  sentDate: minutesAgo(12),
  receivedDate: minutesAgo(12),
  isRead: false,
  isStarred: false,
  isFlagged: false,
  isImportant: false,
  isDraft: false,
  isReply: false,
  hasAttachments: false,
  attachmentCount: 0,
  priority: null,
  labels: ['INBOX'],
  sizeBytes: 2048,
  scheduledFor: null,
  sendStatus: null,
  source: null,
  inReplyTo: null,
  references: null,
  externalMessageId: null,
  createdAt: minutesAgo(12),
  updatedAt: minutesAgo(12),
  deletedAt: null,
  attachments: [],
}

function mockRoutes(page, env) {
  const sent = []
  const threadsFor = (slug) => (slug === 'sent' ? sent : slug === 'inbox' ? inbox : [])

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
          total: 42, unread: 1, inboxUnread: 1, starredUnread: 0, sentUnread: 0, drafts: 0,
          spam: 0, trashUnread: 0, snoozed: 0, scheduled: 0, importantUnread: 0, archiveUnread: 0,
        },
      }),
    ],
    ['GET /api/mail-messages/msg_1', () => ({ data: message })],
    ['GET /api/mail-messages/msg_1/thread', () => ({ data: { threadId: 'thr_1', messages: [message] } })],
    ['PATCH /api/mail-messages/msg_1', () => ({ data: { id: 'msg_1' } })],
    [/^POST \/api\/mail-threads\/[^/]+\/read$/, () => ({ data: { updated: 1 } })],
    ['POST /api/mail-messages/bulk', () => ({ data: { affected: 1 } })],
    ['GET /api/mail-drafts', () => ({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } })],
    ['GET /api/user-preferences', () => ({ data: { uiPreferences: { mailLastAccountId: ACCOUNT_ID } } })],
    [
      'POST /api/mail-messages/msg_1/reply',
      () => {
        sent.unshift(
          thread('reply', {
            sender: ME.name,
            email: SENDER.email,
            subject: `Re: ${INCOMING.subject}`,
            preview: REPLY.filter(Boolean).slice(0, 2).join(' '),
            minutes: 0,
            labels: ['SENT'],
          }),
        )
        return { data: { messageId: 'msg_reply_preview', smtpMessageId: '<reply@acme.example>', pendingVerification: false, repliedTo: 'msg_1' } }
      },
    ],
  ])
}

async function run(d, page) {
  await d.pause(700)

  await d.caption('Open the message you want to answer')
  await d.click(page.getByText(INCOMING.subject).first())
  await page.getByRole('button', { name: 'Reply', exact: true }).waitFor({ state: 'visible' })
  await d.pause(1200)

  await d.caption('Click Reply')
  await d.click(page.getByRole('button', { name: 'Reply', exact: true }))
  const editor = page.locator('[contenteditable="true"]').first()
  await editor.waitFor({ state: 'visible' })
  await d.pause(900)

  await d.caption('Write your response')
  await d.click(editor)
  for (const [i, line] of REPLY.entries()) {
    if (i > 0) await page.keyboard.press('Enter')
    if (line) await page.keyboard.type(line, { delay: 28 })
  }
  await d.pause(1000)

  await d.caption('Click Send')
  await d.click(page.getByRole('button', { name: 'Send', exact: true }))
  await page.getByText('Reply sent').first().waitFor({ state: 'visible' })
  await d.pause(1600)

  await d.caption('Done! Your reply is sent and shown in the thread', { numbered: false })
  await d.pause(2400)
  await d.hideCaption()
}

export default {
  name: 'weldmail-reply-to-email',
  url: (env) => `${env.platformBase}/preview/weldmail/${ACCOUNT_ID}/inbox`,
  readySelector: `text=${INCOMING.subject}`,
  intro: { eyebrow: 'WeldMail', title: 'How to reply to an email', subtitle: 'Answer a message right from your inbox' },
  outro: { eyebrow: 'WeldMail', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
