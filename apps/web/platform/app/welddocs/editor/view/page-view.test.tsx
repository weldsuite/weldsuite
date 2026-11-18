import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { BODY, MetricsMeasurer } from '@weldsuite/docs-engine';
import { DocController } from '../model/doc-controller';

vi.mock('@/lib/i18n/provider', async () => {
  const { en } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: en, language: 'en' }) };
});

import { PageView } from './page-view';

beforeAll(() => {
  // jsdom has no ResizeObserver; the view only needs it to exist.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function View({ controller }: { controller: DocController }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref}>
      <PageView controller={controller} scrollRef={ref} />
    </div>
  );
}

/** A document with one line of text, the caret at its end. */
function makeDoc(text = 'Hello world') {
  const controller = new DocController(null, { onOp: vi.fn(), measurer: new MetricsMeasurer() });
  for (const ch of text) controller.type(ch);
  return controller;
}

const typingField = () => screen.getByRole('textbox', { name: 'WeldDocs' });
/** The opacity of everything around a drawn piece of text. */
function opacityOf(text: string): number {
  let el: HTMLElement | null = screen.getByText(text);
  let o = 1;
  while (el) {
    if (el.classList.contains('opacity-50')) o *= 0.5;
    el = el.parentElement;
  }
  return o;
}

describe('PageView', () => {
  it('draws the text with a black caret on the white page, and takes typing', () => {
    const ctl = makeDoc();
    const { container } = render(<View controller={ctl} />);

    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(document.activeElement).toBe(typingField());
    const caret = container.querySelector<HTMLElement>('.animate-\\[welddocs-caret_1\\.1s_steps\\(1\\)_infinite\\]');
    expect(caret?.style.background).toBe('rgb(0, 0, 0)');

    fireEvent.keyDown(typingField(), { key: 'b', ctrlKey: true });
    expect(ctl.isActive('bold')).toBe(true);
  });

  it('adds a link at the text, and typing goes on in the document afterwards', async () => {
    const user = userEvent.setup();
    const ctl = makeDoc();
    render(<View controller={ctl} />);

    ctl.setSelection({ story: BODY, anchor: 6, head: 11 });
    act(() => ctl.openDialog('link'));
    await user.type(await screen.findByPlaceholderText('Paste a link or type an address'), 'weldsuite.org{Enter}');

    expect(ctl.dialog).toBeNull();
    expect(document.activeElement).toBe(typingField());
  });

  it('shows the link the caret is on, until Esc, and again after a click', async () => {
    const user = userEvent.setup();
    const ctl = makeDoc();
    ctl.setSelection({ story: BODY, anchor: 6, head: 11 });
    ctl.setLink('https://weldsuite.org');
    ctl.setSelection({ story: BODY, anchor: 8, head: 8 });
    const { container } = render(<View controller={ctl} />);

    expect(await screen.findByRole('link', { name: 'weldsuite.org' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('link', { name: 'weldsuite.org' })).not.toBeInTheDocument();

    // A click back in the page (here: where the caret already is) brings it back.
    const page = container.querySelector<HTMLElement>('[data-page="0"]')!;
    vi.spyOn(ctl, 'clickAt').mockImplementation(() => {});
    fireEvent.mouseDown(page, { button: 0, detail: 1 });
    expect(await screen.findByRole('link', { name: 'weldsuite.org' })).toBeInTheDocument();
  });

  it('fades only the page text while the header is edited', () => {
    const ctl = makeDoc('Body text');
    ctl.editHeader('header');
    for (const ch of 'Head') ctl.type(ch);
    render(<View controller={ctl} />);

    expect(opacityOf('Head')).toBe(1);
    expect(opacityOf('Body text')).toBe(0.5);
    expect(screen.getByText('Header')).toBeInTheDocument();
  });

  it('marks the text of a comment being written in yellow alone', () => {
    const ctl = makeDoc();
    ctl.setSelection({ story: BODY, anchor: 0, head: 5 });
    ctl.draft = ctl.selection;
    const { container } = render(<View controller={ctl} />);

    const fills = [...container.querySelectorAll<HTMLElement>('[data-page] div')].map((d) => d.style.background);
    expect(fills).toContain('rgba(251, 188, 4, 0.55)');
    expect(fills).not.toContain('rgba(66, 133, 244, 0.3)');
  });

  it('opens the right-click menu and gives typing back when it closes', async () => {
    const user = userEvent.setup();
    const ctl = makeDoc();
    render(<View controller={ctl} />);

    act(() => ctl.openContextMenu({ x: 20, y: 20 }));
    expect(await screen.findByRole('menuitem', { name: /Paste/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    expect(ctl.contextMenu).toBeNull();
    expect(document.activeElement).toBe(typingField());
  });
});
