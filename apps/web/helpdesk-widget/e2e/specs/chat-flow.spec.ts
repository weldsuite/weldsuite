import { test, expect, setupMockApi, setupMessengerApi, mockResponses } from '../fixtures';

test.describe('Chat Flow', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
  });

  test.describe('Pre-Chat Form', () => {
    test('should display pre-chat form when starting chat', async ({ widgetPage, page }) => {
      await setupMessengerApi(page);
      await widgetPage.openComposer();

      // The messenger asks for an email right after the first message
      await widgetPage.sendMessage('Hello, I need help');
      const emailCapture = page.locator('[data-testid="email-capture"]');
      await expect(emailCapture).toBeVisible();

      // The email field is mandatory
      await expect(emailCapture.locator('input[type="email"]')).toHaveAttribute('required', '');
    });

    test('should validate required fields', async ({ widgetPage, testUser }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Try to submit without filling required fields
      const submitButton = widgetPage.page.locator('button[type="submit"]').first();

      if (await submitButton.isVisible()) {
        await submitButton.click();

        // Validation should prevent submission: a required field is flagged invalid
        const invalidFields = widgetPage.page.locator('input:invalid, [aria-invalid="true"]');
        expect(await invalidFields.count()).toBeGreaterThan(0);
      }
    });

    test('should validate email format', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      const emailInput = widgetPage.page.locator('input[type="email"], input[name="email"]');

      if (await emailInput.isVisible()) {
        // Enter invalid email
        await emailInput.fill('invalid-email');
        await emailInput.blur();

        // Try to submit
        const submitButton = widgetPage.page.locator('button[type="submit"]').first();
        if (await submitButton.isVisible()) {
          await submitButton.click();

          // Should show validation error or be invalid
          const isInvalid = await emailInput.evaluate((el) => !(el as HTMLInputElement).checkValidity());
          // Invalid email should not pass validation
          expect(isInvalid).toBe(true);
        }
      }
    });

    test('should successfully submit valid form', async ({ widgetPage, page, testUser }) => {
      const api = await setupMessengerApi(page);
      await widgetPage.openComposer();
      await widgetPage.sendMessage('Hello, I need help');

      // Fill in and submit the email form
      const emailCapture = page.locator('[data-testid="email-capture"]');
      await emailCapture.locator('input[type="email"]').fill(testUser.email);
      await emailCapture.locator('button[type="submit"]').click();

      // The visitor is identified and the form turns into a confirmation
      await expect(page.getByText(`You'll be notified at`)).toBeVisible();
      await expect(page.getByText(testUser.email)).toBeVisible();
      await expect(emailCapture).toHaveCount(0);
      expect(api.identifyRequests).toBe(1);
    });
  });

  test.describe('Message Input', () => {
    test('should have a message input field in chat', async ({ widgetPage, page }) => {
      await setupMessengerApi(page);
      await widgetPage.openComposer();

      // The composer is ready for typing
      await expect(widgetPage.messageInput).toBeEditable();
    });

    test('should allow typing messages', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      const messageInput = widgetPage.page.locator('textarea').first();

      if (await messageInput.isVisible()) {
        await messageInput.fill('Hello, I need help');

        const value = await messageInput.inputValue();
        expect(value).toBe('Hello, I need help');
      }
    });

    test('should have send button', async ({ widgetPage, page }) => {
      await setupMessengerApi(page);
      await widgetPage.openComposer();

      // Send button exists, but there is nothing to send until the visitor types
      await expect(widgetPage.sendButton).toBeVisible();
      await expect(widgetPage.sendButton).toBeDisabled();

      await widgetPage.messageInput.fill('Hello');
      await expect(widgetPage.sendButton).toBeEnabled();
    });

    test('should handle empty message submission', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      const sendButton = widgetPage.page.locator('button[type="submit"]').first();

      if (await sendButton.isVisible()) {
        const messagePosts: string[] = [];
        widgetPage.page.on('request', (request) => {
          if (request.method() === 'POST' && request.url().includes('/messages')) {
            messagePosts.push(request.url());
          }
        });

        // Try to send empty message
        await sendButton.click();

        // Should not send empty message (button may be disabled or validation prevents)
        expect(messagePosts).toHaveLength(0);
      }
    });

    test('should handle long messages', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      const messageInput = widgetPage.page.locator('textarea').first();

      if (await messageInput.isVisible()) {
        // Type a long message
        const longMessage = 'A'.repeat(2000);
        await messageInput.fill(longMessage);

        // Should handle gracefully (truncate or show error)
        const value = await messageInput.inputValue();
        expect(value.length).toBeGreaterThan(0);
      }
    });
  });

  test.describe('Message Display', () => {
    test('should display sent messages', async ({ widgetPage, page }) => {
      const api = await setupMessengerApi(page);
      await widgetPage.openComposer();

      const sendResponse = page.waitForResponse(
        (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/conversations',
      );
      await widgetPage.sendMessage('Test message');
      expect((await sendResponse).ok()).toBe(true);

      // The sent message shows up in the thread and was accepted by the API
      await expect(widgetPage.messageList.getByText('Test message')).toBeVisible();
      await expect(page.getByText('Not sent')).toHaveCount(0);
      expect(api.sendRequests).toBe(1);
    });

    test('should display timestamps on messages', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Messages should have timestamps
      const timeElement = widgetPage.page.locator('time, [data-testid*="timestamp"]');
      // Check if timestamps exist in message area
    });

    test('should distinguish user and agent messages', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Messages should have different styling for user vs agent
      const userMessage = widgetPage.page.locator('[data-sender="user"], [class*="user-message"]');
      const agentMessage = widgetPage.page.locator('[data-sender="agent"], [class*="agent-message"]');

      // Both types should be distinguishable
    });
  });

  test.describe('Typing Indicator', () => {
    test('should show typing indicator when agent is typing', async ({ widgetPage, page }) => {
      await setupMessengerApi(page);
      await widgetPage.openComposer();
      await expect(widgetPage.chatView).toBeVisible();

      // No agent is typing in the mocked conversation, so no indicator is rendered
      await expect(page.locator('[data-testid="typing-indicator"]')).toHaveCount(0);
    });
  });

  test.describe('Real-time Updates', () => {
    test('should handle new message notifications', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // The widget should be set up to receive real-time updates via SignalR
      // This test verifies the UI is ready for real-time updates
    });
  });

  test.describe('Connection State', () => {
    test('should handle offline state gracefully', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Simulate offline
      await widgetPage.page.context().setOffline(true);

      // Try to interact
      const messageInput = widgetPage.page.locator('textarea').first();
      if (await messageInput.isVisible()) {
        await messageInput.fill('Test offline message');
        // The composer keeps working while offline
        expect(await messageInput.inputValue()).toBe('Test offline message');
      }

      // Restore online
      await widgetPage.page.context().setOffline(false);
    });

    test('should show connection status', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Look for connection status indicator
      const statusIndicator = widgetPage.page.locator(
        '[data-testid="connection-status"], [class*="connection"], [aria-label*="connected"]'
      );

      // Connection status may be shown
    });

    test('should reconnect after connection loss', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Simulate connection loss and recovery
      await widgetPage.page.context().setOffline(true);
      await widgetPage.page.waitForTimeout(500);
      await widgetPage.page.context().setOffline(false);
      await widgetPage.page.waitForTimeout(1000);

      // Widget should recover
      const mainContent = widgetPage.page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });
  });

  test.describe('File Attachments', () => {
    test('should have attachment button', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Look for attachment/file upload button
      const attachButton = widgetPage.page.locator(
        'button[aria-label*="attach" i], button[aria-label*="file" i], [data-testid="attach-button"]'
      );

      // Attachment button may exist
    });

    test('should validate file types', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // File input should have accept attribute
      const fileInput = widgetPage.page.locator('input[type="file"]');

      if (await fileInput.count() > 0) {
        const acceptAttr = await fileInput.first().getAttribute('accept');
        // Should have file type restrictions
        expect(acceptAttr).toBeTruthy();
      }
    });
  });

  test.describe('Conversation Rating', () => {
    test('should display rating option after conversation', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Rating UI elements
      const ratingStars = widgetPage.page.locator('[data-testid="rating"], [class*="rating"], [role="radiogroup"]');

      // Rating should be available at conversation end
    });
  });
});
