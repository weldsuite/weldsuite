import { describe, expect, it } from 'vitest';
import type { DeskPhoneRoute } from '@/hooks/queries/use-desk-phone-settings-queries';
import {
  emptyChoice,
  emptyRouteValues,
  routeToValues,
  serverErrorToFormErrors,
  unusedDigits,
  validateValues,
  valuesToInput,
  type PhoneRouteFormValues,
} from './phone-route-form';
import { formatWait, summarizeRoute, type RouteSummaryStrings } from './phone-route-summary';

const NUMBER = 'vpn_1';

const route = (patch: Partial<DeskPhoneRoute>): DeskPhoneRoute => ({
  id: 'dpr_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  voipPhoneNumberId: NUMBER,
  action: 'hangup',
  voiceAgentId: null,
  forwardToE164: null,
  schedule: null,
  options: null,
  ...patch,
});

const menuValues = (patch: Partial<PhoneRouteFormValues> = {}): PhoneRouteFormValues => ({
  ...emptyRouteValues(),
  action: 'menu',
  menuPrompt: 'Press 1 for sales',
  menuChoices: [{ ...emptyChoice('1'), label: 'Sales', action: 'agents', departmentId: 'dept_sales' }],
  ...patch,
});

describe('phone route form: request body', () => {
  it('sends a ring agents route with its queue settings', () => {
    const values: PhoneRouteFormValues = {
      ...emptyRouteValues(),
      action: 'agents',
      departmentId: 'dept_support',
      greeting: ' Welcome ',
      language: 'nl-NL',
      ringSeconds: 20,
      maxWaitSeconds: 120,
      whenUnanswered: 'voicemail',
      voicemailGreeting: 'Leave a message',
      // Fields of other actions are never sent.
      menuPrompt: 'ignored',
      forwardToE164: '+31201234567',
    };
    expect(valuesToInput(NUMBER, values)).toEqual({
      voipPhoneNumberId: NUMBER,
      action: 'agents',
      options: {
        greeting: 'Welcome',
        departmentId: 'dept_support',
        language: 'nl-NL',
        ringSeconds: 20,
        maxWaitSeconds: 120,
        whenUnanswered: 'voicemail',
        voicemailGreeting: 'Leave a message',
      },
    });
  });

  it('leaves out an empty greeting, all agents, and the voicemail greeting when nobody-answers hangs up', () => {
    const values: PhoneRouteFormValues = {
      ...emptyRouteValues(),
      action: 'agents',
      whenUnanswered: 'hangup',
      voicemailGreeting: 'would be unused',
    };
    expect(valuesToInput(NUMBER, values)).toEqual({
      voipPhoneNumberId: NUMBER,
      action: 'agents',
      options: { language: 'en-US', ringSeconds: 25, maxWaitSeconds: 300, whenUnanswered: 'hangup' },
    });
  });

  it('sends a voicemail route with only greeting and language', () => {
    const values: PhoneRouteFormValues = {
      ...emptyRouteValues(),
      action: 'voicemail',
      language: 'de-DE',
      voicemailGreeting: 'Bitte sprechen Sie',
      ringSeconds: 40,
      greeting: 'unused',
    };
    expect(valuesToInput(NUMBER, values)).toEqual({
      voipPhoneNumberId: NUMBER,
      action: 'voicemail',
      options: { language: 'de-DE', voicemailGreeting: 'Bitte sprechen Sie' },
    });
  });

  it('sends a menu with every choice action and the target each needs', () => {
    const values = menuValues({
      language: 'fr-FR',
      ringSeconds: 15,
      maxWaitSeconds: 60,
      whenUnanswered: 'hangup',
      fallbackDigit: '0',
      menuChoices: [
        { ...emptyChoice('1'), label: 'Sales', action: 'agents', departmentId: 'dept_sales', voiceAgentId: 'unused' },
        { ...emptyChoice('2'), action: 'agents' },
        { ...emptyChoice('3'), label: 'Bot', action: 'ai_agent', voiceAgentId: 'dva_1', forwardToE164: '+31201234567' },
        { ...emptyChoice('4'), label: ' Boss ', action: 'forward', forwardToE164: ' +31201234567 ' },
        { ...emptyChoice('0'), label: 'Voicemail', action: 'voicemail' },
      ],
    });
    expect(valuesToInput(NUMBER, values)).toEqual({
      voipPhoneNumberId: NUMBER,
      action: 'menu',
      options: {
        language: 'fr-FR',
        ringSeconds: 15,
        maxWaitSeconds: 60,
        whenUnanswered: 'hangup',
        menu: {
          prompt: 'Press 1 for sales',
          fallbackDigit: '0',
          choices: [
            { digit: '1', label: 'Sales', action: 'agents', departmentId: 'dept_sales' },
            { digit: '2', action: 'agents' },
            { digit: '3', label: 'Bot', action: 'ai_agent', voiceAgentId: 'dva_1' },
            { digit: '4', label: 'Boss', action: 'forward', forwardToE164: '+31201234567' },
            { digit: '0', label: 'Voicemail', action: 'voicemail' },
          ],
        },
      },
    });
  });

  it('keeps the classic actions as they were', () => {
    expect(valuesToInput(NUMBER, { ...emptyRouteValues(), action: 'ai_agent', voiceAgentId: 'dva_1' })).toEqual({
      voipPhoneNumberId: NUMBER,
      action: 'ai_agent',
      voiceAgentId: 'dva_1',
    });
    expect(valuesToInput(NUMBER, { ...emptyRouteValues(), action: 'forward', forwardToE164: ' +31201234567' })).toEqual({
      voipPhoneNumberId: NUMBER,
      action: 'forward',
      forwardToE164: '+31201234567',
    });
    expect(valuesToInput(NUMBER, emptyRouteValues())).toEqual({ voipPhoneNumberId: NUMBER, action: 'hangup' });
  });

  it('reads a stored route back into the form and writes the same body again', () => {
    const stored = route({
      action: 'menu',
      options: {
        language: 'nl-NL',
        ringSeconds: 30,
        maxWaitSeconds: 600,
        whenUnanswered: 'voicemail',
        voicemailGreeting: 'Spreek maar in',
        menu: {
          prompt: 'Druk 1',
          fallbackDigit: '1',
          choices: [
            { digit: '1', label: 'Verkoop', action: 'agents', departmentId: 'dept_sales' },
            { digit: '9', action: 'voicemail' },
          ],
        },
      },
    });
    const values = routeToValues(stored);
    expect(values).toMatchObject({ action: 'menu', fallbackDigit: '1', ringSeconds: 30 });
    expect(valuesToInput(NUMBER, values)).toEqual({ voipPhoneNumberId: NUMBER, action: 'menu', options: stored.options });
    expect(routeToValues(undefined).action).toBe('hangup');
  });
});

