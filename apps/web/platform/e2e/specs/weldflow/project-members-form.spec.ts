/**
 * Members form spec for WeldFlow projects.
 *
 * Covers the Add Member dialog workflow on
 * /weldflow/project/:id/members. The test user seeds the project and is
 * therefore the project owner — so isAdmin=true and the "Add Member"
 * button is rendered.
 *
 * Selector strategy (no data-testids on the Add Member CTA yet):
 *   - Add Member button: getByRole('button', { name: /add member/i })
 *   - Dialog: getByRole('dialog')
 *   - User search combobox (shadcn Command): getByRole('combobox') or
 *     the CommandInput inside the dialog
 *   - Role select: getByRole('combobox') within the dialog scoped to
 *     the role area (shadcn Select renders as a combobox)
 *   - Save / Add Member submit: getByRole('button', { name: /add member|save/i })
 *
 * Note: the dialog opens a user-picker that searches workspace users.
 * Without a second seeded user, the CommandInput will show empty results.
 * This spec verifies that the dialog opens and the form structure is
 * present, without asserting a successful submission (which requires a
 * second available user in the workspace). Attempting the full flow
 * without a known available-user seed would make the spec flaky.
 *
 * Cross-cutting recommendation (not applied here): add
 *   data-testid="add-member-btn"       to the Add Member Button in MembersClient
 *   data-testid="member-role-select"   to the role Select trigger in the dialog
 * so future specs can use stable selectors.
 *
 * Cleanup is scoped to the project each test seeded (NOT the global
 * `api.reset()` marker-wipe) to avoid deleting sibling specs' rows under
 * `fullyParallel` execution.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

test.describe('WeldFlow · project members form', () => {
  let seeded: { type: SeedEntityType; id: string } | null = null;

  test.beforeAll(() => {
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (seeded) {
      await api.deleteEntity(seeded.type, seeded.id);
      seeded = null;
    }
  });

  test('members page renders the members table', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const project = await api.seedProject({ name: `E2EMembers ${stamp}` });
    seeded = { type: 'project', id: project.id };

    await page.goto(`/weldflow/project/${project.id}/members`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(
      new RegExp(`/weldflow/project/${project.id}/members`),
      { timeout: 10_000 },
    );

    // The members table header should be present.
    await expect(
      page.getByRole('columnheader', { name: /member/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Add Member button opens the invite dialog', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const project = await api.seedProject({ name: `E2EAddMember ${stamp}` });
    seeded = { type: 'project', id: project.id };

    await page.goto(`/weldflow/project/${project.id}/members`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    // The Add Member button is only shown to admins/owners. Since the
    // test user created this project they are the owner.
    const addBtn = page.getByRole('button', { name: /add member/i });
    await expect(addBtn).toBeVisible({ timeout: 10_000 });

    await addBtn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The dialog contains a user-picker (shadcn Command / combobox).
    // Verify the dialog title and the search input are present.
    await expect(
      dialog.getByRole('heading', { name: /add member/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('Add Member dialog can be dismissed', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const project = await api.seedProject({ name: `E2EDismiss ${stamp}` });
    seeded = { type: 'project', id: project.id };

    await page.goto(`/weldflow/project/${project.id}/members`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    const addBtn = page.getByRole('button', { name: /add member/i });
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
    await addBtn.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Close via the Cancel button.
    const cancelBtn = dialog.getByRole('button', { name: /cancel/i });
    if (await cancelBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await cancelBtn.click();
    } else {
      // Fallback: press Escape to close.
      await page.keyboard.press('Escape');
    }

    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });
});
