/**
 * A WeldFlow project's whiteboard is a WeldBoard board (docs/plans/weldboard.md):
 * the project's Whiteboards tab creates one through board-api and opens it in
 * the WeldBoard editor, inside the project.
 *
 * Selectors: the "New Whiteboard" button and dialog of the list, and the board
 * canvas's input, labelled "Board" (weldboard.editor.canvas).
 *
 * Cleanup is scoped to the seeded project (its boards go with it), not the
 * global marker wipe, so parallel specs keep their rows.
 */

import { test, expect } from '../../fixtures';
import { isTestFixturesConfigured, type SeedEntityType } from '../../helpers/test-fixtures-client';

test.describe('WeldFlow · project whiteboard', () => {
  let seeded: { type: SeedEntityType; id: string } | null = null;

  test.beforeAll(() => {
    // Skipped: seeds and cleans up through app-api /test-fixtures (TEST_API_URL, TEST_FIXTURES_TOKEN, TEST_WORKSPACE_ID).
    test.skip(!isTestFixturesConfigured(), 'test-fixtures env vars not set');
  });

  test.afterEach(async ({ api }) => {
    if (seeded) {
      await api.deleteEntity(seeded.type, seeded.id);
      seeded = null;
    }
  });

  test('creates a whiteboard in the project and opens it in the board editor', async ({ page, api }) => {
    const stamp = Date.now().toString(36);
    const project = await api.seedProject({ name: `E2E Board ${stamp}` });
    seeded = { type: 'project', id: project.id };

    await page.goto(`/weldflow/project/${project.id}/whiteboard`);
    await expect(page.getByTestId('app-sidebar')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /new whiteboard/i }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill(`Retro ${stamp}`);
    await dialog.getByRole('button', { name: /^create$/i }).click();

    await expect(page).toHaveURL(new RegExp(`/weldflow/project/${project.id}/whiteboard/[^/?#]+`), { timeout: 15_000 });
    // The board's room has opened: the canvas takes keyboard input.
    await expect(page.getByRole('textbox', { name: 'Board' })).toBeAttached({ timeout: 20_000 });

    // Back on the list, the new board is there.
    await page.goto(`/weldflow/project/${project.id}/whiteboard`);
    await expect(page.getByText(`Retro ${stamp}`)).toBeVisible({ timeout: 15_000 });
  });
});
