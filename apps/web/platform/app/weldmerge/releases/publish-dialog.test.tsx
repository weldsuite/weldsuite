import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { MergeReleaseDto } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { PublishReleaseDialog } from './publish-dialog';

const state = vi.hoisted(() => ({
  publish: vi.fn(),
  spaces: { isSuccess: true, data: { data: [{ id: 'ksp_1', name: 'Changelog' }] } },
  accounts: { isSuccess: true, data: { data: [{ id: 'mac_1', email: 'releases@acme.test' }] } },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/queries/use-weldmerge-across-queries', () => ({
  usePublishMergeRelease: () => ({ mutateAsync: state.publish, isPending: false }),
}));
vi.mock('@/hooks/queries/use-knowledge-queries', () => ({ useKnowledgeSpaces: () => state.spaces }));
vi.mock('@/hooks/queries/use-mail-queries', () => ({ useMailAccounts: () => state.accounts }));

const release: MergeReleaseDto = {
  id: 'mrl_1',
  teamId: 'mtm_1',
  repositoryId: 'mrp_1',
  repositoryFullName: 'acme/api',
  name: 'Spring release',
  version: 'v1.4.0',
  baseRef: null,
  headRef: null,
  status: 'shipped',
  notes: '## Fixes',
  notesGeneratedAt: null,
  knowledgePageId: null,
  shippedAt: '2026-11-05T09:00:00.000Z',
  pullRequestCount: 2,
  createdByUserId: 'user_1',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
};

const tp = en.weldmerge.across.releases.publish;

beforeEach(() => {
  state.publish = vi.fn().mockResolvedValue({ release, knowledgePageId: 'kpg_1', emailSent: false });
});

describe('PublishReleaseDialog', () => {
  it('asks to choose a destination first', async () => {
    render(<PublishReleaseDialog open onOpenChange={vi.fn()} release={release} />);
    fireEvent.click(screen.getByRole('button', { name: tp.confirm }));
    expect(await screen.findByText(tp.chooseOne)).toBeTruthy();
    expect(state.publish).not.toHaveBeenCalled();
  });

  it('refuses to publish a release without notes', async () => {
    render(<PublishReleaseDialog open onOpenChange={vi.fn()} release={{ ...release, notes: null }} />);
    fireEvent.click(screen.getByRole('checkbox', { name: tp.toKnowledge }));
    fireEvent.click(screen.getByRole('button', { name: tp.confirm }));
    expect(await screen.findByText(tp.needNotes)).toBeTruthy();
    expect(state.publish).not.toHaveBeenCalled();
  });

  it('needs a space when publishing to WeldKnow', async () => {
    render(<PublishReleaseDialog open onOpenChange={vi.fn()} release={release} />);
    fireEvent.click(screen.getByRole('checkbox', { name: tp.toKnowledge }));
    fireEvent.click(screen.getByRole('button', { name: tp.confirm }));
    expect(await screen.findByText(tp.selectSpace, { selector: '[role="alert"]' })).toBeTruthy();
    expect(state.publish).not.toHaveBeenCalled();
  });

  it('checks the recipients before sending an email', async () => {
    render(<PublishReleaseDialog open onOpenChange={vi.fn()} release={release} />);
    fireEvent.click(screen.getByRole('checkbox', { name: tp.toEmail }));
    fireEvent.change(screen.getByLabelText(tp.recipients), { target: { value: 'not-an-address' } });
    fireEvent.click(screen.getByRole('button', { name: tp.confirm }));
    // The mail account is checked before the addresses.
    expect(await screen.findByText(tp.selectMailAccount, { selector: '[role="alert"]' })).toBeTruthy();
    expect(state.publish).not.toHaveBeenCalled();
  });

  it('prefills the subject from the release', () => {
    render(<PublishReleaseDialog open onOpenChange={vi.fn()} release={release} />);
    fireEvent.click(screen.getByRole('checkbox', { name: tp.toEmail }));
    expect((screen.getByLabelText(tp.subject) as HTMLInputElement).value).toBe('Spring release v1.4.0');
  });
});