describe('phone route form: validation', () => {
  it('offers only the keys no choice uses', () => {
    expect(unusedDigits([{ digit: '1' }, { digit: '0' }, { digit: '#' }])).toEqual(['2', '3', '4', '5', '6', '7', '8', '9', '*']);
    expect(unusedDigits([])).toHaveLength(12);
  });

  it('refuses a key used twice, on the second choice', () => {
    const values = menuValues({
      menuChoices: [
        { ...emptyChoice('1'), action: 'voicemail' },
        { ...emptyChoice('1'), action: 'voicemail' },
      ],
    });
    expect(validateValues(NUMBER, values)).toEqual({ 'choice.1.digit': { code: 'digitUsed' } });
  });

  it('takes a fallback only from the choices', () => {
    const base = menuValues({ menuChoices: [{ ...emptyChoice('1'), action: 'voicemail' }] });
    expect(validateValues(NUMBER, { ...base, fallbackDigit: '1' })).toEqual({});
    expect(validateValues(NUMBER, { ...base, fallbackDigit: '' })).toEqual({});
    expect(validateValues(NUMBER, { ...base, fallbackDigit: '5' })).toEqual({ fallbackDigit: { code: 'fallbackInvalid' } });
  });

  it('checks the prompt, the number of choices and the targets', () => {
    expect(validateValues(NUMBER, menuValues({ menuPrompt: '  ' }))).toEqual({ menuPrompt: { code: 'required' } });
    expect(validateValues(NUMBER, menuValues({ menuChoices: [] }))).toEqual({ menuChoices: { code: 'choicesRange' } });
    const tooMany = menuValues({
      menuChoices: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((d) => ({
        ...emptyChoice(d as '1'),
        action: 'voicemail' as const,
      })),
    });
    expect(validateValues(NUMBER, tooMany)).toEqual({ menuChoices: { code: 'choicesRange' } });
    const targets = menuValues({
      menuChoices: [
        { ...emptyChoice('1'), action: 'ai_agent' },
        { ...emptyChoice('2'), action: 'forward', forwardToE164: '0201234567' },
      ],
    });
    expect(validateValues(NUMBER, targets)).toEqual({
      'choice.0.voiceAgentId': { code: 'required' },
      'choice.1.forwardToE164': { code: 'e164' },
    });
  });

  it('checks the ring time and the maximum wait only where they apply', () => {
    const agents: PhoneRouteFormValues = { ...emptyRouteValues(), action: 'agents', ringSeconds: 5, maxWaitSeconds: 5000 };
    expect(validateValues(NUMBER, agents)).toEqual({ ringSeconds: { code: 'ringRange' }, maxWaitSeconds: { code: 'maxWaitRange' } });
    expect(validateValues(NUMBER, { ...agents, ringSeconds: 10, maxWaitSeconds: 30 })).toEqual({});
    expect(validateValues(NUMBER, { ...agents, ringSeconds: undefined, maxWaitSeconds: undefined })).toEqual({});
    // A voicemail route has no queue: an out-of-range ring time is not sent, so not checked.
    expect(validateValues(NUMBER, { ...agents, action: 'voicemail' })).toEqual({});
    // A menu without a ring agents choice has no queue either.
    const noQueue = menuValues({ ringSeconds: 5, menuChoices: [{ ...emptyChoice('1'), action: 'voicemail' }] });
    expect(validateValues(NUMBER, noQueue)).toEqual({});
    const queue = menuValues({ ringSeconds: 5 });
    expect(validateValues(NUMBER, queue)).toEqual({ ringSeconds: { code: 'ringRange' } });
  });

  it('checks the texts, the language, the AI agent and the forward number', () => {
    const long = 'x'.repeat(1001);
    expect(validateValues(NUMBER, { ...emptyRouteValues(), action: 'agents', greeting: long })).toEqual({ greeting: { code: 'tooLong' } });
    expect(validateValues(NUMBER, { ...emptyRouteValues(), action: 'voicemail', language: 'not a tag' })).toEqual({
      language: { code: 'languageInvalid' },
    });
    expect(validateValues(NUMBER, { ...emptyRouteValues(), action: 'ai_agent' })).toEqual({ voiceAgentId: { code: 'required' } });
    expect(validateValues(NUMBER, { ...emptyRouteValues(), action: 'forward', forwardToE164: 'abc' })).toEqual({
      forwardToE164: { code: 'e164' },
    });
    expect(validateValues(NUMBER, emptyRouteValues())).toEqual({});
  });
});

