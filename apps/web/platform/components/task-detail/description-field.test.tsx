import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

// Heavy siblings of DescriptionField in task-detail-content.tsx; none of them
// take part in rendering a description, so stub them out.
vi.mock('@/hooks/queries/use-github-queries', () => ({ useLinkedRepos: () => ({ data: [] }) }));
vi.mock('@/hooks/queries/use-weldchat-queries', () => ({ useWorkspaceMembers: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-file-upload', () => ({ useFileUpload: () => ({}) }));
vi.mock('@/hooks/use-drawer-field-visibility', () => ({ useDrawerFieldVisibility: () => ({}) }));
vi.mock('@/components/entity-audit-panel', () => ({ EntityAuditPanel: () => null }));
vi.mock('@/app/weldchat/components/emoji-picker', () => ({ EmojiPicker: () => null }));
vi.mock('@/app/weldchat/components/mention-autocomplete', () => ({ MentionAutocomplete: () => null }));
vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (path: string) => path,
}));

import { DescriptionField } from './task-detail-content';

const PAYLOAD = '<p>Release notes</p><img src="x" onerror="alert(1)"><script>alert(2)</script>';

describe('DescriptionField', () => {
  it('renders a stored HTML description without its script or event handlers', () => {
    const { container } = render(<DescriptionField taskId="task_1" description={PAYLOAD} onUpdate={vi.fn()} />);

    expect(container.textContent).toContain('Release notes');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
  });

  it('loads the sanitized description into the editor as well', () => {
    const { container } = render(<DescriptionField taskId="task_1" description={PAYLOAD} onUpdate={vi.fn()} />);

    fireEvent.click(container.firstElementChild as HTMLElement);

    const editor = container.querySelector('[contenteditable]');
    expect(editor?.textContent).toContain('Release notes');
    expect(editor?.querySelector('script')).toBeNull();
    expect(editor?.querySelector('[onerror]')).toBeNull();
  });
});
