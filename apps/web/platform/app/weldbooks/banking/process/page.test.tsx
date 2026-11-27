import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const env = vi.hoisted(() => ({ processing: false }));

vi.mock('@/lib/edition', () => ({ isFeatureAvailable: (feature: string) => feature === 'books-bank-processing' && env.processing }));
vi.mock('../reconciliation/page', () => ({ default: () => <div data-testid="reconcile-screen" /> }));
vi.mock('./process-view', () => ({ ProcessView: () => <div data-testid="process-view" /> }));

import BankProcessPage from './page';

describe('BankProcessPage', () => {
  beforeEach(() => {
    env.processing = false;
  });

  it('keeps today\'s reconcile screen where the edition lacks bank processing (Global)', () => {
    render(<BankProcessPage />);
    expect(screen.getByTestId('reconcile-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('process-view')).not.toBeInTheDocument();
  });

  it('is the processing view where the edition has it', () => {
    env.processing = true;
    render(<BankProcessPage />);
    expect(screen.getByTestId('process-view')).toBeInTheDocument();
    expect(screen.queryByTestId('reconcile-screen')).not.toBeInTheDocument();
  });
});
