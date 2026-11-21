import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns], getLocale: () => 'en' };
});
const breadcrumbs = vi.hoisted(() => vi.fn());
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: breadcrumbs }));
// The chart wrappers come from the UI library, which has its own Recharts: stand in for them.
vi.mock('@weldsuite/ui/components/chart', () => ({
  ChartContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
}));
// Frames render inline here: their own behaviour has its own test.
vi.mock('./themed-frame', () => ({
  ThemedFrame: ({ title, children }: { title: string; children: ReactNode }) => (
    <section data-testid="frame" aria-label={title}>
      {children}
    </section>
  ),
}));
vi.mock('./try-with-ai', () => ({
  TryWithAi: ({ onOpen }: { onOpen: (visual: unknown) => void }) => (
    <button
      type="button"
      onClick={() => onOpen({ type: 'stats', title: 'From the AI', items: [{ label: 'Leads', value: 7 }] })}
    >
      open from ai
    </button>
  ),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
// Record cards: no live lookups or panels in the gallery, but the hooks still run.
vi.mock('@/app/weldchat/hooks/use-entity-title', () => ({
  hasEntityTitleLookup: () => true,
  useEntityTitle: () => ({ status: 'loading', title: null }),
}));
vi.mock('@/components/object-panel/use-object-panel', () => ({ useObjectPanel: () => ({ open: vi.fn() }) }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const flag = vi.hoisted(() => ({ value: undefined as boolean | undefined }));
vi.mock('@/hooks/queries/use-feature-flags-queries', () => ({ useFeatureFlagStatus: () => flag.value }));

import ChatVisualsGalleryPage from './page';

function editor(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Spec' }) as HTMLTextAreaElement;
}

beforeEach(() => {
  flag.value = true;
  toast.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the gallery behind its flag', () => {
  it('waits for the flag, and says the page is not available when it is off', () => {
    vi.stubEnv('DEV', false);
    flag.value = undefined;
    const { rerender } = render(<ChatVisualsGalleryPage />);
    // Neither the gallery nor the refusal while the flag loads.
    expect(screen.queryByRole('navigation', { name: 'Examples' })).toBeNull();
    expect(screen.queryByText('This page is not available in your workspace.')).toBeNull();
    flag.value = false;
    rerender(<ChatVisualsGalleryPage />);
    expect(screen.getByText('This page is not available in your workspace.')).toBeTruthy();
  });

  it('opens when the flag is on, under AI Agents in the breadcrumbs', () => {
    vi.stubEnv('DEV', false);
    render(<ChatVisualsGalleryPage />);
    expect(screen.getByRole('navigation', { name: 'Examples' })).toBeTruthy();
    expect(breadcrumbs).toHaveBeenCalledWith([{ label: 'AI Agents', href: '/agents' }, { label: 'Chat visuals' }]);
  });
});

describe('the gallery', () => {
  it('shows the first example in the editor, live and in a light and a dark frame', () => {
    render(<ChatVisualsGalleryPage />);
    expect(JSON.parse(editor().value)).toMatchObject({ type: 'chart', kind: 'bar', title: 'Open tickets per status' });
    expect(screen.getAllByTestId('frame').map((frame) => frame.getAttribute('aria-label'))).toEqual([
      'Light 720px',
      'Dark 720px',
    ]);
    expect(screen.getByText('Valid spec')).toBeTruthy();
  });

  it('switches examples and widths', () => {
    render(<ChatVisualsGalleryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Stat tiles' }));
    expect(JSON.parse(editor().value).type).toBe('stats');
    expect(screen.getAllByText('This month so far').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('radio', { name: 'All widths' }));
    expect(screen.getAllByTestId('frame')).toHaveLength(6);
    fireEvent.click(screen.getByRole('radio', { name: 'Phone' }));
    expect(screen.getAllByTestId('frame').map((frame) => frame.getAttribute('aria-label'))).toEqual([
      'Light 375px',
      'Dark 375px',
    ]);
  });

  it('draws an edited spec, explains an invalid one and keeps the last good one meanwhile', () => {
    render(<ChatVisualsGalleryPage />);
    const spec = JSON.parse(editor().value);
    fireEvent.change(editor(), { target: { value: JSON.stringify({ ...spec, title: 'Edited title' }) } });
    expect(screen.getAllByText('Edited title').length).toBeGreaterThan(0);

    fireEvent.change(editor(), { target: { value: JSON.stringify({ ...spec, labels: ['one'] }) } });
    expect(screen.getByText('This spec cannot be shown:')).toBeTruthy();
    expect(screen.getAllByText('Edited title').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(JSON.parse(editor().value).title).toBe('Open tickets per status');
  });

  it('toggles chart options in the spec', () => {
    render(<ChatVisualsGalleryPage />);
    fireEvent.click(screen.getByRole('switch', { name: 'Stacked' }));
    expect(JSON.parse(editor().value).stacked).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: 'Stacked' }));
    expect(JSON.parse(editor().value)).not.toHaveProperty('stacked');
    fireEvent.click(screen.getByRole('switch', { name: 'Horizontal bars' }));
    expect(JSON.parse(editor().value).horizontal).toBe(true);
  });

  it('copies the spec', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ChatVisualsGalleryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy spec' }));
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('Spec copied'));
    expect(writeText).toHaveBeenCalledWith(editor().value);
  });

  it('shows what asking about a tile would write, with sample records that do not open', () => {
    render(<ChatVisualsGalleryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Stat tiles' }));
    const interactive = screen.getByText('Interactive').closest('section')!;
    fireEvent.click(within(interactive).getByText('Revenue'));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Would write in the composer: Tell me more about “Revenue”'));

    fireEvent.click(screen.getByRole('button', { name: 'Record cards' }));
    expect(within(interactive).queryAllByRole('button', { name: /Open / })).toHaveLength(0);
  });

  it('opens a spec the AI produced in the editor', () => {
    render(<ChatVisualsGalleryPage />);
    // Radix tabs switch on mouse down.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Try with AI' }), { button: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'open from ai' }));
    expect(JSON.parse(editor().value).title).toBe('From the AI');
  });
});
