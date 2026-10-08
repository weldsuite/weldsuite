/**
 * Component tests for useLeaveCallGuard.
 *
 * In a call, a reload asks the browser to confirm; cancelling keeps the page
 * and must not have sent the leave request. The leave request only goes out
 * once the page really unloads.
 */

import { test, expect } from '@playwright/experimental-ct-react';
import { LeaveCallGuardHarness } from './harness/leave-call-guard-harness';

test.describe('useLeaveCallGuard', () => {
  test('in a call, a reload asks first and leaves only once accepted', async ({ mount, page }) => {
    await mount(<LeaveCallGuardHarness warn />);
    // Chromium only prompts on pages the user has interacted with.
    await page.getByRole('button', { name: 'in call' }).click();

    const dismissed = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.type()).toBe('beforeunload');
      await dialog.dismiss();
    });
    await page.evaluate(() => { location.reload(); });
    await dismissed;

    await expect(page.getByRole('button', { name: 'in call' })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('left-call'))).toBeNull();

    page.once('dialog', (dialog) => { void dialog.accept(); });
    await page.reload();
    expect(await page.evaluate(() => sessionStorage.getItem('left-call'))).toBe('yes');
  });

  test('outside a call, a reload goes through without a prompt but still leaves', async ({ mount, page }) => {
    await mount(<LeaveCallGuardHarness warn={false} />);
    await page.getByRole('button', { name: 'in call' }).click();

    let prompted = false;
    page.on('dialog', (dialog) => { prompted = true; void dialog.accept(); });
    await page.reload();

    expect(prompted).toBe(false);
    expect(await page.evaluate(() => sessionStorage.getItem('left-call'))).toBe('yes');
  });
});