describe('phone route form: server errors', () => {
  it('puts validation issues on their fields, with the server words', () => {
    const body = {
      success: false,
      error: {
        name: 'ZodError',
        issues: [
          { code: 'custom', message: 'Digit 1 is used twice', path: ['options', 'menu', 'choices', 1, 'digit'] },
          { code: 'too_big', message: 'Too big', path: ['options', 'ringSeconds'] },
        ],
      },
    };
    expect(serverErrorToFormErrors(menuValues(), { status: 400, body, message: 'Digit 1 is used twice' })).toEqual({
      'choice.1.digit': { message: 'Digit 1 is used twice' },
      ringSeconds: { message: 'Too big' },
    });
  });

  it('puts an unknown team on the team field of a ring agents route', () => {
    const values: PhoneRouteFormValues = { ...emptyRouteValues(), action: 'agents', departmentId: 'dept_gone' };
    const message = "Team with ID 'dept_gone' not found";
    expect(serverErrorToFormErrors(values, { status: 404, body: { error: { code: 'NOT_FOUND', message } }, message })).toEqual({
      departmentId: { message },
    });
  });

  it('puts an unknown team and an unknown or disabled voice agent on the choice that uses them', () => {
    const values = menuValues({
      menuChoices: [
        { ...emptyChoice('1'), action: 'agents', departmentId: 'dept_gone' },
        { ...emptyChoice('2'), action: 'ai_agent', voiceAgentId: 'dva_gone' },
        { ...emptyChoice('3'), action: 'ai_agent', voiceAgentId: 'dva_off' },
      ],
    });
    const team = "Team with ID 'dept_gone' not found";
    expect(serverErrorToFormErrors(values, { status: 404, message: team })).toEqual({ 'choice.0.departmentId': { message: team } });
    const agent = "Voice agent with ID 'dva_gone' not found";
    expect(serverErrorToFormErrors(values, { status: 404, message: agent })).toEqual({ 'choice.1.voiceAgentId': { message: agent } });
    const off = 'Voice agent dva_off is disabled';
    expect(serverErrorToFormErrors(values, { status: 400, message: off })).toEqual({ 'choice.2.voiceAgentId': { message: off } });
  });

  it('puts an unknown voice agent of an AI agent route on its field, and anything else on the form', () => {
    const values: PhoneRouteFormValues = { ...emptyRouteValues(), action: 'ai_agent', voiceAgentId: 'dva_gone' };
    const message = "Voice agent with ID 'dva_gone' not found";
    expect(serverErrorToFormErrors(values, { status: 404, message })).toEqual({ voiceAgentId: { message } });
    expect(serverErrorToFormErrors(values, { status: 500, message: 'Boom' })).toEqual({ form: { message: 'Boom' } });
    expect(serverErrorToFormErrors(values, { status: 404, message: "Phone number with ID 'x' not found" })).toEqual({
      form: { message: "Phone number with ID 'x' not found" },
    });
  });
});

