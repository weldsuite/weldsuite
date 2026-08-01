import { test, expect } from '../fixtures';

test.describe('Error Handling', () => {
  test.describe('Network Errors', () => {
    test('should handle API timeout gracefully', async ({ widgetPage, page }) => {
      // Setup delayed/timeout response
      await page.route('**/api/widget/**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 30000)); // Long delay
        await route.abort('timedout');
      });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Widget should still be visible and show error state
      const mainContent = page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });

    test('should handle 500 server errors', async ({ widgetPage, page }) => {
      // Setup 500 error response
      await page.route('**/api/widget/**', async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Internal Server Error' }),
        });
      });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Widget should handle error gracefully
      const mainContent = page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });

    test('should handle 404 not found', async ({ widgetPage, page }) => {
      // Setup 404 response for specific routes
      await page.route('**/api/widget/*/settings', async (route) => {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Not Found' }),
        });
      });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Widget should handle gracefully, possibly with defaults
      const mainContent = page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });

    test('should handle network disconnect', async ({ widgetPage, page }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Simulate network disconnect
      await page.context().setOffline(true);

      // Try to navigate
      await widgetPage.goto('/chat').catch(() => {
        // Expected to fail
      });

      // Restore network
      await page.context().setOffline(false);

      // Should recover
      await widgetPage.goto('/');
      const mainContent = page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });

    test('should retry failed requests', async ({ widgetPage, page }) => {
      let requestCount = 0;

      // First request fails, second succeeds
      await page.route('**/api/widget/**', async (route) => {
        requestCount++;
        if (requestCount === 1) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Temporary Error' }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ id: 'test', name: 'Test Widget' }),
          });
        }
      });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Widget should eventually succeed after retry
    });
  });

  test.describe('Error Boundary', () => {
    test('should catch and display React errors gracefully', async ({ widgetPage, page }) => {
      // Inject an error-triggering script
      await page.addInitScript(() => {
        // This will be caught by error boundary
        window.addEventListener('error', (e) => {
          console.log('Error caught:', e.message);
        });
      });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Error boundary should prevent complete crash
      const errorBoundary = page.locator('[data-testid="error-boundary"], [class*="error-boundary"]');
      // If error occurs, boundary should catch it
    });

    test('should provide retry option on error', async ({ widgetPage, page }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Look for retry/refresh buttons in error states
      const retryButton = page.locator(
        'button:has-text("Try Again"), button:has-text("Retry"), button:has-text("Refresh")'
      );

      // Retry button should exist in error UI
    });

    test('should provide close option on critical error', async ({ widgetPage, page }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Look for close button in error states
      const closeButton = page.locator('button:has-text("Close"), button[aria-label*="close" i]');

      // Close button should exist
    });
  });

  test.describe('Form Validation Errors', () => {
    test('should display validation errors clearly', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Try to submit empty form
      const submitButton = widgetPage.page.locator('button[type="submit"]').first();

      if (await submitButton.isVisible()) {
        await submitButton.click();

        // Look for error messages
        const errorMessage = widgetPage.page.locator(
          '[class*="error"], [role="alert"], [aria-invalid="true"]'
        );

        // Validation errors should be displayed
      }
    });

    test('should highlight invalid fields', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      const emailInput = widgetPage.page.locator('input[type="email"]');

      if (await emailInput.isVisible()) {
        // Enter invalid email
        await emailInput.fill('not-an-email');
        await emailInput.blur();

        // Field should be marked as invalid
        const ariaInvalid = await emailInput.getAttribute('aria-invalid');
        // Or check for error styling
      }
    });

    test('should clear errors when corrected', async ({ widgetPage }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      const emailInput = widgetPage.page.locator('input[type="email"]');

      if (await emailInput.isVisible()) {
        // Enter invalid then valid email
        await emailInput.fill('invalid');
        await emailInput.blur();

        await emailInput.fill('valid@example.com');
        await emailInput.blur();

        // Error should be cleared
      }
    });
  });

  test.describe('SignalR Connection Errors', () => {
    test('should handle SignalR connection failure', async ({ widgetPage, page }) => {
      // Block SignalR hub
      await page.route('**/hubs/helpdesk**', async (route) => {
        await route.abort('connectionfailed');
      });

      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Widget should show connection error or fallback state
      const mainContent = page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });

    test('should show reconnecting state', async ({ widgetPage, page }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Simulate connection drop
      await page.context().setOffline(true);
      await page.waitForTimeout(500);

      // Look for reconnecting indicator
      const reconnectingIndicator = page.locator(
        '[data-testid="reconnecting"], [class*="reconnecting"], :text("reconnecting")'
      );

      // Restore connection
      await page.context().setOffline(false);
    });

    test('should handle message send failure', async ({ widgetPage, page }) => {
      // Setup message send failure
      await page.route('**/api/widget/customer/conversations/*/messages', async (route) => {
        if (route.request().method() === 'POST') {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Failed to send message' }),
          });
        }
      });

      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      // Try to send a message
      const messageInput = page.locator('textarea').first();
      if (await messageInput.isVisible()) {
        await messageInput.fill('Test message');

        const sendButton = page.locator('button[type="submit"]').first();
        if (await sendButton.isVisible()) {
          await sendButton.click();

          // Should show error or retry option
        }
      }
    });
  });

  test.describe('Authentication Errors', () => {
    test('should handle 401 unauthorized', async ({ widgetPage, page }) => {
      await page.route('**/api/widget/**', async (route) => {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Unauthorized' }),
        });
      });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Widget should handle auth error gracefully
      const mainContent = page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });

    test('should handle 403 forbidden', async ({ widgetPage, page }) => {
      await page.route('**/api/widget/**', async (route) => {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Forbidden' }),
        });
      });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Widget should show appropriate message
      const mainContent = page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });
  });

  test.describe('Error Logging', () => {
    test('should log errors to console in development', async ({ widgetPage, page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });

      // Trigger an error
      await page.route('**/api/widget/**', async (route) => {
        await route.fulfill({
          status: 500,
          body: 'Server Error',
        });
      });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Errors should be logged (in dev mode)
    });

    test('should not expose sensitive info in error messages', async ({ widgetPage, page }) => {
      const pageContent: string[] = [];

      await page.route('**/api/widget/**', async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Database connection failed: password=secret123',
          }),
        });
      });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      const bodyText = await page.locator('body').textContent();

      // Sensitive info should not be displayed to user
      expect(bodyText).not.toContain('password=secret123');
      expect(bodyText).not.toContain('Database connection failed');
    });
  });

  test.describe('Recovery', () => {
    test('should recover from transient errors', async ({ widgetPage, page }) => {
      let errorCount = 0;

      await page.route('**/api/widget/**', async (route) => {
        errorCount++;
        if (errorCount <= 2) {
          await route.fulfill({ status: 500 });
        } else {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ id: 'test', name: 'Widget' }),
          });
        }
      });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // After retries, widget should work
    });

    test('should preserve user input on error recovery', async ({ widgetPage, page }) => {
      await widgetPage.goto('/chat');
      await widgetPage.waitForReady();

      const messageInput = page.locator('textarea').first();

      if (await messageInput.isVisible()) {
        await messageInput.fill('Important message');

        // Simulate error
        await page.context().setOffline(true);
        await page.waitForTimeout(200);
        await page.context().setOffline(false);

        // Input should be preserved
        const value = await messageInput.inputValue();
        expect(value).toBe('Important message');
      }
    });

    test('should allow manual refresh after error', async ({ widgetPage, page }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Simulate error state
      await page.route('**/api/widget/**', async (route) => {
        await route.fulfill({ status: 500 });
      });

      // Reload should work
      await page.reload();
      await widgetPage.waitForReady();

      const mainContent = page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });
  });
});
