/**
 * Page object for the shared <EntityGrid /> wrapper. Backs most
 * module list pages (companies, people, products, orders, …) so one
 * stable selector handles them all.
 */

import { expect, type Page } from '@playwright/test';

export class EntityGridPage {
  constructor(private readonly page: Page) {}

  root() {
    return this.page.getByTestId('entity-grid');
  }

  createButton() {
    return this.page.getByTestId('entity-grid-create-btn');
  }

  searchInput() {
    return this.page.getByTestId('entity-grid-search');
  }

  /** Body rows — stamped with `data-testid="entity-grid-row"`. Does NOT
   *  include the table header. */
  rows() {
    return this.page.getByTestId('entity-grid-row');
  }

  /** Look up a specific row by the entity id baked into `data-entity-id`. */
  rowById(entityId: string) {
    return this.page.locator(`[data-testid="entity-grid-row"][data-entity-id="${entityId}"]`);
  }

  /**
   * The favorite (star) toggle inside a given row's name cell. Only the
   * grids whose name column declares a `favoriteField` render it. The
   * button exposes its state via `aria-pressed`, so assert with
   * `toHaveAttribute('aria-pressed', 'true' | 'false')`.
   */
  favoriteToggle(entityId: string) {
    return this.rowById(entityId).getByTestId('entity-grid-favorite');
  }

  async waitForReady() {
    await expect(this.root()).toBeVisible({ timeout: 15_000 });
  }

  /**
   * Search for `term` and wait for the URL to reflect it so we know the
   * debounced request fired.
   */
  async search(term: string) {
    await this.searchInput().fill(term);
    await this.page.waitForURL(new RegExp(`search=${encodeURIComponent(term)}`), {
      timeout: 5_000,
    });
  }
}
