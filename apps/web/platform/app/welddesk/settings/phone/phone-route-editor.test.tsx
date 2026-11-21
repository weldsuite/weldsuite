import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DeskTeam } from '@/hooks/queries/use-desk-routing-queries';
import type {
  DeskPhoneNumber,
  DeskPhoneRoute,
  DeskPhoneVoiceAgent,
} from '@/hooks/queries/use-desk-phone-settings-queries';
import { getTranslations } from '@/lib/i18n';
import { PhoneRouteForm } from './phone-route-editor';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const save = vi.fn();
vi.mock('@/hooks/queries/use-desk-phone-settings-queries', () => ({
  useSaveDeskPhoneRoute: () => ({ mutateAsync: save, isPending: false }),
}));

const t = getTranslations('helpdesk').phoneSettings;

const number: DeskPhoneNumber = { id: 'vpn_1', phoneNumber: '+31201234567', displayName: 'Main line', status: 'active' };

const team = (id: string, name: string): DeskTeam => ({
  id,
  createdAt: '2026-01-01T00:00:00.000Z',
  name,
  description: null,
  managerId: null,
  managerName: null,
  agentIds: [],
  escalationRules: [],
  isActive: true,
  sortOrder: 0,
});
const teams = [team('dept_support', 'Support'), team('dept_sales', 'Sales')];

const voiceAgent = (id: string, name: string, enabled = true): DeskPhoneVoiceAgent => ({
  id,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  name,
  systemPrompt: 'Be kind',
  enabled,
});
const agents = [voiceAgent('dva_1', 'Receptionist'), voiceAgent('dva_off', 'Night bot', false)];

const route = (patch: Partial<DeskPhoneRoute>): DeskPhoneRoute => ({
  id: 'dpr_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  voipPhoneNumberId: number.id,
  action: 'hangup',
  voiceAgentId: null,
  forwardToE164: null,
  schedule: null,
  options: null,
  ...patch,
});

const renderForm = (r: DeskPhoneRoute | undefined, canEdit = true) =>
  render(<PhoneRouteForm number={number} route={r} teams={teams} agents={agents} canEdit={canEdit} onClose={vi.fn()} />);

const submit = () => fireEvent.click(screen.getByTestId('phone-route-save'));

const agentsRoute = (options: NonNullable<DeskPhoneRoute['options']> = {}) => route({ action: 'agents', options });

const menuRoute = route({
  action: 'menu',
  options: {
    language: 'en-GB',
    menu: {
      prompt: 'Press 1 for sales',
      fallbackDigit: '0',
      choices: [
        { digit: '1', label: 'Sales', action: 'agents', departmentId: 'dept_sales' },
        { digit: '2', label: 'Bot', action: 'ai_agent', voiceAgentId: 'dva_1' },
        { digit: '3', label: 'Boss', action: 'forward', forwardToE164: '+31207654321' },
        { digit: '0', action: 'voicemail' },
      ],
    },
  },
});

beforeEach(() => {
  save.mockReset();
  save.mockResolvedValue(undefined);
});

