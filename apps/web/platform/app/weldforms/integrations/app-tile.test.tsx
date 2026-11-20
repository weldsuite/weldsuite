import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Webhook } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormIntegration } from '@weldsuite/app-api-client/schemas/weldforms';
import { en } from '@weldsuite/i18n/locales/en';
import { AppCardButton, IntegrationHeader, IntegrationLogo, IntegrationStatus } from './app-tile';

const ti = en.weldformsResults.integrations;

vi.mock('@/lib/i18n/provider', () => ({ useI18n: () => ({ t: en }) }));
vi.mock('@/lib/apps/app-registry', () => ({
  getAppLogo: (code: string) => (code === 'weldcrm' ? '/logos/crm.svg' : undefined),
  getAppLucideIcon: () => (props: { className?: string }) => <svg data-testid="fallback-icon" className={props.className} />,
}));

const make = (extra: Partial<FormIntegration>) => ({ id: 'i', kind: 'crm', enabled: true, lastError: null, ...extra }) as unknown as FormIntegration;

afterEach(cleanup);

describe('IntegrationLogo', () => {
  it('draws the app logo image when the registry has one', () => {
    const { container } = render(<IntegrationLogo code="weldcrm" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/logos/crm.svg');
  });
  it('falls back to the registry icon', () => {
    render(<IntegrationLogo code="weldx" />);
    expect(screen.getByTestId('fallback-icon')).toBeTruthy();
  });
  it('uses a given icon, and works with no code at all', () => {
    const { container } = render(<IntegrationLogo icon={Webhook} />);
    expect(container.querySelector('svg')).toBeTruthy();
    cleanup();
    render(<IntegrationLogo />);
    expect(screen.getByTestId('fallback-icon')).toBeTruthy();
  });
});

describe('IntegrationStatus', () => {
  it('renders nothing when not set up', () => {
    const { container } = render(<IntegrationStatus integration={null} />);
    expect(container.firstChild).toBeNull();
  });
  it('shows failed before off', () => {
    render(<IntegrationStatus integration={make({ lastError: 'x', enabled: false })} className="extra" />);
    expect(screen.getByText(ti.statusFailed)).toBeTruthy();
  });
  it('shows off', () => {
    render(<IntegrationStatus integration={make({ enabled: false })} />);
    expect(screen.getByText(ti.statusOff)).toBeTruthy();
  });
  it('shows on', () => {
    render(<IntegrationStatus integration={make({})} className="extra" />);
    expect(screen.getByText(ti.statusOn).className).toContain('extra');
  });
});

describe('AppCardButton', () => {
  it('shows name, subtitle, description and badge, and handles clicks', () => {
    const onClick = vi.fn();
    render(<AppCardButton logo={<i />} name="N" subtitle="S" description="D" badge={<b>B</b>} onClick={onClick} />);
    for (const text of ['N', 'S', 'D', 'B']) expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalled();
  });
  it('renders without a badge', () => {
    render(<AppCardButton logo={<i />} name="N" subtitle="S" description="D" onClick={vi.fn()} />);
    expect(screen.queryByText('B')).toBeNull();
  });
});

describe('IntegrationHeader', () => {
  it('shows title, badge, description, children and aside, and Back calls onBack', () => {
    const onBack = vi.fn();
    render(
      <IntegrationHeader logo={<i />} title="T" badge={<b>badge</b>} description="Desc" onBack={onBack} aside={<u>aside</u>} className="c">
        <span>child</span>
      </IntegrationHeader>,
    );
    for (const text of ['T', 'badge', 'Desc', 'child', 'aside']) expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.common.actions.back }));
    expect(onBack).toHaveBeenCalled();
  });
  it('omits children and aside when absent', () => {
    render(<IntegrationHeader logo={<i />} title="T" description="Desc" onBack={vi.fn()} />);
    expect(screen.queryByText('child')).toBeNull();
  });
});
