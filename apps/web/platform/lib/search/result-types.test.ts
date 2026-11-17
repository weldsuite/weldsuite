import { describe, expect, it } from 'vitest';
import { RESULT_TYPE_ICON, RESULT_TYPE_LABEL } from './result-types';

describe('palette result types', () => {
  it('labels and draws WeldMerge issues and pull requests', () => {
    expect(RESULT_TYPE_LABEL.merge_issue).toBe('Issues');
    expect(RESULT_TYPE_LABEL.merge_pull_request).toBe('Pull requests');
    expect(RESULT_TYPE_ICON.merge_issue).toBeTruthy();
    expect(RESULT_TYPE_ICON.merge_pull_request).toBeTruthy();
  });

  it('labels WeldKnow pages instead of showing the raw type key', () => {
    expect(RESULT_TYPE_LABEL.knowledge_page).toBe('Pages');
    expect(RESULT_TYPE_ICON.knowledge_page).toBeTruthy();
  });

  it('has an icon for every label', () => {
    expect(Object.keys(RESULT_TYPE_ICON).sort()).toEqual(Object.keys(RESULT_TYPE_LABEL).sort());
  });
});
