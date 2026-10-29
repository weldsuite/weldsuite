import { createRef } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EN_LOCALE, NL_LOCALE } from '@weldsuite/sheets-engine';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { FormulaBar } from './formula-bar';
import { SheetController } from './model/sheet-controller';

beforeAll(() => {
  // jsdom has no layout: the list scrolls its highlighted item into view, the bar measures text.
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

function renderBar(locale: 'en' | 'nl' = 'en') {
  const controller = new SheetController(null, {
    locale: locale === 'nl' ? NL_LOCALE : EN_LOCALE,
    formulaLocale: { decimal: locale === 'nl' ? ',' : '.' },
    onOp: vi.fn(),
  });
  render(
    <I18nProvider initialLanguage={locale}>
      <FormulaBar controller={controller} inputRef={createRef<HTMLTextAreaElement>()} />
    </I18nProvider>,
  );
  return { controller, input: screen.getByRole('textbox', { name: /formula|formule/i }) as HTMLTextAreaElement };
}

const boldArgument = () => screen.getByRole('tooltip').querySelector('.font-bold')?.textContent;

describe('formula bar autocomplete', () => {
  it('lists matching functions with the highlighted one explained, and Tab takes it', async () => {
    const user = userEvent.setup();
    const { input } = renderBar();
    await user.type(input, '=vlo');

    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['VLOOKUP']);
    expect(await screen.findByText(/first column of a table/)).toBeInTheDocument();

    await user.keyboard('{Tab}');
    expect(input.value).toBe('=VLOOKUP(');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect((await screen.findByRole('tooltip')).textContent).toBe('VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])');
    expect(boldArgument()).toBe('lookup_value');

    await user.type(input, 'A1, ');
    expect(boldArgument()).toBe('table_array');
  });

  it('moves through the list with the arrow keys and closes it with Escape, keeping the edit', async () => {
    const user = userEvent.setup();
    const { input, controller } = renderBar();
    await user.type(input, '=sum');
    const options = () => within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(controller.editing?.text).toBe('=sum');
  });

  it('spells out repeating arguments as they are typed', async () => {
    const user = userEvent.setup();
    const { input } = renderBar();
    await user.type(input, '=SUM(1, 2, ');
    expect((await screen.findByRole('tooltip')).textContent).toBe('SUM(number1, [number2], [number3], …)');
    expect(boldArgument()).toBe('[number3]');
  });

  it('shows Dutch argument names with the Dutch separator', async () => {
    const user = userEvent.setup();
    const { input } = renderBar('nl');
    await user.type(input, '=VLOOKUP(A1; ');
    expect((await screen.findByRole('tooltip')).textContent).toBe('VLOOKUP(zoekwaarde; tabelmatrix; kolomindex_getal; [benaderen])');
    expect(boldArgument()).toBe('tabelmatrix');
  });
});
