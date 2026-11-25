import { describe, expect, it } from 'vitest';
import { isFullScreenWorkspacePath } from './full-screen-paths';

describe('isFullScreenWorkspacePath', () => {
  it('is true for the online store editor, with or without the workspace prefix', () => {
    expect(isFullScreenWorkspacePath('/weldcommerce/online-store/sfs_1/editor')).toBe(true);
    expect(isFullScreenWorkspacePath('/w/acme/weldcommerce/online-store/sfs_1/editor')).toBe(true);
  });

  it('is false for the other online store pages and the rest of the app', () => {
    expect(isFullScreenWorkspacePath('/weldcommerce/online-store')).toBe(false);
    expect(isFullScreenWorkspacePath('/weldcommerce/online-store/sfs_1/pages')).toBe(false);
    expect(isFullScreenWorkspacePath('/weldcommerce/online-store/sfs_1/editor/extra')).toBe(false);
    expect(isFullScreenWorkspacePath('/weldcommerce')).toBe(false);
  });
});
