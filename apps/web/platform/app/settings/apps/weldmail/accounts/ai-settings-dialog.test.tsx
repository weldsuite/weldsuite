import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiModelOption } from '@weldsuite/app-api-client/schemas/ai-settings';

const state = vi.hoisted(() => ({
  models: null as AiModelOption[] | null,
  mutate: vi.fn(),
}));

vi.mock('@/hooks/queries/use-ai-settings-queries', () => ({
  useAiModelOptions: () => state.models,
}));
vi.mock('@/hooks/queries/use-mail-queries', () => ({
  useUpdateMailAccount: () => ({ mutateAsync: state.mutate, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/banking/feeds/test-support';
import { AiSettingsDialog } from './ai-settings-dialog';

function open() {
  return renderWithProviders(
    <AiSettingsDialog open onOpenChange={() => undefined} accountId="acc_1" accountEmail="a@example.com" />,
  );
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  state.models = null;
  state.mutate.mockReset();
  state.mutate.mockResolvedValue({});
});

describe('mail account AI dialog model picker', () => {
  it('lists the workspace models with where each is processed on a Kubernetes install', async () => {
    state.models = [
      {
        id: 'mistral/mistral-medium',
        provider: 'mistral',
        region: 'eu',
        label: 'Mistral Medium',
      },
      {
        id: 'anthropic/claude-sonnet-5-5',
        provider: 'anthropic',
        region: 'outside-eu',
        label: 'Claude Sonnet',
      },
    ];
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('combobox', { name: /model preference/i }));

    expect(await screen.findByRole('option', { name: /Mistral Medium/ })).toBeInTheDocument();
    const claude = screen.getByRole('option', { name: /Claude Sonnet/ });
    expect(claude).toHaveTextContent('outside the EU');
  });

  it('saves the canonical model id', async () => {
    state.models = [
      {
        id: 'anthropic/claude-sonnet-5-5',
        provider: 'anthropic',
        region: 'outside-eu',
        label: 'Claude Sonnet',
      },
    ];
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('combobox', { name: /model preference/i }));
    await user.click(await screen.findByRole('option', { name: /Claude Sonnet/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(state.mutate).toHaveBeenCalled());
    expect(state.mutate.mock.calls[0]![0].aiSettings.modelPreference).toBe('anthropic/claude-sonnet-5-5');
  });

  it("keeps today's list on Global, with no region labels", async () => {
    const user = userEvent.setup();
    open();
    await user.click(screen.getByRole('combobox', { name: /model preference/i }));
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    for (const option of options) expect(option).not.toHaveTextContent(/EU/);
  });
});
