import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PageTabs, type PageTab } from './page-tabs';

/**
 * jsdom lays nothing out. Give every element a width of 10px per character of
 * its text, and the tab row a fixed width, so the overflow sums are predictable:
 * "+88 more" (the plain trigger) measures 80px, and the trigger naming the active
 * tab measures its label plus "+88".
 */
let rowWidth = 320;
const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return (this.textContent ?? '').length * 10;
    },
  });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get: () => rowWidth,
  });
});

afterAll(() => {
  if (offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
  if (clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', clientWidth);
});

afterEach(() => {
  cleanup();
  rowWidth = 320;
});

const FileIcon = ({ className }: { className?: string }) => <svg data-testid="file-icon" className={className} />;

/** 80, 50, 100 and 70px wide, then the long one at 170px, its trigger 200px. */
const TABS: PageTab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'leave', label: 'Leave' },
  { id: 'attendance', label: 'Attendance' },
  { id: 'payroll', label: 'Payroll' },
  { id: 'documents', label: 'Documents & files', icon: FileIcon },
];

const visibleTabs = () => screen.getAllByRole('tab').map((tab) => tab.textContent);

describe('PageTabs overflow="dropdown"', () => {
  it('keeps every tab in the row while they fit', () => {
    rowWidth = 1000;
    render(<PageTabs tabs={TABS} activeTab="overview" overflow="dropdown" />);
    expect(visibleTabs()).toEqual(['Overview', 'Leave', 'Attendance', 'Payroll', 'Documents & files']);
    expect(screen.queryByRole('button', { name: 'More tabs' })).toBeNull();
  });

  it('reserves only the plain "+N more" trigger while the active tab stays in the row', () => {
    render(<PageTabs tabs={TABS} activeTab="overview" overflow="dropdown" />);
    // 320 - 80 (trigger) - 8 (gap) leaves 232: Overview and Leave fit, Attendance doesn't.
    expect(visibleTabs()).toEqual(['Overview', 'Leave']);
    expect(screen.getByRole('button', { name: 'More tabs' }).textContent).toBe('+3 more');
  });

  it('reserves the wider trigger naming the active tab when that tab overflows', () => {
    render(<PageTabs tabs={TABS} activeTab="documents" overflow="dropdown" />);
    // 320 - 200 (the "Documents & files +88" trigger) - 8 leaves 112: only Overview fits.
    expect(visibleTabs()).toEqual(['Overview']);
    const trigger = screen.getByRole('button', { name: 'More tabs' });
    expect(trigger.textContent).toBe('Documents & files+3');
    expect(trigger.querySelector('[data-testid="file-icon"]')).not.toBeNull();
  });

  it('keeps as many tabs when the trigger naming the active tab is no wider', () => {
    render(<PageTabs tabs={TABS} activeTab="payroll" overflow="dropdown" />);
    // "Payroll+88" is 100px: 320 - 100 - 8 leaves 212, still room for two tabs.
    expect(visibleTabs()).toEqual(['Overview', 'Leave']);
    expect(screen.getByRole('button', { name: 'More tabs' }).textContent).toBe('Payroll+2');
  });

  it('re-measures when the active tab changes', () => {
    const onTabChange = vi.fn();
    const { rerender } = render(
      <PageTabs tabs={TABS} activeTab="overview" overflow="dropdown" onTabChange={onTabChange} />,
    );
    expect(visibleTabs()).toEqual(['Overview', 'Leave']);
    rerender(<PageTabs tabs={TABS} activeTab="documents" overflow="dropdown" onTabChange={onTabChange} />);
    expect(visibleTabs()).toEqual(['Overview']);
  });

  it('shows every tab until the widths are measured', () => {
    rowWidth = 0;
    render(<PageTabs tabs={TABS} activeTab="overview" overflow="dropdown" />);
    expect(visibleTabs()).toHaveLength(5);
  });
});
