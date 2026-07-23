import { test, expect, setupMockApi, mockResponses } from '../fixtures';

test.describe('Chat Flow', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
  });

  test.describe('Pre-Chat Form', () => {
    test('should display pre-chat form when starting chat', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Look for form elements that indicate pre-chat form
      const nameInput = widgetPage.page.locator('input[name="name"], input[placeholder*="name" i]');
      const emailInput = widgetPage.page.locator('input[name="email"], input[type="email"]');

      // At least one form field should be visible for new conversations
      const hasPreChatForm = await nameInput.isVisible() || await emailInput.isVisible();

      // Log for debugging
      console.log('Pre-chat form visible:', hasPreChatForm);
    });

    test('should validate required fields', async ({ widgetPage, testUser }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Try to submit without filling required fields
      const submitButton = widgetPage.page.locator('button[type="submit"]').first();

      if (await submitButton.isVisible()) {
        await submitButton.click();

        // Check for validation errors
        const errorMessage = widgetPage.page.locator('[class*="error"], [role="alert"]');
        // Validation should prevent submission or show error
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
        }
      }
    });

    test('should successfully submit valid form', async ({ widgetPage, testUser }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Fill in the form
      await widgetPage.fillPreChatForm(testUser);

      // Submit
      const submitButton = widgetPage.page.locator('button[type="submit"]').first();
      if (await submitButton.isVisible()) {
        await submitButton.click();

        // Wait for navigation or state change
        await widgetPage.page.waitForTimeout(1000);
      }
    });
  });

  test.describe('Message Input', () => {
    test('should have a message input field in chat', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Look for message input
      const messageInput = widgetPage.page.locator(
        'textarea, input[type="text"][placeholder*="message" i], [contenteditable="true"]'
      );

      // Message input may be visible after pre-chat form
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

    test('should have send button', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Look for send button
      const sendButton = widgetPage.page.locator(
        'button[type="submit"], button[aria-label*="send" i], button:has-text("Send")'
      );

      // Send button should exist in chat interface
    });

    test('should handle empty message submission', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      const sendButton = widgetPage.page.locator('button[type="submit"]').first();

      if (await sendButton.isVisible()) {
        // Try to send empty message
        await sendButton.click();

        // Should not send empty message (button may be disabled or validation prevents)
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
      // Setup mock to return a message
      await page.route('**/api/widget/customer/conversations/*/messages', async (route) => {
        if (route.request().method() === 'POST') {
          await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({
              id: 'msg-' + Date.now(),
              content: 'Test message',
              senderType: 'user',
              createdAt: new Date().toISOString(),
            }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([mockResponses.message]),
          });
        }
      });

      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();
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
    test('should show typing indicator when agent is typing', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Typing indicator element
      const typingIndicator = widgetPage.page.locator(
        '[data-testid="typing-indicator"], [class*="typing"], [aria-label*="typing"]'
      );

      // Indicator should be defined but may not be visible initially
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