describe('PhoneRouteForm: fields per action', () => {
  it('shows the queue fields for ring agents, and the voicemail greeting only when nobody-answers is voicemail', () => {
    const { unmount } = renderForm(agentsRoute({ whenUnanswered: 'voicemail' }));
    expect(screen.getByTestId('phone-fields-agents')).toBeInTheDocument();
    expect(screen.getByLabelText(t.fields.team)).toBeInTheDocument();
    expect(screen.getByLabelText(t.fields.greeting)).toBeInTheDocument();
    expect(screen.getByLabelText(t.fields.language)).toBeInTheDocument();
    expect(screen.getByLabelText(t.fields.ringSeconds)).toBeInTheDocument();
    expect(screen.getByLabelText(t.fields.maxWaitSeconds)).toBeInTheDocument();
    expect(screen.getByLabelText(t.fields.whenUnanswered)).toBeInTheDocument();
    expect(screen.getByLabelText(t.fields.voicemailGreeting)).toBeInTheDocument();
    expect(screen.queryByTestId('phone-menu-editor')).not.toBeInTheDocument();
    unmount();

    renderForm(agentsRoute({ whenUnanswered: 'hangup' }));
    expect(screen.queryByLabelText(t.fields.voicemailGreeting)).not.toBeInTheDocument();
  });

  it('shows only the greeting and language for voicemail', () => {
    renderForm(route({ action: 'voicemail', options: { language: 'nl-NL' } }));
    expect(screen.getByTestId('phone-fields-voicemail')).toBeInTheDocument();
    expect(screen.getByLabelText(t.fields.language)).toBeInTheDocument();
    expect(screen.getByLabelText(t.fields.voicemailGreeting)).toBeInTheDocument();
    expect(screen.queryByLabelText(t.fields.ringSeconds)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t.fields.team)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t.fields.greeting)).not.toBeInTheDocument();
  });

  it('shows the prompt, the choices, the fallback and the shared settings for a menu', () => {
    renderForm(menuRoute);
    expect(screen.getByTestId('phone-fields-menu')).toBeInTheDocument();
    expect(screen.getByLabelText(t.menu.prompt)).toHaveValue('Press 1 for sales');
    expect(screen.getAllByTestId('menu-choice')).toHaveLength(4);
    expect(screen.getByLabelText(t.menu.fallback)).toBeInTheDocument();
    // The choices ring agents and take a voicemail, so the shared settings show.
    expect(screen.getByTestId('phone-queue-fields')).toBeInTheDocument();
    expect(screen.getByLabelText(t.fields.ringSeconds)).toBeInTheDocument();
    expect(screen.getByLabelText(t.fields.voicemailGreeting)).toBeInTheDocument();
    // The choice targets: team, AI voice agent, number.
    expect(screen.getByLabelText(`${t.fields.team} 1`)).toBeInTheDocument();
    expect(screen.getByLabelText(`${t.fields.voiceAgent} 2`)).toBeInTheDocument();
    expect(screen.getByDisplayValue('+31207654321')).toBeInTheDocument();
  });

  it('hides the shared settings of a menu whose choices ring nobody and take no voicemail', () => {
    renderForm(
      route({
        action: 'menu',
        options: { menu: { prompt: 'p', choices: [{ digit: '1', action: 'forward', forwardToE164: '+31207654321' }] } },
      }),
    );
    expect(screen.queryByTestId('phone-queue-fields')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t.fields.ringSeconds)).not.toBeInTheDocument();
  });

  it('keeps the AI agent, forward and hang up routes simple', () => {
    const ai = renderForm(route({ action: 'ai_agent', voiceAgentId: 'dva_1' }));
    expect(screen.getByTestId('phone-fields-ai-agent')).toBeInTheDocument();
    expect(screen.queryByLabelText(t.fields.language)).not.toBeInTheDocument();
    ai.unmount();

    const fwd = renderForm(route({ action: 'forward', forwardToE164: '+31207654321' }));
    expect(screen.getByLabelText(t.fields.forwardTo)).toHaveValue('+31207654321');
    expect(screen.queryByLabelText(t.fields.language)).not.toBeInTheDocument();
    fwd.unmount();

    renderForm(undefined);
    expect(screen.queryByTestId('phone-fields-agents')).not.toBeInTheDocument();
    expect(screen.queryByTestId('phone-fields-forward')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(t.fields.language)).not.toBeInTheDocument();
  });

  it('shows no save button to someone who cannot manage settings', () => {
    renderForm(agentsRoute(), false);
    expect(screen.queryByTestId('phone-route-save')).not.toBeInTheDocument();
    expect(screen.getByText(t.editor.readOnly)).toBeInTheDocument();
  });
});

describe('PhoneRouteForm: what is sent', () => {
  it('sends an edited ring agents route', async () => {
    renderForm(
      agentsRoute({
        departmentId: 'dept_support',
        language: 'nl-NL',
        ringSeconds: 20,
        maxWaitSeconds: 120,
        whenUnanswered: 'voicemail',
      }),
    );
    fireEvent.change(screen.getByLabelText(t.fields.greeting), { target: { value: 'Welcome' } });
    fireEvent.change(screen.getByLabelText(t.fields.voicemailGreeting), { target: { value: 'Leave a message' } });
    fireEvent.change(screen.getByLabelText(t.fields.maxWaitSeconds), { target: { value: '90' } });
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      voipPhoneNumberId: 'vpn_1',
      action: 'agents',
      options: {
        greeting: 'Welcome',
        departmentId: 'dept_support',
        language: 'nl-NL',
        ringSeconds: 20,
        maxWaitSeconds: 90,
        whenUnanswered: 'voicemail',
        voicemailGreeting: 'Leave a message',
      },
    });
  });

  it('sends a voicemail route', async () => {
    renderForm(route({ action: 'voicemail', options: { language: 'de-DE' } }));
    fireEvent.change(screen.getByLabelText(t.fields.voicemailGreeting), { target: { value: 'Bitte sprechen Sie' } });
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      voipPhoneNumberId: 'vpn_1',
      action: 'voicemail',
      options: { language: 'de-DE', voicemailGreeting: 'Bitte sprechen Sie' },
    });
  });

  it('sends a menu with every choice action', async () => {
    renderForm(menuRoute);
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({
      voipPhoneNumberId: 'vpn_1',
      action: 'menu',
      options: {
        language: 'en-GB',
        ringSeconds: 25,
        maxWaitSeconds: 300,
        whenUnanswered: 'voicemail',
        menu: {
          prompt: 'Press 1 for sales',
          fallbackDigit: '0',
          choices: [
            { digit: '1', label: 'Sales', action: 'agents', departmentId: 'dept_sales' },
            { digit: '2', label: 'Bot', action: 'ai_agent', voiceAgentId: 'dva_1' },
            { digit: '3', label: 'Boss', action: 'forward', forwardToE164: '+31207654321' },
            { digit: '0', action: 'voicemail' },
          ],
        },
      },
    });
  });

  it('sends the classic routes as before', async () => {
    renderForm(route({ action: 'forward', forwardToE164: '+31207654321' }));
    fireEvent.change(screen.getByLabelText(t.fields.forwardTo), { target: { value: '+31201111111' } });
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ voipPhoneNumberId: 'vpn_1', action: 'forward', forwardToE164: '+31201111111' });
  });
});

