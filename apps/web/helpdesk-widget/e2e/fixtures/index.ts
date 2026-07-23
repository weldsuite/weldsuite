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
