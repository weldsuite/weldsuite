import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { Tag } from 'lucide-react';
import { TagsPropertyRow } from './property-row';

const SUGGESTIONS = ['key-account', 'qa-old', 'partner'];

function renderRow(overrides: Partial<Parameters<typeof TagsPropertyRow>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <I18nProvider initialLanguage="en">
      <TagsPropertyRow
        icon={Tag}
        label="Tags"
        value={['partner']}
        onChange={onChange}
        getSuggestions={() => SUGGESTIONS}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { onChange, user: userEvent.setup() };
}

describe('TagsPropertyRow', () => {
  it('shows the applied chips and the unused existing tags while the editor is open', async () => {
    const { user } = renderRow();
    await user.click(screen.getByRole('button', { name: 'Tags' }));

    // The chip stays visible inside the open editor, with its remove button.
    expect(screen.getByText('partner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove tag partner' })).toBeInTheDocument();
    // Suggestions: existing tags not on the record yet.
    expect(screen.getByRole('button', { name: 'key-account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'qa-old' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'partner' })).not.toBeInTheDocument();
  });

  it('offers an explicit Create option for text that is not an existing tag, and Enter creates it', async () => {
    const { user, onChange } = renderRow();
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    await user.type(screen.getByRole('textbox'), 'qa-new');

    expect(screen.getByRole('button', { name: 'Create "qa-new"' })).toBeInTheDocument();
    // Existing tags are filtered by the draft.
    expect(screen.queryByRole('button', { name: 'key-account' })).not.toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(['partner', 'qa-new']);
  });

  it('clicking the Create option adds the tag without leaving the editor', async () => {
    const { user, onChange } = renderRow();
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    await user.type(screen.getByRole('textbox'), 'qa-new');
    await user.click(screen.getByRole('button', { name: 'Create "qa-new"' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(['partner', 'qa-new']);
    // The input kept focus (a blur would have closed the editor).
    expect(screen.getByRole('textbox')).toHaveFocus();
  });

  it('picks an existing tag by click or by arrow keys + Enter', async () => {
    const { user, onChange } = renderRow();
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    await user.click(screen.getByRole('button', { name: 'qa-old' }));
    expect(onChange).toHaveBeenLastCalledWith(['partner', 'qa-old']);

    // ArrowDown highlights the first row (key-account), ArrowDown again the second (qa-old).
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['partner', 'qa-old']);
  });

  it('does not offer Create for a tag that already exists, and still works without suggestions', async () => {
    const { user } = renderRow();
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    await user.type(screen.getByRole('textbox'), 'QA-OLD');
    expect(screen.getByRole('button', { name: 'qa-old' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Create/ })).not.toBeInTheDocument();
  });

  it('lists nothing but the Create row when no suggestions are provided', async () => {
    const { user, onChange } = renderRow({ getSuggestions: undefined, value: [] });
    await user.click(screen.getByRole('button', { name: 'Tags' }));
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox'), 'x');
    expect(screen.getByRole('button', { name: 'Create "x"' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(['x']);
  });
});
