/**
 * Live WeldChat message-interaction coverage — reactions, pinning, threads,
 * and the private-channel member-add affordance, plus regression sentinels for
 * the message-action bugs surfaced during manual QA.
 *
 * Like messaging.spec.ts these seed real rows via the test-fixtures API and
 * drive the rendered chat surface, so they are gated on
 * `isTestFixturesConfigured()` and skip when the fixtures env is absent. Each
 * test deletes its seeded channel in afterEach (cascade-cleans messages +
 * members + reactions + pins).
 *
 * Known-bug tests are intentionally NOT plain passing tests:
 *   - `test.fail()` marks a deterministic gap that MUST currently fail; if the
 *     gap is closed the test "unexpectedly passes" and turns the suite red,
 *     prompting removal of the annotation.
 *   - `test.fixme()` documents an environment-dependent bug whose body encodes
 *     the intended behaviour; un-fixme it when the fix lands.
 *
 * Backend note: every chat action here — message list/send, reactions, pin,
 * delete, thread reads — now runs on app-api; use-weldchat-queries.ts left the
 * legacy api-worker client in W5b. Reactions render via an optimistic cache
 * update so they assert reliably; pin/thread-count still wait on a server
 * round-trip, hence the generous timeouts.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

const TEST_USER_ID = process.env.TEST_USER_ID;

// Heavy channel pages (REST queries, websocket room, presence/active-call
// polling) + API seeding — run one at a time to avoid starving the single dev
// server under local parallelism. (CI already pins workers:1.)
test.describe.configure({ mode: 'serial' });

test.describe('WeldChat · message actions (seed-gated)', () => {
  let channelId: string | null = null;

  test.beforeAll(() => {
    test.skip(
      !isTestFixturesConfigured(),
      'test-fixtures env vars not set — skipping live WeldChat message-action tests',
    );
  });

  test.afterEach(async ({ api }) => {
    if (channelId) {
      await api.deleteEntity('chatChannel', channelId);
      channelId = null;
    }
  });

  // Seed a channel the test user owns (so it is viewable + writable) plus a
  // single message, then open it and wait for the list to render.
  async function seedChannelWithMessage(
    api: typeof import('../../helpers/test-fixtures-client').testFixtures,
    page: import('@playwright/test').Page,
    opts: { name: string; content: string; type?: 'public' | 'private' },
  ) {
    const channel = await api.seedChatChannel({ name: opts.name, type: opts.type });
    channelId = channel.id;
    if (TEST_USER_ID) {
      await api.seedChatChannelMember({ channelId: channel.id, userId: TEST_USER_ID, role: 'owner' });
    }
    const message = await api.seedChatMessage({ channelId: channel.id, content: opts.content });

    await page.goto(`/weldchat/${channel.id}`);
    await expect(page.getByTestId('chat-message-list')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('chat-message').first()).toBeVisible({ timeout: 15_000 });
    return { channel, message };
  }

  // -------------------------------------------------------------------------
  // Features that WORK
  // -------------------------------------------------------------------------

  test('reacting to a message shows a reaction chip with a count', async ({ page, api }) => {
    await seedChannelWithMessage(api, page, {
      name: `E2E React ${Date.now().toString(36)}`,
      content: 'React to me',
    });

    // Hover the message to reveal the floating action bar, open the emoji
    // popover (Smile button, title="Add reaction"), and pick 👍.
    const message = page.getByTestId('chat-message').first();
    await message.hover();
    await page.getByTitle('Add reaction').click();
    await page.getByRole('button', { name: '👍' }).click();

    // The optimistic cache update renders the chip immediately, independent of
    // the (legacy-worker) network round-trip.
    const chip = page.getByTestId('chat-reaction');
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toContainText('1');
  });

  test('pinning a message surfaces it in the pinned bar', async ({ page, api }) => {
    await seedChannelWithMessage(api, page, {
      name: `E2E Pin ${Date.now().toString(36)}`,
      content: 'Pin me please',
    });

    // Right-click opens the message context menu; Pin message opens the
    // duration dialog; "Pin silently" pins with the default (Forever).
    await page.getByTestId('chat-message').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin message' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: 'Pin silently' }).click();

    const pinnedBar = page.getByTestId('chat-pinned-bar');
    await expect(pinnedBar).toBeVisible({ timeout: 15_000 });
    await expect(pinnedBar).toContainText('Pin me please');
  });

  test('a seeded thread reply shows a reply-count indicator that opens the thread', async ({ page, api }) => {
    const channel = await api.seedChatChannel({ name: `E2E Thread ${Date.now().toString(36)}` });
    channelId = channel.id;
    if (TEST_USER_ID) {
      await api.seedChatChannelMember({ channelId: channel.id, userId: TEST_USER_ID, role: 'owner' });
    }
    const parent = await api.seedChatMessage({ channelId: channel.id, content: 'Thread root message' });
    const replyText = 'Seeded thread reply';
    await api.seedChatMessage({ channelId: channel.id, content: replyText, parentId: parent.id });

    await page.goto(`/weldchat/${channel.id}`);
    await expect(page.getByTestId('chat-message-list')).toBeVisible({ timeout: 15_000 });

    // The parent renders a "N replies" indicator computed from its children.
    const indicator = page.getByTestId('chat-thread-indicator');
    await expect(indicator).toBeVisible({ timeout: 15_000 });
    await expect(indicator).toContainText('1');

    // Clicking it routes to the thread view, which renders the reply.
    await indicator.click();
    await expect(page).toHaveURL(
      new RegExp(`/weldchat/${channel.id}/thread/${parent.id}`),
      { timeout: 10_000 },
    );
    await expect(page.getByText(replyText)).toBeVisible({ timeout: 10_000 });
  });

  test('a private channel exposes an "Invite people" affordance for existing teammates', async ({ page, api }) => {
    test.skip(!TEST_USER_ID, 'TEST_USER_ID not set — cannot seed an owning member for a private channel');
    const channel = await api.seedChatChannel({
      name: `E2E Private ${Date.now().toString(36)}`,
      type: 'private',
    });
    channelId = channel.id;
    await api.seedChatChannelMember({ channelId: channel.id, userId: TEST_USER_ID!, role: 'owner' });

    await page.goto(`/weldchat/${channel.id}`);
    await expect(page.getByTestId('chat-message-list')).toBeVisible({ timeout: 15_000 });

    // Open the People panel and click "Invite people" — the redesigned member
    // affordance (channel-people-tab.tsx) that replaced the old icon-only "Add
    // members" button. It opens the invite dialog whose private-channel default
    // "Members" tab is the search used to add existing teammates.
    await page.getByRole('button', { name: /show members/i }).click();
    await expect(page.getByTestId('chat-member-row').first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /invite people/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole('tab', { name: /members/i })).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Known bugs / gaps — regression sentinels
  // -------------------------------------------------------------------------

  test('own message exposes an Edit action [KNOWN GAP: edit UI not wired]', async ({ page, api }) => {
    test.skip(!TEST_USER_ID, 'TEST_USER_ID not set — cannot seed an own-authored message');
    // useEditMessage() (and the backend PATCH route + an "(edited)" badge) all
    // exist, but no menu item / trigger invokes it anywhere in the chat UI, so
    // a user cannot edit a message they sent. Expected-to-fail until wired up.
    test.fail();

    const channel = await api.seedChatChannel({ name: `E2E Edit ${Date.now().toString(36)}` });
    channelId = channel.id;
    await api.seedChatChannelMember({ channelId: channel.id, userId: TEST_USER_ID!, role: 'owner' });
    await api.seedChatMessage({ channelId: channel.id, content: 'Edit me', authorId: TEST_USER_ID! });

    await page.goto(`/weldchat/${channel.id}`);
    await expect(page.getByTestId('chat-message').first()).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('chat-message').first().click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: /edit/i })).toBeVisible({ timeout: 5_000 });
  });

  // KNOWN BUG: "Delete message" fires a success toast unconditionally (not in
  // onSuccess) and the row is not optimistically removed; deletes route through
  // the legacy api-worker while the list reads app-api, so the message lingers
  // until a manual reload. Un-fixme once delete is migrated to app-api with an
  // optimistic cache removal.
  test.fixme('deleting a message removes it from the list without a reload [KNOWN BUG]', async ({ page, api }) => {
    await seedChannelWithMessage(api, page, {
      name: `E2E Delete ${Date.now().toString(36)}`,
      content: 'Delete me',
    });

    await page.getByTestId('chat-message').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete message' }).click();

    // Toast appears immediately…
    await expect(page.getByText('Message deleted')).toBeVisible({ timeout: 5_000 });
    // …and the row should disappear WITHOUT a page reload.
    await expect(page.getByTestId('chat-message')).toHaveCount(0, { timeout: 10_000 });
  });

  // KNOWN BUG: deleting the only reply in a thread does not decrement the
  // parent's reply count — the "1 reply" indicator persists (and the thread is
  // empty). Un-fixme once delete updates the parent threadReplyCount.
  test.fixme('deleting the only thread reply clears the parent reply indicator [KNOWN BUG]', async ({ page, api }) => {
    const channel = await api.seedChatChannel({ name: `E2E ThreadDel ${Date.now().toString(36)}` });
    channelId = channel.id;
    if (TEST_USER_ID) {
      await api.seedChatChannelMember({ channelId: channel.id, userId: TEST_USER_ID, role: 'owner' });
    }
    const parent = await api.seedChatMessage({ channelId: channel.id, content: 'Parent with one reply' });
    const reply = await api.seedChatMessage({
      channelId: channel.id,
      content: 'Only reply',
      parentId: parent.id,
    });

    await page.goto(`/weldchat/${channel.id}/thread/${parent.id}`);
    await expect(page.getByText('Only reply')).toBeVisible({ timeout: 15_000 });

    // Delete the reply from the thread view…
    await page.getByText('Only reply').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete message' }).click();
    await expect(page.getByText('Message deleted')).toBeVisible({ timeout: 5_000 });

    // …and the parent's reply indicator should be gone back in the channel.
    void reply;
    await page.goto(`/weldchat/${channel.id}`);
    await expect(page.getByTestId('chat-message-list')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('chat-thread-indicator')).toHaveCount(0, { timeout: 10_000 });
  });
});
