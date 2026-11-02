import { test, expect, setupMessengerApi, MESSENGER_WIDGET_ID } from '../fixtures';

const MESSENGER_URL = `/?widgetId=${MESSENGER_WIDGET_ID}&open=true`;
const inTwoDays = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

test.describe('Office hours', () => {
  test('shows the away message, reply time and an email box outside office hours', async ({ page }) => {
    await setupMessengerApi(page, {
      config: {
        availability: { isOpen: false, nextOpenAt: inTwoDays() },
        awayMessage: 'We are off for the weekend.',
        expectedReplyTime: 'few_hours',
      },
    });
    await page.goto(MESSENGER_URL);

    const notice = page.locator('[data-testid="away-notice"]');
    await expect(notice).toContainText('We are off for the weekend.');
    await expect(notice).toContainText(/Back \w+ at/);
    await expect(notice).toContainText('Usually replies in a few hours');
    await expect(page.locator('[data-testid="email-capture"]')).toContainText('Leave your email so we can reply');

    // The conversation view nudges for an email before anything is sent.
    await page.locator('[data-testid="new-conversation"]').click();
    await expect(page.locator('[data-testid="chat-subtitle"]')).toHaveText("We're away right now");
    await expect(page.locator('[data-testid="chat-view"] [data-testid="away-notice"]')).toBeVisible();
    await expect(page.locator('[data-testid="chat-view"] [data-testid="email-capture"]')).toBeVisible();
  });

  test('falls back to the default away message', async ({ page }) => {
    await setupMessengerApi(page, { config: { availability: { isOpen: false, nextOpenAt: null } } });
    await page.goto(MESSENGER_URL);
    await expect(page.locator('[data-testid="away-notice"]')).toContainText("we'll get back to you by email");
  });

  test('shows only the reply time during office hours', async ({ page }) => {
    await setupMessengerApi(page, {
      config: { availability: { isOpen: true, nextOpenAt: null }, expectedReplyTime: 'hour' },
    });
    await page.goto(MESSENGER_URL);

    await expect(page.locator('[data-testid="new-conversation"]')).toContainText('Usually replies within an hour');
    await expect(page.locator('[data-testid="away-notice"]')).toHaveCount(0);
    await page.locator('[data-testid="new-conversation"]').click();
    await expect(page.locator('[data-testid="chat-subtitle"]')).toHaveText('Usually replies within an hour');
    // Email is only asked for once the visitor has written something.
    await expect(page.locator('[data-testid="email-capture"]')).toHaveCount(0);
  });
});

test.describe('CSAT rating', () => {
  test('rates a closed conversation with a comment', async ({ page }) => {
    const stats = await setupMessengerApi(page, { closedConversation: true });
    await page.goto(MESSENGER_URL);

    await page.locator('[data-testid="nav-messages"]').click();
    await page.getByRole('button', { name: /All sorted!/ }).click();

    const card = page.locator('[data-testid="rating-card"]');
    await expect(card).toContainText('How did we do?');
    await expect(page.locator('[data-testid="rating-submit"]')).toHaveCount(0);

    await page.locator('[data-testid="rating-star-4"]').click();
    await page.locator('[data-testid="rating-comment"]').fill('Quick and friendly');
    await page.locator('[data-testid="rating-submit"]').click();

    await expect(page.locator('[data-testid="rating-done"]')).toContainText('Thanks for your feedback!');
    await expect(page.locator('[data-testid="rating-done"]')).toContainText('4/5');
    await expect(page.locator('[data-testid="rating-card"]')).toHaveCount(0);
    // The visitor is the bearer of the visitor token, never a field in the body.
    expect(stats.ratings).toEqual([{ rating: 4, comment: 'Quick and friendly' }]);
  });

  test('does not ask to rate an open conversation', async ({ widgetPage, page }) => {
    await setupMessengerApi(page);
    await widgetPage.openComposer();
    await widgetPage.sendMessage('Hello');
    await expect(page.locator('[data-testid="rating-card"]')).toHaveCount(0);
  });
});

test.describe('Visitor session', () => {
  test('opens a session first and sends its token on every call', async ({ widgetPage, page }) => {
    const stats = await setupMessengerApi(page);
    await widgetPage.openComposer();
    await widgetPage.sendMessage('Hello');
    await expect(page.locator('[data-testid="message"]').filter({ hasText: 'Hello' })).toBeVisible();

    expect(stats.sessionRequests.length).toBeGreaterThanOrEqual(1);
    expect(stats.unauthorizedCalls).toBe(0);
    expect(stats.bodiesWithVisitorId).toBe(0);
  });

  test('keeps the visitor token it was given', async ({ page }) => {
    const stats = await setupMessengerApi(page);
    await page.goto(MESSENGER_URL);
    await expect(page.locator('[data-testid="home-view"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-testid="home-view"]')).toBeVisible();
    await expect.poll(() => stats.sessionRequests.length).toBeGreaterThanOrEqual(2);
    expect(stats.sessionRequests.at(-1)).toEqual({ visitorToken: 'vt_test' });
  });

  test('swaps the old browser-made visitor id once', async ({ page }) => {
    const stats = await setupMessengerApi(page);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('weldsuite_helpdesk_visitor_id', 'visitor_123_abc');
      }
    });
    await page.goto(MESSENGER_URL);
    await expect(page.locator('[data-testid="home-view"]')).toBeVisible();
    await expect.poll(() => stats.sessionRequests.length).toBeGreaterThanOrEqual(1);
    expect(stats.sessionRequests[0]).toEqual({ legacyVisitorId: 'visitor_123_abc' });
    expect(await page.evaluate(() => localStorage.getItem('weldsuite_helpdesk_visitor_id'))).toBeNull();
  });

  test('asks the visitor to sign in on the site when the widget requires it', async ({ page }) => {
    await setupMessengerApi(page, { identityRequired: true });
    await page.goto(MESSENGER_URL);
    await expect(page.locator('[data-testid="sign-in-required"]')).toContainText('Sign in to chat with us');
    await expect(page.locator('[data-testid="new-conversation"]')).toHaveCount(0);
  });
});
