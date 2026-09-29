/**
 * Support video: "How to send a message in a channel" (WeldChat).
 * Embedded in src/app/weldchat/channels-and-messages/page.md.
 *
 * Messages come straight from the API fixtures (no realtime connection is
 * needed): the sent message is echoed by the POST response and added to the
 * list the channel query returns afterwards.
 */
import { mockApi } from '../mock-api.mjs'

const ME = { id: 'user_alex', name: 'Alex Morgan' }
const MESSAGE = 'Kickoff is moved to Tuesday at 10:00. Please update your calendars!'

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString()

const CHANNELS = [
  { id: 'ch_announcements', name: 'announcements', type: 'public', description: 'Company-wide news', memberCount: 12, lastMessageAt: minutesAgo(200), lastReadAt: minutesAgo(190) },
  { id: 'ch_general', name: 'general', type: 'public', description: 'Everything else', memberCount: 12, isDefault: true, lastMessageAt: minutesAgo(9), lastReadAt: minutesAgo(9) },
  { id: 'ch_design', name: 'design-team', type: 'public', description: 'Design reviews and assets', memberCount: 5, lastMessageAt: minutesAgo(90), lastReadAt: minutesAgo(90) },
  { id: 'ch_leadership', name: 'leadership', type: 'private', description: 'Leadership team', memberCount: 4, lastMessageAt: minutesAgo(400), lastReadAt: minutesAgo(400) },
].map((c) => ({
  isArchived: false,
  isMuted: false,
  isPrivate: c.type === 'private',
  voiceCallsEnabled: true,
  videoCallsEnabled: true,
  createdBy: ME.id,
  createdAt: '2026-01-15T12:00:00.000Z',
  sectionId: null,
  topic: null,
  icon: null,
  unreadMentionCount: 0,
  ...c,
}))

const DMS = [
  ['dm_priya', 'user_priya', 'Priya Shah', 'priya@acme.example', 20],
  ['dm_daniel', 'user_daniel', 'Daniel Okafor', 'daniel@acme.example', 150],
].map(([id, userId, name, email, minutes]) => ({
  id,
  type: 'dm',
  name: null,
  isArchived: false,
  isMuted: false,
  memberCount: 2,
  createdAt: '2026-01-15T12:00:00.000Z',
  lastMessageAt: minutesAgo(minutes),
  lastReadAt: minutesAgo(minutes),
  unreadMentionCount: 0,
  otherMembers: [{ id: `mem_${userId}`, userId, name, email, picture: null, role: 'member', memberType: 'user' }],
}))

const MEMBERS = [
  [ME.id, ME.name, 'alex@acme.example', 'owner'],
  ['user_priya', 'Priya Shah', 'priya@acme.example', 'member'],
  ['user_daniel', 'Daniel Okafor', 'daniel@acme.example', 'member'],
  ['user_mia', 'Mia Chen', 'mia.chen@acme.example', 'member'],
].map(([userId, name, email, role]) => ({
  id: `mem_${userId}`,
  userId,
  name,
  email,
  picture: null,
  role,
  memberType: 'user',
  workspaceMemberType: 'internal',
}))

const author = (name) => ({ authorId: `user_${name.split(' ')[0].toLowerCase()}`, authorName: name, authorAvatar: null, authorType: 'user' })

function message(id, channelId, who, content, minutes) {
  return {
    id: `msg_${id}`,
    channelId,
    content,
    htmlContent: null,
    type: 'message',
    ...author(who),
    reactions: {},
    attachments: [],
    mentions: [],
    threadReplyCount: 0,
    isEdited: false,
    isPinned: false,
    createdAt: minutesAgo(minutes),
    updatedAt: minutesAgo(minutes),
  }
}

const seed = {
  ch_announcements: [
    message('a1', 'ch_announcements', 'Priya Shah', 'Welcome to the new WeldChat workspace! Use this channel for company-wide news.', 200),
  ],
  ch_general: [
    message('g1', 'ch_general', 'Priya Shah', 'Morning everyone! The Northfield proposal was signed off yesterday.', 42),
    message('g2', 'ch_general', 'Daniel Okafor', 'Great news. I will start preparing the project plan this afternoon.', 31),
    message('g3', 'ch_general', 'Mia Chen', 'Workshop photos are in the shared drive if anyone needs them.', 9),
  ],
  ch_design: [message('d1', 'ch_design', 'Mia Chen', 'New homepage mockups are ready for review.', 90)],
  ch_leadership: [message('l1', 'ch_leadership', 'Priya Shah', 'Budget review is scheduled for Friday.', 400)],
}

function mockRoutes(page, env) {
  const posted = { ch_general: [] }
  const listChannels = () => ({ data: CHANNELS, pagination: { totalCount: CHANNELS.length, hasMore: false, cursor: null } })

  return mockApi(page, new URL(env.platformBase).origin, [
    ['GET /api/channels', listChannels],
    [/^GET \/api\/channels\/[^/]+$/, ({ url }) => ({ data: CHANNELS.find((c) => url.pathname.endsWith(`/${c.id}`)) ?? CHANNELS[0] })],
    [
      /^GET \/api\/channels\/[^/]+\/messages$/,
      ({ url }) => {
        const id = url.pathname.split('/')[3]
        const messages = [...(posted[id] ?? []), ...[...(seed[id] ?? [])].reverse()]
        return { data: { messages, hasMore: false } }
      },
    ],
    [
      /^POST \/api\/channels\/[^/]+\/messages$/,
      ({ url, json }) => {
        const id = url.pathname.split('/')[3]
        const sent = {
          ...message(`sent_${Date.now()}`, id, ME.name, json?.content ?? MESSAGE, 0),
          authorId: ME.id,
          createdAt: new Date().toISOString(),
        }
        ;(posted[id] ??= []).unshift(sent)
        return { data: sent }
      },
    ],
    [/^GET \/api\/channels\/[^/]+\/members$/, () => ({ data: MEMBERS })],
    [
      'GET /api/chat-dm',
      () => ({
        data: DMS,
        pagination: { totalCount: DMS.length, hasMore: false, cursor: null },
      }),
    ],
  ])
}

async function run(d, page) {
  await d.pause(700)

  await d.caption('Open WeldChat and look at Channels in the sidebar')
  await d.moveTo(page.getByRole('link', { name: /design-team/ }).first())
  await d.pause(900)

  await d.caption('Click a channel name to open its message history')
  await d.click(page.getByRole('link', { name: /^general/ }).first())
  await page.getByText('Workshop photos are in the shared drive').waitFor({ state: 'visible' })
  await d.pause(1200)

  await d.caption('Select the message box at the bottom and type your message')
  const composer = page.getByTestId('chat-composer')
  await d.click(composer)
  await page.keyboard.type(MESSAGE, { delay: 32 })
  await d.pause(900)

  await d.caption('Press Enter to send')
  await page.keyboard.press('Enter')
  await page.getByText(MESSAGE).last().waitFor({ state: 'visible' })
  await d.pause(1200)

  await d.caption('Done! Your message is now in the channel', { numbered: false })
  await d.pause(2600)
  await d.hideCaption()
}

export default {
  name: 'weldchat-channels-and-messages',
  url: (env) => `${env.platformBase}/preview/weldchat/ch_announcements`,
  readySelector: 'text=Welcome to the new WeldChat workspace',
  // Captions at the top so they never hide the message box.
  captionPosition: 'top',
  intro: { eyebrow: 'WeldChat', title: 'How to send a message in a channel', subtitle: 'Open a channel and post to your team' },
  outro: { eyebrow: 'WeldChat', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
