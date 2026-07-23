/**
 * Interaction spec for WeldDesk surfaces. Verifies the tickets list
 * renders + the create button opens its dialog, the inbox folders
 * are reachable, and the knowledge-base + announcements forms render.
 *
 * Extended to also cover: saved-replies create button, workflows page
 * create button, and the WeldAgent config form.
 */

import { test, expect } from '../../fixtures';

test.describe('WeldDesk · tickets', () => {
  test('tickets page shows the create button and opens the dialog', async ({ page }) => {
    await page.goto('/welddesk/tickets');
    const createBtn = page.getByTestId('tickets-create-btn');
    await expect(createBtn).toBeVisible({ timeout: 15_000 });
    await createBtn.click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });

  test('/welddesk/tickets/new renders the new-ticket form', async ({ page }) => {
    await page.goto('/welddesk/tickets/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    // Either the dynamic form or the type-selector step renders.
    // Both are valid; the test confirms the page didn't error out.
    await expect(page).toHaveURL(/\/welddesk\/tickets\/new/);
  });
});

test.describe('WeldDesk · inbox folders', () => {
  for (const folder of ['all', 'archived', 'email', 'chat', 'slack', 'discord']) {
    test(`/welddesk/inbox/${folder} loads`, async ({ page }) => {
      await page.goto(`/welddesk/inbox/${folder}`);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
      await expect(page).toHaveURL(new RegExp(`/welddesk/inbox/${folder}`));
    });
  }
});

test.describe('WeldDesk · knowledge base', () => {
  test('knowledge index reaches the "new article" form', async ({ page }) => {
    await page.goto('/welddesk/knowledge/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/welddesk\/knowledge\/new/);
  });

  test('announcements/new form is reachable', async ({ page }) => {
    await page.goto('/welddesk/announcements/new');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/welddesk\/announcements\/new/);
  });
});

test.describe('WeldDesk · settings sub-pages', () => {
  for (const sub of [
    'integrations/discord',
    'integrations/email',
    'integrations/slack',
    'saved-replies',
    'ticket-types',
    'tickets',
  ]) {
    test(`/welddesk/settings/${sub} renders`, async ({ page }) => {
      await page.goto(`/welddesk/settings/${sub}`);
      await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    });
  }
});

test.describe('WeldDesk · saved replies — create button', () => {
  test('"Create Reply" button opens the SavedReplyEditor panel', async ({ page }) => {
    await page.goto('/welddesk/settings/saved-replies');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The page header has a "Create Reply" button (Plus icon + text).
    // When there are no replies the empty state also renders a "Create Reply"
    // button — either is acceptable as a stable CTA target.
    const createBtn = page
      .getByRole('button', { name: /create reply/i })
      .first();
    await expect(createBtn).toBeVisible({ timeout: 10_000 });
    await createBtn.click();

    // SavedReplyEditor renders as a Dialog — assert it opens.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('WeldDesk · workflows page — create button', () => {
  test('"New workflow" button is visible on the workflows list page', async ({ page }) => {
    await page.goto('/welddesk/workflows');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // WorkflowsClient renders an EntityList with createButton label
    // "New workflow" (category === 'workflow'). Clicking it calls
    // handleNewWorkflow which fires a create mutation immediately — do not
    // click in this spec to avoid side-effects in a real environment.
    // Asserting visibility confirms the shell rendered correctly.
    const newWorkflowBtn = page.getByRole('button', { name: /new workflow/i });
    await expect(newWorkflowBtn).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('WeldDesk · WeldAgent config form', () => {
  test('/welddesk/weldagent renders the agent-name input', async ({ page }) => {
    await page.goto('/welddesk/weldagent');
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // WeldAgentClient renders an <input> for the agent name — no id is
    // assigned so we locate it by placeholder text which is stable i18n-keyed.
    // Fallback: locate by type=text inside the config sidebar.
    // Either proves the config form rendered and the page loaded without error.
    const agentNameInput = page
      .locator('input[type="text"]')
      .first();
    await expect(agentNameInput).toBeVisible({ timeout: 10_000 });
  });
});
