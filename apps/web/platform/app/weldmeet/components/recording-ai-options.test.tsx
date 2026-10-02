import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeetingAiPricingResult } from '@weldsuite/app-api-client/schemas/weldmeet-recordings';

const push = vi.fn();
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push }) }));

import {
  EMPTY_AI_CHOICE,
  InsufficientCreditsNotice,
  RecordingAiOptionsFields,
  requiredCreditsForChoice,
  type RecordingAiChoice,
} from './recording-ai-options';

const pricing: MeetingAiPricingResult = {
  transcriptionCreditsPerMinute: 2,
  summaryCreditsPerMinute: 1,
  balance: 100,
};

function Harness({ initial = EMPTY_AI_CHOICE, prices = pricing }: Readonly<{ initial?: RecordingAiChoice; prices?: MeetingAiPricingResult }>) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <RecordingAiOptionsFields
        idPrefix="t"
        value={value}
        onChange={setValue}
        pricing={prices}
        pricingLoading={false}
        pricingFailed={false}
      />
      <output data-testid="choice">{JSON.stringify(value)}</output>
    </>
  );
}

const choice = () => JSON.parse(screen.getByTestId('choice').textContent ?? '{}') as RecordingAiChoice;

describe('RecordingAiOptionsFields', () => {
  it('starts with everything off and shows the per-minute cost and the balance', () => {
    render(<Harness />);
    expect(choice()).toMatchObject({ transcribe: false, summarize: false });
    expect(screen.getByText('2 credits per meeting minute')).toBeTruthy();
    expect(screen.getByText('1 credits per meeting minute')).toBeTruthy();
    expect(screen.getByText('Credit balance: 100')).toBeTruthy();
  });

  it('turns the transcript on when only the summary is chosen', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Generate AI summary' }));
    expect(choice()).toMatchObject({ transcribe: true, summarize: true });
  });

  it('turns the summary off when the transcript is turned off', () => {
    render(<Harness initial={{ transcribe: true, summarize: true, language: null }} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Transcribe this meeting' }));
    expect(choice()).toMatchObject({ transcribe: false, summarize: false });
  });

  it('warns when the balance cannot cover one minute of the chosen items', () => {
    render(<Harness initial={{ transcribe: true, summarize: true, language: null }} prices={{ ...pricing, balance: 2 }} />);
    expect(screen.getByText(/may not cover even one meeting minute/)).toBeTruthy();
  });
});

describe('requiredCreditsForChoice', () => {
  it('is one meeting minute of the chosen items, rounded up to whole credits', () => {
    expect(requiredCreditsForChoice(EMPTY_AI_CHOICE, pricing)).toBe(0);
    expect(requiredCreditsForChoice({ transcribe: true, summarize: false, language: null }, pricing)).toBe(2);
    expect(requiredCreditsForChoice({ transcribe: true, summarize: true, language: null }, { ...pricing, summaryCreditsPerMinute: 0.5 })).toBe(3);
  });
});

describe('InsufficientCreditsNotice', () => {
  it('shows what is needed against the balance and links to billing', () => {
    render(<InsufficientCreditsNotice details={{ required: 3, currentBalance: 1, shortfall: 2 }} />);
    expect(screen.getByRole('alert').textContent).toContain('It needs at least 3 credits and your balance is 1.');
    fireEvent.click(screen.getByRole('button', { name: 'Top up credits' }));
    expect(push).toHaveBeenCalledWith('/settings/billing');
  });

  it('falls back to a plain message when the API sent no numbers', () => {
    render(<InsufficientCreditsNotice details={{}} />);
    expect(screen.getByRole('alert').textContent).toContain('You do not have enough credits for this.');
  });
});
