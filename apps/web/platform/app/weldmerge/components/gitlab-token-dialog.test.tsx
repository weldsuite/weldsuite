import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import { GitlabTokenDialog } from './gitlab-token-dialog';

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});

const tg = en.weldmerge.sync.gitlabToken;

function fillIn(host: string, token: string) {
  fireEvent.change(screen.getByLabelText(tg.host), { target: { value: host } });
  fireEvent.change(screen.getByLabelText(tg.token), { target: { value: token } });
}

describe('GitlabTokenDialog', () => {
  it('sends the trimmed address and the token, then closes', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    render(<GitlabTokenDialog open onOpenChange={onOpenChange} mode="connection" onSubmit={onSubmit} />);
    fillIn('https://git.example.com/', 'glpat-123');
    fireEvent.click(screen.getByRole('button', { name: tg.submit }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ host: 'https://git.example.com', token: 'glpat-123' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('rejects an address without a scheme and an empty token before sending', async () => {
    const onSubmit = vi.fn();
    render(<GitlabTokenDialog open onOpenChange={vi.fn()} mode="connection" onSubmit={onSubmit} />);
    fillIn('git.example.com', '');
    fireEvent.click(screen.getByRole('button', { name: tg.submit }));
    expect(await screen.findByText(tg.hostInvalid)).toBeTruthy();
    expect(screen.getByText(tg.tokenRequired)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and says so when GitLab refuses the token', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('401'));
    const onOpenChange = vi.fn();
    render(<GitlabTokenDialog open onOpenChange={onOpenChange} mode="account" onSubmit={onSubmit} />);
    fillIn('https://git.example.com', 'bad');
    fireEvent.click(screen.getByRole('button', { name: tg.submitAccount }));
    expect(await screen.findByText(tg.failed)).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('prefills the host when reconnecting', () => {
    render(
      <GitlabTokenDialog open onOpenChange={vi.fn()} mode="connection" defaultHost="https://git.example.com" onSubmit={vi.fn()} />,
    );
    expect((screen.getByLabelText(tg.host) as HTMLInputElement).value).toBe('https://git.example.com');
  });
});
