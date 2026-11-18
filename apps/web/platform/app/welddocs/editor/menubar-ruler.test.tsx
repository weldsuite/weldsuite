import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { MetricsMeasurer } from '@weldsuite/docs-engine';
import { DocController } from './model/doc-controller';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/contexts/preview-mode-context', () => ({ usePreviewMode: () => false }));
vi.mock('../use-doc-files', () => ({ useDocDownload: () => vi.fn() }));

import { Menubar } from './menubar';
import { Ruler } from './ruler';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const makeController = () => new DocController(null, { onOp: vi.fn(), measurer: new MetricsMeasurer() });

describe('Menubar', () => {
  it('shows each shortcut at the right of its command, also where the name carries it', async () => {
    const user = userEvent.setup();
    render(<Menubar controller={makeController()} name="Plan" />);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const find = await screen.findByRole('menuitem', { name: /Find and replace/ });
    // Outside a Mac (as here): Ctrl+H.
    expect(find.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent).toBe('Ctrl+H');
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Format' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Align and indent' }));
    const left = await screen.findByRole('menuitem', { name: /Left align/ });
    expect(left.firstChild?.textContent).toBe('Left align');
    expect(left.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent).toBe('Ctrl+Shift+L');
  });
});

describe('Ruler', () => {
  function WithScrollArea({ controller, outline }: { controller: DocController; outline: number }) {
    const ref = useRef<HTMLDivElement>(null);
    return (
      <div>
        <Ruler controller={controller} scrollRef={ref} />
        <div style={{ display: 'flex' }}>
          <div style={{ width: outline }} />
          <div ref={ref} data-testid="scroll" />
        </div>
      </div>
    );
  }

  it('moves the page band right by the room the outline takes', () => {
    const ctl = makeController();
    const original = Element.prototype.getBoundingClientRect;
    // The scroll area starts 200px right of the ruler, as with the outline open.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const left = (this as HTMLElement).dataset.testid === 'scroll' ? 200 : 0;
      return { left, top: 0, right: left, bottom: 0, width: 0, height: 0, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    };
    try {
      const { container } = render(<WithScrollArea controller={ctl} outline={200} />);
      const band = container.querySelector<HTMLElement>('.bg-background.absolute');
      expect(Number.parseFloat(band!.style.left)).toBeGreaterThanOrEqual(200);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });
});
