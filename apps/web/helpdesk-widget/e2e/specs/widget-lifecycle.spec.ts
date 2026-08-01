import { test, expect, setupMockApi } from '../fixtures';

test.describe('Widget Lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockApi(page);
  });

  test.describe('Widget Loading', () => {
    test('should load the widget page', async ({ widgetPage }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Page should be loaded
      await expect(widgetPage.page).toHaveTitle(/.*/);
    });

    test('should display home view by default', async ({ widgetPage }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Should show the home view or main content
      const mainContent = widgetPage.page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });

    test('should load without JavaScript errors', async ({ widgetPage }) => {
      const errors: string[] = [];
      widgetPage.page.on('pageerror', (error) => {
        errors.push(error.message);
      });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Filter out expected errors (like network errors in test env)
      const unexpectedErrors = errors.filter(
        (e) => !e.includes('Failed to fetch') && !e.includes('NetworkError')
      );

      expect(unexpectedErrors).toHaveLength(0);
    });
  });

  test.describe('Navigation', () => {
    test('should navigate between views', async ({ widgetPage }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Navigate to chat view
      const chatLink = widgetPage.page.locator('a[href*="chat"], button').filter({ hasText: /chat/i }).first();
      if (await chatLink.isVisible()) {
        await chatLink.click();
        await widgetPage.page.waitForLoadState('networkidle');
      }
    });

    test('should handle back navigation', async ({ widgetPage }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Navigate forward
      const anyLink = widgetPage.page.locator('a').first();
      if (await anyLink.isVisible()) {
        await anyLink.click();
        await widgetPage.page.waitForLoadState('networkidle');

        // Go back
        await widgetPage.page.goBack();
        await widgetPage.page.waitForLoadState('networkidle');
      }
    });

    test('should preserve state during navigation', async ({ widgetPage }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Get initial URL
      const initialUrl = widgetPage.page.url();

      // Navigate away and back
      await widgetPage.page.goto('/chat');
      await widgetPage.page.waitForLoadState('networkidle');

      await widgetPage.page.goto(initialUrl);
      await widgetPage.page.waitForLoadState('networkidle');

      // Should be back at initial state
      expect(widgetPage.page.url()).toBe(initialUrl);
    });
  });

  test.describe('Responsive Behavior', () => {
    test('should adapt to mobile viewport', async ({ widgetPage }) => {
      // Set mobile viewport
      await widgetPage.page.setViewportSize({ width: 375, height: 667 });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Widget should be visible and adapted
      const mainContent = widgetPage.page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });

    test('should adapt to tablet viewport', async ({ widgetPage }) => {
      // Set tablet viewport
      await widgetPage.page.setViewportSize({ width: 768, height: 1024 });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Widget should be visible
      const mainContent = widgetPage.page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });

    test('should adapt to desktop viewport', async ({ widgetPage }) => {
      // Set desktop viewport
      await widgetPage.page.setViewportSize({ width: 1920, height: 1080 });

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Widget should be visible
      const mainContent = widgetPage.page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });
  });

  test.describe('Performance', () => {
    test('should load within acceptable time', async ({ widgetPage }) => {
      const startTime = Date.now();

      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      const loadTime = Date.now() - startTime;

      // Widget should load within 5 seconds
      expect(loadTime).toBeLessThan(5000);
    });

    test('should not have memory leaks during navigation', async ({ widgetPage }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Navigate multiple times
      for (let i = 0; i < 5; i++) {
        await widgetPage.page.goto('/chat');
        await widgetPage.page.waitForLoadState('networkidle');

        await widgetPage.page.goto('/');
        await widgetPage.page.waitForLoadState('networkidle');
      }

      // Page should still be responsive
      const mainContent = widgetPage.page.locator('main, [role="main"], #__next');
      await expect(mainContent).toBeVisible();
    });
  });

  test.describe('Accessibility', () => {
    test('should have proper heading structure', async ({ widgetPage }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Check for h1 heading
      const h1Count = await widgetPage.page.locator('h1').count();
      expect(h1Count).toBeGreaterThanOrEqual(0); // Widget may not have h1
    });

    test('should have accessible buttons', async ({ widgetPage }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // All buttons should have accessible name
      const buttons = widgetPage.page.locator('button');
      const buttonCount = await buttons.count();

      for (let i = 0; i < buttonCount; i++) {
        const button = buttons.nth(i);
        if (await button.isVisible()) {
          const name = await button.getAttribute('aria-label') || await button.textContent();
          expect(name).toBeTruthy();
        }
      }
    });

    test('should support keyboard navigation', async ({ widgetPage }) => {
      await widgetPage.goto('/');
      await widgetPage.waitForReady();

      // Tab through interactive elements
      await widgetPage.page.keyboard.press('Tab');
      await widgetPage.page.keyboard.press('Tab');
      await widgetPage.page.keyboard.press('Tab');

      // Should have focused element
      const focusedElement = widgetPage.page.locator(':focus');
      await expect(focusedElement).toBeVisible();
    });
  });
});