describe('PhoneRouteForm: menu choices', () => {
  it('adds a choice on the next free key and removes one, moving the fallback off a removed key', async () => {
    renderForm(menuRoute);
    fireEvent.click(screen.getByTestId('menu-add-choice'));
    expect(screen.getAllByTestId('menu-choice')).toHaveLength(5);
    // The keys 1, 2, 3 and 0 are taken: the new choice takes 4.
    fireEvent.click(screen.getByRole('button', { name: t.menu.removeChoice.replace('{digit}', '0') }));
    expect(screen.getAllByTestId('menu-choice')).toHaveLength(4);
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const body = save.mock.calls[0]?.[0] as { options: { menu: { choices: Array<{ digit: string }>; fallbackDigit?: string } } };
    expect(body.options.menu.choices.map((c) => c.digit)).toEqual(['1', '2', '3', '4']);
    // The fallback was the removed key 0: the call is hung up instead.
    expect(body.options.menu.fallbackDigit).toBeUndefined();
  });

  it('stops offering to add a choice at nine', () => {
    const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
    const choices = digits.map((digit) => ({ digit, action: 'voicemail' as const }));
    renderForm(route({ action: 'menu', options: { menu: { prompt: 'p', choices } } }));
    expect(screen.getByTestId('menu-add-choice')).toBeDisabled();
  });

  it('refuses a menu without a prompt or a choice, and does not call the server', async () => {
    renderForm(route({ action: 'menu', options: { menu: { prompt: '', choices: [] } } }));
    submit();
    await waitFor(() => expect(screen.getByText(t.errors.required)).toBeInTheDocument());
    expect(screen.getByText(t.errors.choicesRange)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('marks a missing AI agent and a bad forward number on their choices', async () => {
    renderForm(
      route({
        action: 'menu',
        options: {
          menu: {
            prompt: 'p',
            choices: [
              { digit: '1', action: 'ai_agent' },
              { digit: '2', action: 'forward', forwardToE164: '020' },
            ],
          },
        },
      }),
    );
    submit();
    const choices = await screen.findAllByTestId('menu-choice');
    expect(within(choices[0]!).getByText(t.errors.required)).toBeInTheDocument();
    expect(within(choices[1]!).getByText(t.errors.e164)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('PhoneRouteForm: server errors', () => {
  it('shows an unknown team on the team field', async () => {
    const message = "Team with ID 'dept_support' not found";
    save.mockRejectedValue(Object.assign(new Error(message), { status: 404, body: { error: { code: 'NOT_FOUND', message } } }));
    renderForm(agentsRoute({ departmentId: 'dept_support' }));
    submit();
    const field = (await screen.findByText(message)).closest('div');
    expect(field).toContainElement(screen.getByLabelText(t.fields.team));
  });

  it('shows a validation answer on the choice it names', async () => {
    const body = {
      error: { name: 'ZodError', issues: [{ code: 'custom', message: 'Digit 1 is used twice', path: ['options', 'menu', 'choices', 1, 'digit'] }] },
    };
    save.mockRejectedValue(Object.assign(new Error('Digit 1 is used twice'), { status: 400, body }));
    renderForm(menuRoute);
    submit();
    const choices = await screen.findAllByTestId('menu-choice');
    expect(within(choices[1]!).getByText('Digit 1 is used twice')).toBeInTheDocument();
    expect(within(choices[0]!).queryByText('Digit 1 is used twice')).not.toBeInTheDocument();
  });

  it('shows a disabled voice agent on its choice', async () => {
    const message = 'Voice agent dva_1 is disabled';
    save.mockRejectedValue(Object.assign(new Error(message), { status: 400, body: { error: { code: 'BAD_REQUEST', message } } }));
    renderForm(menuRoute);
    submit();
    const choices = await screen.findAllByTestId('menu-choice');
    expect(within(choices[1]!).getByText(message)).toBeInTheDocument();
  });

  it('shows an error without a field above the buttons', async () => {
    save.mockRejectedValue(Object.assign(new Error('Something broke'), { status: 500 }));
    renderForm(agentsRoute());
    submit();
    expect(await screen.findByText('Something broke')).toBeInTheDocument();
  });
});
