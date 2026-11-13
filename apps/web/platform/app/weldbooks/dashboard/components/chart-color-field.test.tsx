import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});

import { ChartColorField } from './chart-color-field';

const tb = en.accounting.dashboard.builder;

/** jsdom has no canvas: paint every colour as the theme's chart blue. */
function paintAs(rgb: [number, number, number]) {
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect: vi.fn(),
    getImageData: () => ({ data: [...rgb, 255] }),
  } as never);
}

function renderField(value: string, onChange = vi.fn()) {
  render(<ChartColorField id="chart-color" value={value} onChange={onChange} />);
  return { onChange, input: screen.getByRole('textbox') as HTMLInputElement };
}

describe('ChartColorField', () => {
  beforeEach(() => {
    paintAs([38, 109, 240]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows the code of a theme colour as the browser paints it', () => {
    const { input } = renderField('var(--chart-1)');
    expect(input.value).toBe('#266df0');
  });

  it('shows a colour of the user’s own as it is stored, in lower case', () => {
    const { input } = renderField('#AABBCC');
    expect(input.value).toBe('#aabbcc');
  });

  it('falls back to black when there is no canvas to paint on', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { input } = renderField('var(--chart-2)');
    expect(input.value).toBe('#000000');
  });

  it('applies a typed code once it is complete, with or without the #', async () => {
    const { onChange, input } = renderField('#266df0');
    await userEvent.clear(input);
    await userEvent.type(input, 'FF00');
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.type(input, '88');
    expect(onChange).toHaveBeenLastCalledWith('#ff0088');

    await userEvent.clear(input);
    await userEvent.type(input, '#00Ff00');
    expect(onChange).toHaveBeenLastCalledWith('#00ff00');
  });

  it('shows the colour’s own code again when an unfinished one is left', async () => {
    const { onChange, input } = renderField('#266df0');
    await userEvent.clear(input);
    await userEvent.type(input, '#12zz');
    expect(input.value).toBe('#12zz');
    fireEvent.blur(input);
    expect(input.value).toBe('#266df0');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picks a theme colour from the picker, kept as its variable', async () => {
    const { onChange } = renderField('#aabbcc');
    await userEvent.click(screen.getByRole('button', { name: tb.pickColor }));

    const themes = await screen.findAllByRole('radio');
    expect(themes).toHaveLength(5);
    expect(themes.every((t) => t.getAttribute('aria-checked') === 'false')).toBe(true);

    await userEvent.click(screen.getByRole('radio', { name: tb.colorOption.replace('{n}', '3') }));
    expect(onChange).toHaveBeenCalledWith('var(--chart-3)');
  });

  it('marks the theme colour in use', async () => {
    renderField('var(--chart-2)');
    await userEvent.click(screen.getByRole('button', { name: tb.pickColor }));
    const chosen = await screen.findByRole('radio', { name: tb.colorOption.replace('{n}', '2') });
    expect(chosen).toHaveAttribute('aria-checked', 'true');
  });

  it('picks the colour under a click in the colour field, as a hex code', async () => {
    const { onChange } = renderField('#266df0');
    await userEvent.click(screen.getByRole('button', { name: tb.pickColor }));
    await screen.findAllByRole('radio');
    // Opening the picker reports its starting colour; that is not a change.
    expect(onChange).not.toHaveBeenCalled();

    // jsdom has no PointerEvent, so a press would lose its position: stand in a MouseEvent.
    if (!('PointerEvent' in window)) {
      vi.stubGlobal('PointerEvent', class extends MouseEvent {});
    }
    // jsdom lays nothing out: give the field a size, then press its bottom edge, which is black.
    const field = document.querySelector('.cursor-crosshair') as HTMLElement;
    field.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
    fireEvent.pointerDown(field, { clientX: 50, clientY: 100 });
    expect(onChange).toHaveBeenLastCalledWith('#000000');
  });
});
