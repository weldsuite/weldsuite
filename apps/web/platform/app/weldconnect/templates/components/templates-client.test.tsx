import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { WorkflowTemplateItem } from '@weldsuite/app-api-client/schemas/weldconnect-templates';

const push = vi.fn();
const useMutate = vi.fn();
let canDelete = true;

vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en, language: 'en' }) }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => {} }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({
    canAny: (...keys: string[]) => keys.some((key) => key.endsWith(':update') || (canDelete && key.endsWith(':delete'))),
  }),
}));
vi.mock('./template-preview', () => ({ TemplatePreview: () => <div>canvas preview</div> }));

const builtIn: WorkflowTemplateItem = {
  id: 'builtin_deal_won',
  source: 'builtin',
  name: 'Celebrate won deals',
  description: 'Announce won deals in WeldChat.',
  category: 'sales',
  icon: 'Trophy',
  triggers: [{ id: 'trigger_main', type: 'entity_event', entityType: 'opportunity', eventType: 'won' }],
  steps: [
    { id: 'step_announce', type: 'post_chat_message', name: 'Announce in WeldChat', config: {}, order: 0 },
    { id: 'step_log', type: 'log_activity', name: 'Log a note', config: {}, order: 1 },
  ],
  requiredIntegrations: [],
  setupIssues: [{ code: 'missing_field', stepId: 'step_announce', field: 'channelId' }],
  usageCount: 0,
  authorId: null,
  createdAt: null,
  updatedAt: null,
};

const own: WorkflowTemplateItem = {
  ...builtIn,
  id: 'tmpl_1',
  source: 'workspace',
  name: 'Our onboarding',
  description: 'Saved from a workflow.',
  category: 'custom',
  icon: null,
  requiredIntegrations: ['slack'],
  setupIssues: [],
};

vi.mock('@/hooks/queries/use-automation-queries', () => ({
  useWorkflowTemplates: () => ({ data: { data: [builtIn, own] }, isLoading: false, error: null, refetch: vi.fn() }),
  useCreateWorkflowFromTemplate: () => ({ mutate: useMutate, isPending: false }),
  useUpdateTemplate: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteTemplate: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const { TemplatesClient } = await import('./templates-client');
const tt = en.weldconnect.templates;

describe('TemplatesClient', () => {
  beforeEach(() => {
    push.mockClear();
    useMutate.mockReset();
    canDelete = true;
  });

  it('lists workspace and starter templates in their own groups, with what needs setting up', () => {
    render(<TemplatesClient />);
    expect(screen.getByText(tt.groups.workspace)).toBeTruthy();
    expect(screen.getByText(tt.groups.builtin)).toBeTruthy();
    expect(screen.getByText('Celebrate won deals')).toBeTruthy();
    expect(screen.getByText('Our onboarding')).toBeTruthy();
    expect(screen.getByText(tt.needsSetupCount.replace('{count}', '1'))).toBeTruthy();
    expect(screen.getByText(tt.readyToUse)).toBeTruthy();
    expect(screen.getByText('Slack')).toBeTruthy();
  });

  it('opens a starter template and creates a draft workflow from it, then opens the editor', () => {
    render(<TemplatesClient />);
    fireEvent.click(screen.getByText('Celebrate won deals'));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('canvas preview')).toBeTruthy();
    expect(within(dialog).getByText(tt.stepNeedsSetup)).toBeTruthy();
    // Built-ins are read-only.
    expect(within(dialog).queryByText(tt.editDetails)).toBeNull();
    expect(within(dialog).queryByLabelText(tt.delete)).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: tt.useTemplate }));
    expect(useMutate).toHaveBeenCalledWith({ templateId: 'builtin_deal_won', locale: 'en' }, expect.any(Object));

    const [, callbacks] = useMutate.mock.calls[0] as [unknown, { onSuccess: (r: { data: { id: string } }) => void }];
    callbacks.onSuccess({ data: { id: 'wf_new' } });
    expect(push).toHaveBeenCalledWith('/weldconnect/workflows/wf_new/edit');
  });

  it('offers edit and delete on workspace templates, delete only with the permission', () => {
    const { unmount } = render(<TemplatesClient />);
    fireEvent.click(screen.getByText('Our onboarding'));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(tt.editDetails)).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: tt.editSteps }).getAttribute('href')).toBe('/weldconnect/templates/tmpl_1/edit');
    expect(within(dialog).getByLabelText(tt.delete)).toBeTruthy();
    unmount();

    canDelete = false;
    render(<TemplatesClient />);
    fireEvent.click(screen.getByText('Our onboarding'));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText(tt.delete)).toBeNull();
  });
});
