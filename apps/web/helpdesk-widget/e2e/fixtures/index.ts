import { test as base, expect, Page, Locator } from '@playwright/test';

/**
 * Widget test fixture configuration
 */
export interface WidgetConfig {
  widgetId: string;
  apiKey: string;
  workspaceId: string;
}

/**
 * Test user data
 */
export interface TestUser {
  name: string;
  email: string;
  subject?: string;
  message?: string;
}

/**
 * Widget page object model
 */
export class WidgetPage {
  readonly page: Page;
  readonly launcher: Locator;
  readonly widget: Locator;
  readonly closeButton: Locator;
  readonly backButton: Locator;
  readonly homeView: Locator;
  readonly chatView: Locator;
  readonly preChatForm: Locator;
  readonly messageInput: Locator;
  readonly sendButton: Locator;
  readonly messageList: Locator;

  constructor(page: Page) {
    this.page = page;

    // Main elements
    this.launcher = page.locator('[data-testid="widget-launcher"]');
    this.widget = page.locator('[data-testid="widget-container"]');
    this.closeButton = page.locator('[data-testid="close-button"]');
    this.backButton = page.locator('[data-testid="back-button"]');

    // Views
    this.homeView = page.locator('[data-testid="home-view"]');
    this.chatView = page.locator('[data-testid="chat-view"]');
    this.preChatForm = page.locator('[data-testid="pre-chat-form"]');

    // Chat elements
    this.messageInput = page.locator('[data-testid="message-input"]');
    this.sendButton = page.locator('[data-testid="send-button"]');
    this.messageList = page.locator('[data-testid="message-list"]');
  }

  /**
   * Navigate to the widget test page
   */
  async goto(path: string = '/') {
    await this.page.goto(path);
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Wait for widget to be ready
   */
  async waitForReady() {
    // Wait for the widget to load and be interactive
    await this.page.waitForFunction(() => {
      return document.readyState === 'complete';
    });
  }

  /**
   * Open the widget
   */
  async open() {
    const launcher = this.page.locator('button').filter({ hasText: /chat|help|support/i }).first();
    if (await launcher.isVisible()) {
      await launcher.click();
    }
  }

  /**
   * Close the widget
   */
  async close() {
    if (await this.closeButton.isVisible()) {
      await this.closeButton.click();
    }
  }

  /**
   * Navigate to a specific view
   */
  async navigateTo(view: 'home' | 'chat' | 'help' | 'news' | 'feedback') {
    const navButton = this.page.locator(`[data-testid="nav-${view}"]`);
    if (await navButton.isVisible()) {
      await navButton.click();
    }
  }

  /**
   * Fill pre-chat form
   */
  async fillPreChatForm(user: TestUser) {
    const nameInput = this.page.locator('input[name="name"], input[placeholder*="name" i]');
    const emailInput = this.page.locator('input[name="email"], input[type="email"]');
    const subjectInput = this.page.locator('input[name="subject"], input[placeholder*="subject" i]');
    const messageInput = this.page.locator('textarea[name="message"], textarea[placeholder*="message" i]');

    if (await nameInput.isVisible()) {
      await nameInput.fill(user.name);
    }
    if (await emailInput.isVisible()) {
      await emailInput.fill(user.email);
    }
    if (user.subject && await subjectInput.isVisible()) {
      await subjectInput.fill(user.subject);
    }
    if (user.message && await messageInput.isVisible()) {
      await messageInput.fill(user.message);
    }
  }

  /**
   * Submit pre-chat form
   */
  async submitPreChatForm() {
    const submitButton = this.page.locator('button[type="submit"]').first();
    await submitButton.click();
  }

  /**
   * Send a chat message
   */
  async sendMessage(text: string) {
    await this.messageInput.fill(text);
    await this.sendButton.click();
  }

  /**
   * Get all messages in the chat
   */
  async getMessages(): Promise<string[]> {
    const messages = await this.page.locator('[data-testid="message"]').allTextContents();
    return messages;
  }

  /**
   * Wait for a message to appear
   */
  async waitForMessage(text: string, timeout = 10000) {
    await this.page.locator('[data-testid="message"]').filter({ hasText: text }).waitFor({ timeout });
  }

  /**
   * Open the standalone messenger against the mocked widget API
   * (see setupMessengerApi) and start a new conversation, so the composer
   * is on screen.
   */
  async openComposer() {
    await this.goto(`/?widgetId=${MESSENGER_WIDGET_ID}&open=true`);
    await this.page.locator('[data-testid="new-conversation"]').click();
    await expect(this.messageInput).toBeVisible();
  }

  /**
   * Check if widget is open
   */
  async isOpen(): Promise<boolean> {
    return await this.widget.isVisible();
  }

  /**
   * Get current view name
   */
  async getCurrentView(): Promise<string | null> {
    const viewElement = this.page.locator('[data-view]');
    if (await viewElement.isVisible()) {
      return await viewElement.getAttribute('data-view');
    }
    return null;
  }
}

/**
 * Extended test fixture with widget helpers
 */
export const test = base.extend<{
  widgetPage: WidgetPage;
  testUser: TestUser;
}>({
  widgetPage: async ({ page }, use) => {
    const widgetPage = new WidgetPage(page);
    await use(widgetPage);
  },

  testUser: async ({}, use) => {
    await use({
      name: 'Test User',
      email: 'test@example.com',
      subject: 'Test Subject',
      message: 'This is a test message',
    });
  },
});

export { expect };

/**
 * Mock API responses for testing
 */
export const mockResponses = {
  widgetConfig: {
    id: 'test-widget',
    name: 'Test Widget',
    primaryColor: '#0066FF',
    welcomeMessage: 'Welcome! How can we help?',
    pageHome: true,
    pageChat: true,
    pageHelp: true,
    pageFeedback: true,
    pageNews: false,
  },

  conversation: {
    id: 'conv-123',
    status: 'open',
    messages: [],
    createdAt: new Date().toISOString(),
  },

  agentsOnline: {
    online: true,
    agents: [
      { id: 'agent-1', name: 'Support Agent', status: 'online' },
    ],
  },

  message: {
    id: 'msg-123',
    conversationId: 'conv-123',
    content: 'Hello! How can I help you today?',
    senderType: 'agent',
    senderName: 'Support Agent',
    createdAt: new Date().toISOString(),
  },
};

/**
 * Setup mock API routes
 */
export async function setupMockApi(page: Page) {
  // Mock widget config endpoint
  await page.route('**/api/widget/*/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockResponses.widgetConfig),
    });
  });

  // Mock widget settings endpoint
  await page.route('**/api/widget/*/settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockResponses.widgetConfig),
    });
  });

  // Mock agents online endpoint
  await page.route('**/api/widget/customer/agents/online', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockResponses.agentsOnline),
    });
  });

  // Mock conversations endpoint
  await page.route('**/api/widget/customer/conversations', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(mockResponses.conversation),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    }
  });

  // Mock messages endpoint
  await page.route('**/api/widget/customer/conversations/*/messages', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(mockResponses.message),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    }
  });
}

