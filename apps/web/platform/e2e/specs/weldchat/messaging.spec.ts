/**
 * Live WeldChat messaging coverage.
 *
 * Unlike the other WeldChat specs (which assert structural / client-state UI),
 * these tests seed real channels + messages via the test-fixtures API and
 * exercise the end-to-end render + send flow against app-api. They are gated
 * with `isTestFixturesConfigured()` so they skip gracefully when the fixtures
 * env (TEST_API_URL / TEST_FIXTURES_TOKEN / TEST_WORKSPACE_ID) is absent.
 *
 * Seeded channels are stamped with the [E2E_TEST] marker; each test deletes
 * its channel in afterEach (which cascade-cleans the channel's messages +
 * members), so no cross-test data leaks.
 *
 * The chat backend reads (channel detail, message list, members) and the send
 * mutation run on app-api; the messaging websocket is NOT required — seeded
 * messages render via the REST infinite query and a sent message appears via
 * the optimistic cache update.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured } from '../../helpers/test-fixtures-client';

const TEST_USER_ID = process.env.TEST_USER_ID;

// Run these tests one-at-a-time. Each loads a full channel page (REST queries,
// websocket room, presence/active-call polling) and seeds via the API — by far
// the heaviest WeldChat specs. Letting all five run concurrently (local default
// parallelism) spikes load on the single dev server enough to intermittently
// starve unrelated pages in sibling specs. Serial keeps at most one heavy
// channel page live at a time. (CI already pins workers:1.)
test.describe.configure({ mode: 'serial' });

test.describe('WeldChat · live messaging (seed-gated)', () => {
  // Channel seeded by the running test; cleaned up in afterEach.
  let channelId: string | null = null;

  test.beforeAll(() => {
    test.skip(
      !isTestFixturesConfigured(),
      'test-fixtures env vars not set — skipping live WeldChat messaging tests',
    );
  });

  test.afterEach(async ({ api }) => {
    if (channelId) {
      // Deleting the channel cascade-removes its messages + members.
      await api.deleteEntity('chatChannel', channelId);
      channelId = null;
    }
  });

  test('renders seeded messages in a channel', async ({ page, api }) => {
    const channel = await api.seedChatChannel({ name: `E2E Chat ${Date.now().toString(36)}` });
    channelId = channel.id;

    const contents = [
      'First seeded message',
      'Second seeded message',
      'Third seeded message',
    ];
    for (const content of contents) {
      await api.seedChatMessage({ channelId: channel.id, content });
    }

    await page.goto(`/weldchat/${channel.id}`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const list = page.getByTestId('chat-message-list');
    await expect(list).toBeVisible({ timeout: 15_000 });

    for (const content of contents) {
      await expect(list.getByText(content)).toBeVisible({ timeout: 10_000 });
    }
    await expect(page.getByTestId('chat-message')).toHaveCount(contents.length);
  });

  test('sending a message appends it to the channel', async ({ page, api }) => {
    const channel = await api.seedChatChannel({ name: `E2E Send ${Date.now().toString(36)}` });
    channelId = channel.id;
    if (TEST_USER_ID) {
      await api.seedChatChannelMember({ channelId: channel.id, userId: TEST_USER_ID, role: 'owner' });
    }

    await page.goto(`/weldchat/${channel.id}`);
    await expect(page.getByTestId('chat-message-list')).toBeVisible({ timeout: 15_000 });

    const composer = page.getByTestId('chat-composer');
    await composer.click();
    const text = `Hello from E2E ${Date.now().toString(36)}`;
    await page.keyboard.type(text);

    const send = page.getByTestId('chat-send');
    await expect(send).toBeEnabled({ timeout: 5_000 });
    await send.click();

    // The optimistic cache update renders the message immediately; the REST
    // POST persists it on app-api. Either way it shows in the list.
    await expect(
      page.getByTestId('chat-message-list').getByText(text),
    ).toBeVisible({ timeout: 10_000 });

    // ...and it must RECONCILE out of the optimistic (greyed, opacity-60)
    // state once the POST resolves — otherwise the message "stays grey".
    const sentRow = page.getByTestId('chat-message').filter({ hasText: text });
    await expect(sentRow).not.toHaveClass(/opacity-60/, { timeout: 10_000 });
  });

  test('an empty channel renders the message list with no messages', async ({ page, api }) => {
    const channel = await api.seedChatChannel({ name: `E2E Empty ${Date.now().toString(36)}` });
    channelId = channel.id;

    await page.goto(`/weldchat/${channel.id}`);
    await expect(page.getByTestId('chat-message-list')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('chat-message')).toHaveCount(0);
  });

  test('the member panel lists seeded channel members', async ({ page, api }) => {
    test.skip(!TEST_USER_ID, 'TEST_USER_ID not set — cannot seed a resolvable member');
    const channel = await api.seedChatChannel({ name: `E2E Members ${Date.now().toString(36)}` });
    channelId = channel.id;
    await api.seedChatChannelMember({ channelId: channel.id, userId: TEST_USER_ID!, role: 'owner' });

    await page.goto(`/weldchat/${channel.id}`);
    await expect(page.getByTestId('chat-message-list')).toBeVisible({ timeout: 15_000 });

    // Non-DM channels expose a "Show members" button that opens the channel
    // panel on the People tab, which renders the MemberListPanel.
    await page.getByRole('button', { name: /show members/i }).click();
    await expect(
      page.getByTestId('chat-member-row').first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('navigating to /weldchat redirects to a channel', async ({ page, api }) => {
    const channel = await api.seedChatChannel({
      name: `E2E Default ${Date.now().toString(36)}`,
      isDefault: true,
    });
    channelId = channel.id;

    await page.goto('/weldchat');
    // The index page resolves the default channel (or first channel) and
    // redirects into it.
    await expect(page).toHaveURL(/\/weldchat\/[^/]+$/, { timeout: 15_000 });
    await expect(page.getByTestId('chat-message-list')).toBeVisible({ timeout: 15_000 });
  });
});
