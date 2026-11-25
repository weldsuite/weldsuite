import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { Form } from '@weldsuite/ui/components/form';
import { en } from '@weldsuite/i18n/locales/en';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';
import { AddressFields, CheckboxField, SelectField, TextField } from './form-fields';

interface Values {
  title: string;
  agree: boolean;
  kind: string;
  address: { name: string; company: string; street: string; houseNumber: string; country: string; email: string; phone: string };
}

const address = en.weldstash.shipping.address;

function Harness({ withContact = true, required = false }: Readonly<{ withContact?: boolean; required?: boolean }>) {
  const form = useForm<Values>({
    defaultValues: { title: 'Hello', agree: false, kind: '', address: { name: '', company: '', street: '', houseNumber: '', country: 'NL', email: '', phone: '' } },
  });
  const values = form.watch();
  return (
    <Form {...form}>
      <form>
        <TextField control={form.control} name="title" label="Title" required description="Shown on top" />
        <TextField control={form.control} name="title" label="Hidden label" srOnlyLabel />
        <CheckboxField control={form.control} name="agree" label="I agree" description="Please agree" />
        <SelectField
          control={form.control}
          name="kind"
          label="Kind"
          required
          description="Pick one"
          placeholder="Choose a kind"
          options={[
            { value: 'a', label: 'Option A' },
            { value: 'b', label: 'Option B' },
          ]}
        />
        <AddressFields control={form.control} prefix="address" section="shipping" required={required} withContact={withContact} />
        <output data-testid="values">{JSON.stringify(values)}</output>
      </form>
    </Form>
  );
}

const current = () => JSON.parse(screen.getByTestId('values').textContent ?? '{}') as Values;

describe('form fields', () => {
  it('binds a text field to the form and shows the description and required marker', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const input = screen.getByLabelText(/^Title/);
    expect(input).toHaveValue('Hello');
    expect(input).toBeRequired();
    expect(screen.getByText('Shown on top')).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'World');
    expect(current().title).toBe('World');
    expect(screen.getByLabelText('Hidden label')).toBeInTheDocument();
  });

  it('toggles a checkbox field', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    expect(screen.getByText('Please agree')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'I agree' }));
    expect(current().agree).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'I agree' }));
    expect(current().agree).toBe(false);
  });

  it('picks an option in a select field', async () => {
    polyfillRadixSelect();
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    expect(screen.getByText('Choose a kind')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: /Kind/ }));
    await user.click(await screen.findByRole('option', { name: 'Option B' }));
    expect(current().kind).toBe('b');
  });

  it('renders every address field with contact details and writes to the nested path', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness required />);
    expect(screen.getByLabelText(new RegExp(`^${address.name}`))).toBeRequired();
    expect(screen.getByLabelText(new RegExp(`^${address.street}`))).toHaveAttribute('autocomplete', 'shipping address-line1');
    expect(screen.getByLabelText(address.company)).toHaveAttribute('autocomplete', 'shipping organization');
    expect(screen.getByLabelText(address.email)).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText(address.phone)).toHaveAttribute('type', 'tel');
    await user.type(screen.getByLabelText(new RegExp(`^${address.street}`)), 'Dam');
    expect(current().address.street).toBe('Dam');
  });

  it('leaves out email and phone for a sender address', () => {
    renderWithProviders(<Harness withContact={false} />);
    expect(screen.queryByLabelText(address.email)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(address.phone)).not.toBeInTheDocument();
    expect(screen.getByLabelText(address.company)).not.toBeRequired();
  });
});