export const MESSENGER_WIDGET_ID = 'test-widget';

/** Config as helpdesk-widget-api serves it (WidgetConfigResponse). */
export const messengerConfig = {
  widgetId: MESSENGER_WIDGET_ID,
  name: 'Test Widget',
  enabled: true,
  greeting: 'Welcome! How can we help?',
  branding: { primaryColor: '#0066FF', backgroundColor: '#FFFFFF', position: 'right' },
  showBranding: false,
  realtimeUrl: null,
  team: [{ name: 'Support Agent', avatar: null }],
};

export interface MessengerApiOptions {
  /** Answer the first N config requests with a 500 before serving the config. */
  configFailures?: number;
  /** Answer message sends with a 500. */
  failSend?: boolean;
}

export interface MessengerApiStats {
  configRequests: number;
  sendRequests: number;
  identifyRequests: number;
}

/**
 * Mock the current helpdesk-widget-api surface (`/api/config`,
 * `/api/conversations/...`) with its `{ success, data }` envelope, so the
 * messenger actually renders. Returns live request counters.
 */
export async function setupMessengerApi(page: Page, options: MessengerApiOptions = {}): Promise<MessengerApiStats> {
  const stats: MessengerApiStats = { configRequests: 0, sendRequests: 0, identifyRequests: 0 };
  const ok = (data: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data }),
  });
  const fail = { status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'Server error' } }) };
  const now = () => new Date().toISOString();
  const conversation = () => ({
    id: 'conv-123',
    conversationNumber: 1,
    title: null,
    state: 'open',
    createdAt: now(),
    lastMessageAt: now(),
    lastMessagePreview: null,
    lastMessageFromTeam: false,
    assignee: null,
  });
  const visitorMessage = (body: string, clientId: string | null) => ({
    id: `msg-${Date.now()}`,
    conversationId: 'conv-123',
    kind: 'message',
    body,
    authorType: 'visitor',
    authorName: null,
    authorAvatar: null,
    attachments: null,
    eventType: null,
    clientId,
    createdAt: now(),
  });

  const sent: ReturnType<typeof visitorMessage>[] = [];

  await page.route((url) => url.pathname === '/api/config', async (route) => {
    stats.configRequests++;
    if (stats.configRequests <= (options.configFailures ?? 0)) {
      await route.fulfill(fail);
      return;
    }
    await route.fulfill(ok(messengerConfig));
  });

  await page.route((url) => url.pathname.startsWith('/api/conversations'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const input = (request.postDataJSON() ?? {}) as { body?: string; clientId?: string; email?: string };

    if (path === '/api/conversations/identify') {
      stats.identifyRequests++;
      await route.fulfill(ok({ visitor: { id: 'visitor-1', name: null, email: input.email ?? null } }));
      return;
    }
    if (request.method() === 'POST') {
      stats.sendRequests++;
      if (options.failSend) {
        await route.fulfill(fail);
        return;
      }
      const message = visitorMessage(input.body ?? '', input.clientId ?? null);
      sent.push(message);
      await route.fulfill(ok({ conversation: conversation(), message }));
      return;
    }
    if (path === '/api/conversations') {
      await route.fulfill(ok(sent.length > 0 ? [conversation()] : []));
      return;
    }
    await route.fulfill(ok({ conversation: conversation(), messages: sent }));
  });

  return stats;
}