const strings: RouteSummaryStrings = {
  notSet: 'No route set',
  hangup: 'Hangs up',
  aiAgent: 'AI voice agent {name}',
  aiAgentNone: 'AI voice agent (none selected)',
  forward: 'Forwards to {number}',
  voicemail: 'Takes a voicemail',
  agents: 'Rings {team}, then {then} after {wait}',
  allAgents: 'all available agents',
  thenVoicemail: 'voicemail',
  thenHangup: 'hang up',
  menu: 'Menu: {choices}',
  choiceNames: { agents: 'Agents', voicemail: 'Voicemail', ai_agent: 'AI agent', forward: 'Forward' },
  minutes: '{count} min',
  seconds: '{count} sec',
};
const lookups = {
  teamName: (id: string) => (id === 'dept_support' ? 'Support' : undefined),
  agentName: (id: string) => (id === 'dva_1' ? 'Receptionist' : undefined),
};

describe('phone route summary', () => {
  it('reads each action in one line', () => {
    expect(summarizeRoute(undefined, lookups, strings)).toBe('No route set');
    expect(summarizeRoute(route({}), lookups, strings)).toBe('Hangs up');
    expect(summarizeRoute(route({ action: 'ai_agent', voiceAgentId: 'dva_1' }), lookups, strings)).toBe('AI voice agent Receptionist');
    expect(summarizeRoute(route({ action: 'ai_agent', voiceAgentId: 'dva_x' }), lookups, strings)).toBe('AI voice agent (none selected)');
    expect(summarizeRoute(route({ action: 'forward', forwardToE164: '+31201234567' }), lookups, strings)).toBe('Forwards to +31201234567');
    expect(summarizeRoute(route({ action: 'voicemail' }), lookups, strings)).toBe('Takes a voicemail');
  });

  it('reads a ring agents route with its team, its fallback and the wait', () => {
    const withTeam = route({ action: 'agents', options: { departmentId: 'dept_support', maxWaitSeconds: 300, whenUnanswered: 'voicemail' } });
    expect(summarizeRoute(withTeam, lookups, strings)).toBe('Rings Support, then voicemail after 5 min');
    const defaults = route({ action: 'agents', options: null });
    expect(summarizeRoute(defaults, lookups, strings)).toBe('Rings all available agents, then voicemail after 5 min');
    const hangup = route({ action: 'agents', options: { maxWaitSeconds: 90, whenUnanswered: 'hangup' } });
    expect(summarizeRoute(hangup, lookups, strings)).toBe('Rings all available agents, then hang up after 1 min 30 sec');
    expect(formatWait(45, strings)).toBe('45 sec');
  });

  it('reads a menu by key, with the label or else the action', () => {
    const menu = route({
      action: 'menu',
      options: {
        menu: {
          prompt: 'p',
          choices: [
            { digit: '1', label: 'Sales', action: 'agents' },
            { digit: '2', label: 'Support', action: 'agents' },
            { digit: '0', action: 'voicemail' },
          ],
        },
      },
    });
    expect(summarizeRoute(menu, lookups, strings)).toBe('Menu: 1 Sales, 2 Support, 0 Voicemail');
  });
});
