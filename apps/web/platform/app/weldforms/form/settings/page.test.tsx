import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { FormEditor } from '../editor-context';
import FormSettingsTab from './page';

const ts = en.weldforms.formSettings;

type Settings = Record<string, unknown>;

const navigate = vi.fn();
const patchSettings = vi.fn();
const editDraft = vi.fn();
const routerPush = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const setAccessMutateAsync = vi.fn();
const setSubscriptionMutate = vi.fn();
const deleteMutateAsync = vi.fn();

let search: Record<string, unknown> = {};
let editor: FormEditor;
let accessData: Array<{ user: { userId: string; name: string | null; email: string }; role: 'editor' | 'results' }> | undefined;
let members: Array<{ userId: string; name: string; email: string | null; picture: null }>;
let subscriptionData: { mode: 'instant' | 'daily' | 'off' } | undefined;
let subscriptionLoading = false;

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => search,
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ t: en }),
}));

vi.mock('@/lib/i18n/date-locale', () => ({
  useDateLocale: () => ({ dateFnsLocale: undefined }),
}));

vi.mock('sonner', () => ({
  toast: { error: (message: string) => toastError(message), success: (message: string) => toastSuccess(message) },
}));

vi.mock('../editor-context', () => ({
  useFormEditor: () => editor,
}));

vi.mock('../../lib/use-members', () => ({
  useFormsMembers: () => ({ members, memberById: new Map(), currentUserId: 'u0', isLoading: false }),
}));

vi.mock('@/hooks/queries/use-weldforms-queries', () => ({
  useFormAccess: () => ({ data: accessData }),
  useSetFormAccess: () => ({ mutateAsync: setAccessMutateAsync }),
  useFormSubscription: () => ({ data: subscriptionData, isLoading: subscriptionLoading }),
  useSetFormSubscription: () => ({ mutate: setSubscriptionMutate, isPending: false }),
  useDeleteForm: () => ({ mutateAsync: deleteMutateAsync }),
}));

// Radix selects need pointer APIs jsdom lacks; a native select keeps the same value/onValueChange contract.
vi.mock('@weldsuite/ui/components/select', () => ({
  Select: ({ value, onValueChange, disabled, children }: { value: string; onValueChange: (value: string) => void; disabled?: boolean; children: ReactNode }) => {
    const trigger = Children.toArray(children).find((child): child is ReactElement<{ 'aria-label'?: string }> => isValidElement(child) && 'aria-label' in (child.props as object));
    return (
      <select aria-label={trigger?.props['aria-label']} value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)}>
        {children}
      </select>
    );
  },
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));

vi.mock('@weldsuite/ui/components/date-time-picker', () => ({
  DateTimePicker: ({ id, value, onChange, placeholder }: { id: string; value: Date | undefined; onChange: (date: Date | undefined) => void; placeholder: string }) => (
    <div>
      <button type="button" data-testid={id} onClick={() => onChange(new Date(2030, 0, 2, 3, 4))}>
        {value ? `${id}:set` : placeholder}
      </button>
      <button type="button" data-testid={`${id}-clear`} onClick={() => onChange(undefined)}>
        clear
      </button>
    </div>
  ),
}));

interface EditorOptions {
  settings?: Settings;
  canEdit?: boolean;
  access?: 'workspace' | 'restricted';
  permissions?: Partial<Record<'readResponses' | 'delete' | 'manageAccess', boolean>>;
}

function makeEditor({ settings = {}, canEdit = true, access = 'workspace', permissions = {} }: EditorOptions = {}): FormEditor {
  return {
    form: {
      id: 'form_1',
      owner: { userId: 'u0', name: 'Olivia Owner', email: 'olivia@example.com' },
      permissions: { readResponses: true, delete: true, manageAccess: true, ...permissions },
    },
    draft: { access },
    settings: {
      respondentMode: 'anyone',
      onePerRespondent: false,
      allowEdit: false,
      hideMemberIdentity: false,
      sendReceipt: false,
      collectPartial: false,
      opensAt: null,
      closesAt: null,
      responseLimit: null,
      closedMessage: null,
      allowedEmbedDomains: [],
      ...settings,
    },
    canEdit,
    patchSettings,
    editDraft,
  } as unknown as FormEditor;
}

function setup(options: EditorOptions = {}, section?: string) {
  editor = makeEditor(options);
  search = section === undefined ? {} : { section };
  return render(<FormSettingsTab />);
}

/** The native select that offers the given option text. */
function selectWith(optionText: string): HTMLSelectElement {
  const found = screen.getAllByRole('combobox').find((el) => within(el).queryByText(optionText));
  if (!found) throw new Error(`no select offers "${optionText}"`);
  return found as HTMLSelectElement;
}

describe('WeldForms form Settings tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    search = {};
    accessData = [];
    subscriptionData = undefined;
    subscriptionLoading = false;
    members = [
      { userId: 'u0', name: 'Olivia Owner', email: 'olivia@example.com', picture: null },
      { userId: 'u1', name: 'Alice', email: 'alice@example.com', picture: null },
      { userId: 'u2', name: 'Bob', email: 'bob@example.com', picture: null },
      { userId: 'u3', name: 'carol@example.com', email: 'carol@example.com', picture: null },
    ];
    setAccessMutateAsync.mockResolvedValue({ data: [] });
    deleteMutateAsync.mockResolvedValue(undefined);
  });

  describe('section column', () => {
    it('lists every section for a member who can read responses and delete', () => {
      setup();
      const nav = screen.getByRole('navigation', { name: en.weldforms.tabs.settings });
      for (const label of [ts.respondents, ts.responses, ts.embed, ts.access, ts.notifications, ts.danger]) {
        expect(within(nav).getByRole('button', { name: label })).toBeTruthy();
      }
    });

    it('hides Notifications without readResponses and the danger zone without delete', () => {
      setup({ permissions: { readResponses: false, delete: false } });
      const nav = screen.getByRole('navigation', { name: en.weldforms.tabs.settings });
      expect(within(nav).queryByRole('button', { name: ts.notifications })).toBeNull();
      expect(within(nav).queryByRole('button', { name: ts.danger })).toBeNull();
      expect(within(nav).getByRole('button', { name: ts.access })).toBeTruthy();
    });

    it('opens Respondents first and marks it current', () => {
      setup();
      expect(screen.getByRole('heading', { name: ts.respondents })).toBeTruthy();
      expect(screen.getByText(ts.respondentsDescription)).toBeTruthy();
      expect(screen.getByRole('button', { name: ts.respondents }).getAttribute('aria-current')).toBe('page');
      expect(screen.getByRole('button', { name: ts.embed }).getAttribute('aria-current')).toBeNull();
    });

    it('opens the section named in ?section=', () => {
      setup({}, 'embed');
      expect(screen.getByRole('heading', { name: ts.embed })).toBeTruthy();
      expect(screen.getByText(ts.allowedDomains)).toBeTruthy();
    });

    it('falls back to Respondents for an unknown section', () => {
      setup({}, 'nonsense');
      expect(screen.getByRole('heading', { name: ts.respondents })).toBeTruthy();
    });

    it('falls back to Respondents when the section is not offered to this member', () => {
      setup({ permissions: { delete: false } }, 'danger');
      expect(screen.getByRole('heading', { name: ts.respondents })).toBeTruthy();
    });

    it('navigates with a search function that sets the section', () => {
      setup();
      fireEvent.click(screen.getByRole('button', { name: ts.responses }));

      expect(navigate).toHaveBeenCalledTimes(1);
      const call = navigate.mock.calls[0][0] as { to: string; replace: boolean; search: (prev: Record<string, unknown>) => Record<string, unknown> };
      expect(call.to).toBe('.');
      expect(call.replace).toBe(true);
      expect(call.search({ tab: 'settings' })).toEqual({ tab: 'settings', section: 'responses' });
    });

    it('also picks sections from the select shown on small screens', () => {
      setup();
      fireEvent.change(screen.getByRole('combobox', { name: en.weldforms.tabs.settings }), { target: { value: 'access' } });
      const call = navigate.mock.calls[0][0] as { search: (prev: Record<string, unknown>) => Record<string, unknown> };
      expect(call.search({})).toEqual({ section: 'access' });
    });

    it('shows a read-only banner when the member cannot edit', () => {
      setup({ canEdit: false });
      expect(screen.getByText(en.weldforms.editor.readOnly)).toBeTruthy();
      expect(screen.getByRole('switch', { name: ts.onePerBrowser })).toBeDisabled();
    });

    it('shows no banner when the member can edit', () => {
      setup();
      expect(screen.queryByText(en.weldforms.editor.readOnly)).toBeNull();
    });
  });

  describe('Respondents', () => {
    it('labels the one-per toggle by mode', () => {
      const { unmount } = setup({ settings: { respondentMode: 'anyone' } });
      expect(screen.getByText(ts.onePerBrowser)).toBeTruthy();
      expect(screen.getByText(ts.onePerBrowserNote)).toBeTruthy();
      unmount();

      const second = setup({ settings: { respondentMode: 'members' } });
      expect(screen.getByText(ts.onePerMember)).toBeTruthy();
      expect(screen.queryByText(ts.onePerBrowserNote)).toBeNull();
      second.unmount();

      setup({ settings: { respondentMode: 'verified_email' } });
      expect(screen.getByText(ts.onePerEmail)).toBeTruthy();
    });

    it('shows the help text of the current mode', () => {
      setup({ settings: { respondentMode: 'members' } });
      expect(screen.getByText(ts.modes.members.help)).toBeTruthy();
    });

    it('switches the mode-only options off when leaving verified_email for anyone', () => {
      setup({ settings: { respondentMode: 'verified_email', allowEdit: true, sendReceipt: true } });
      fireEvent.change(selectWith(ts.modes.anyone.label), { target: { value: 'anyone' } });
      expect(patchSettings).toHaveBeenCalledWith({ respondentMode: 'anyone', allowEdit: false, hideMemberIdentity: false, sendReceipt: false });
    });

    it('switches allowEdit off when moving to members', () => {
      setup({ settings: { respondentMode: 'verified_email', allowEdit: true } });
      fireEvent.change(selectWith(ts.modes.members.label), { target: { value: 'members' } });
      expect(patchSettings).toHaveBeenCalledWith({ respondentMode: 'members', allowEdit: false });
    });

    it('switches hideMemberIdentity off when moving from members to verified_email', () => {
      setup({ settings: { respondentMode: 'members', hideMemberIdentity: true } });
      fireEvent.change(selectWith(ts.modes.members.label), { target: { value: 'verified_email' } });
      expect(patchSettings).toHaveBeenCalledWith({ respondentMode: 'verified_email', hideMemberIdentity: false });
    });

    it('shows the allow-edit toggle only for verified email and patches it', () => {
      const { unmount } = setup({ settings: { respondentMode: 'anyone' } });
      expect(screen.queryByText(ts.allowEdit)).toBeNull();
      expect(screen.queryByText(ts.hideIdentity)).toBeNull();
      unmount();

      setup({ settings: { respondentMode: 'verified_email' } });
      fireEvent.click(screen.getByRole('switch', { name: ts.allowEdit }));
      expect(patchSettings).toHaveBeenCalledWith({ allowEdit: true });
    });

    it('shows the hide-identity toggle only for members and patches it', () => {
      setup({ settings: { respondentMode: 'members' } });
      fireEvent.click(screen.getByRole('switch', { name: ts.hideIdentity }));
      expect(patchSettings).toHaveBeenCalledWith({ hideMemberIdentity: true });
    });

    it('patches one-per-respondent', () => {
      setup();
      fireEvent.click(screen.getByRole('switch', { name: ts.onePerBrowser }));
      expect(patchSettings).toHaveBeenCalledWith({ onePerRespondent: true });
    });

    it('disables the receipt toggle for anyone and enables it otherwise', () => {
      const { unmount } = setup({ settings: { respondentMode: 'anyone' } });
      expect(screen.getByRole('switch', { name: ts.sendReceipt })).toBeDisabled();
      expect(screen.getByText(ts.sendReceiptVerifiedOnly)).toBeTruthy();
      unmount();

      setup({ settings: { respondentMode: 'members' } });
      const receipt = screen.getByRole('switch', { name: ts.sendReceipt });
      expect(receipt).not.toBeDisabled();
      expect(screen.getByText(ts.sendReceiptHelp)).toBeTruthy();
      fireEvent.click(receipt);
      expect(patchSettings).toHaveBeenCalledWith({ sendReceipt: true });
    });
  });

  describe('Responses', () => {
    it('patches collect-partial', () => {
      setup({}, 'responses');
      fireEvent.click(screen.getByRole('switch', { name: ts.collectPartial }));
      expect(patchSettings).toHaveBeenCalledWith({ collectPartial: true });
    });

    it('patches the opening and closing dates as ISO timestamps, or null when cleared', () => {
      setup({ settings: { opensAt: '2029-05-01T10:00:00+00:00' } }, 'responses');
      expect(screen.getByTestId('settings-opens-at').textContent).toBe('settings-opens-at:set');
      expect(screen.getByTestId('settings-closes-at').textContent).toBe(ts.noDate);

      fireEvent.click(screen.getByTestId('settings-opens-at'));
      expect(patchSettings).toHaveBeenLastCalledWith({ opensAt: expect.stringMatching(/^2030-01-02T03:04:00[+-]\d{2}:\d{2}$/) });

      fireEvent.click(screen.getByTestId('settings-closes-at'));
      expect(patchSettings).toHaveBeenLastCalledWith({ closesAt: expect.stringMatching(/^2030-01-02T03:04:00[+-]\d{2}:\d{2}$/) });

      fireEvent.click(screen.getByTestId('settings-opens-at-clear'));
      expect(patchSettings).toHaveBeenLastCalledWith({ opensAt: null });
      fireEvent.click(screen.getByTestId('settings-closes-at-clear'));
      expect(patchSettings).toHaveBeenLastCalledWith({ closesAt: null });
    });

    it('holds back a closing time before the opening time, with an error on it', () => {
      setup({ settings: { opensAt: '2030-05-01T10:00:00+00:00' } }, 'responses');
      fireEvent.click(screen.getByTestId('settings-closes-at'));
      expect(patchSettings).not.toHaveBeenCalled();
      expect(screen.getByText(ts.closesBeforeOpens)).toBeTruthy();
      // Clearing the opening time saves both.
      fireEvent.click(screen.getByTestId('settings-opens-at-clear'));
      expect(patchSettings).toHaveBeenLastCalledWith({ opensAt: null, closesAt: expect.stringMatching(/^2030-01-02T03:04:00[+-]\d{2}:\d{2}$/) });
      expect(screen.queryByText(ts.closesBeforeOpens)).toBeNull();
    });

    it('treats an unparseable stored date as no date', () => {
      setup({ settings: { opensAt: 'garbage' } }, 'responses');
      expect(screen.getByTestId('settings-opens-at').textContent).toBe(ts.noDate);
    });

    it('patches the response limit as a whole number of at least 1, or null when emptied', () => {
      setup({ settings: { responseLimit: 5 } }, 'responses');
      const input = screen.getByRole('spinbutton');
      expect((input as HTMLInputElement).value).toBe('5');

      fireEvent.change(input, { target: { value: '7' } });
      expect(patchSettings).toHaveBeenLastCalledWith({ responseLimit: 7 });
      fireEvent.change(input, { target: { value: '3.7' } });
      expect(patchSettings).toHaveBeenLastCalledWith({ responseLimit: 3 });
      fireEvent.change(input, { target: { value: '0' } });
      expect(patchSettings).toHaveBeenLastCalledWith({ responseLimit: 1 });
      fireEvent.change(input, { target: { value: '' } });
      expect(patchSettings).toHaveBeenLastCalledWith({ responseLimit: null });
    });

    it('patches the closed message, or null when emptied', () => {
      setup({ settings: { closedMessage: 'Closed' } }, 'responses');
      const textarea = screen.getByRole('textbox');
      expect((textarea as HTMLTextAreaElement).value).toBe('Closed');

      fireEvent.change(textarea, { target: { value: 'Thanks, we are done' } });
      expect(patchSettings).toHaveBeenLastCalledWith({ closedMessage: 'Thanks, we are done' });
      fireEvent.change(textarea, { target: { value: '' } });
      expect(patchSettings).toHaveBeenLastCalledWith({ closedMessage: null });
    });

    it('disables the fields when the member cannot edit', () => {
      setup({ canEdit: false }, 'responses');
      expect(screen.getByRole('spinbutton')).toBeDisabled();
      expect(screen.getByRole('textbox')).toBeDisabled();
    });
  });

  describe('Embed', () => {
    it('shows the stored domains one per line', () => {
      setup({ settings: { allowedEmbedDomains: ['a.com', 'b.org'] } }, 'embed');
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('a.com\nb.org');
    });

    it('parses typed domains and patches the valid ones', () => {
      setup({}, 'embed');
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'https://Example.com/page, sub.example.org' } });
      expect(patchSettings).toHaveBeenLastCalledWith({ allowedEmbedDomains: ['example.com', 'sub.example.org'] });
      expect(screen.queryByText(/Not a domain name/)).toBeNull();
    });

    it('shows the invalid-domain error and still patches the valid domains', () => {
      setup({}, 'embed');
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'good.com, not_a_domain' } });
      expect(patchSettings).toHaveBeenLastCalledWith({ allowedEmbedDomains: ['good.com'] });
      expect(screen.getByText(ts.invalidDomains.replace('{domains}', 'not_a_domain'))).toBeTruthy();
    });

    it('keeps at most 50 domains', () => {
      setup({}, 'embed');
      const many = Array.from({ length: 60 }, (_, i) => `site${i}.com`).join('\n');
      fireEvent.change(screen.getByRole('textbox'), { target: { value: many } });
      const patch = patchSettings.mock.calls.at(-1)?.[0] as { allowedEmbedDomains: string[] };
      expect(patch.allowedEmbedDomains).toHaveLength(50);
    });

    it('goes back to the stored domains on blur', () => {
      setup({ settings: { allowedEmbedDomains: ['stored.com'] } }, 'embed');
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'typed.com' } });
      expect(textarea.value).toBe('typed.com');
      fireEvent.blur(textarea);
      expect(textarea.value).toBe('stored.com');
    });

    it('is read-only without edit rights', () => {
      setup({ canEdit: false }, 'embed');
      expect(screen.getByRole('textbox')).toBeDisabled();
    });
  });

  describe('Access', () => {
    const alice = { user: { userId: 'u1', name: 'Alice', email: 'alice@example.com' }, role: 'editor' as const };

    it('lets a workspace form be switched to restricted through the draft', () => {
      setup({ access: 'workspace' }, 'access');
      expect(screen.getByText(ts.accessWorkspaceHelp)).toBeTruthy();
      expect(screen.queryByText(ts.owner)).toBeNull();

      fireEvent.change(selectWith(ts.accessRestricted), { target: { value: 'restricted' } });
      expect(editDraft).toHaveBeenCalledTimes(1);
      const recipe = editDraft.mock.calls[0][0] as (draft: { access: string; other: number }) => { access: string; other: number };
      expect(recipe({ access: 'workspace', other: 1 })).toEqual({ access: 'restricted', other: 1 });
    });

    it('disables the access select without manageAccess', () => {
      setup({ permissions: { manageAccess: false } }, 'access');
      expect(selectWith(ts.accessRestricted)).toBeDisabled();
    });

    it('shows the owner row and the people with access when restricted', () => {
      accessData = [alice, { user: { userId: 'u2', name: null, email: 'nameless@example.com' }, role: 'results' }];
      setup({ access: 'restricted' }, 'access');

      expect(screen.getByText(ts.accessRestrictedHelp)).toBeTruthy();
      expect(screen.getByText('Olivia Owner')).toBeTruthy();
      expect(screen.getByText(ts.owner)).toBeTruthy();
      expect(screen.getByText('Alice')).toBeTruthy();
      expect(screen.getByText('nameless@example.com')).toBeTruthy();
      expect(screen.getByText(ts.manageAlways)).toBeTruthy();
      const roles = screen.getAllByRole('combobox', { name: ts.role }) as HTMLSelectElement[];
      expect(roles.map((r) => r.value)).toEqual(['editor', 'results']);
    });

    it('falls back to the owner email when the owner has no name', () => {
      editor = makeEditor({ access: 'restricted' });
      (editor.form.owner as { name: string | null }).name = null;
      search = { section: 'access' };
      render(<FormSettingsTab />);
      expect(screen.getByText('olivia@example.com')).toBeTruthy();
    });

    it('changes a role and saves the whole list', async () => {
      accessData = [alice, { user: { userId: 'u2', name: 'Bob', email: 'bob@example.com' }, role: 'editor' }];
      setup({ access: 'restricted' }, 'access');

      fireEvent.change(screen.getAllByRole('combobox', { name: ts.role })[0], { target: { value: 'results' } });
      await waitFor(() =>
        expect(setAccessMutateAsync).toHaveBeenCalledWith({
          entries: [
            { userId: 'u1', role: 'results' },
            { userId: 'u2', role: 'editor' },
          ],
        }),
      );
    });

    it('removes a person from the list', async () => {
      accessData = [alice, { user: { userId: 'u2', name: 'Bob', email: 'bob@example.com' }, role: 'results' }];
      setup({ access: 'restricted' }, 'access');

      fireEvent.click(screen.getAllByRole('button', { name: en.common.actions.remove })[0]);
      await waitFor(() => expect(setAccessMutateAsync).toHaveBeenCalledWith({ entries: [{ userId: 'u2', role: 'results' }] }));
    });

    it('adds a member who is not on the list yet as an editor', async () => {
      accessData = [alice];
      setup({ access: 'restricted' }, 'access');

      fireEvent.click(screen.getByRole('button', { name: ts.addMember }));
      // The owner and Alice already have access, so only Bob and Carol are offered.
      expect(screen.queryByText('Olivia Owner', { selector: 'button *' })).toBeNull();
      expect(screen.getByText('Bob')).toBeTruthy();
      expect(screen.getByText('bob@example.com')).toBeTruthy();
      // Carol's name is her email: shown once.
      expect(screen.getAllByText('carol@example.com')).toHaveLength(1);

      fireEvent.click(screen.getByText('Bob'));
      await waitFor(() =>
        expect(setAccessMutateAsync).toHaveBeenCalledWith({
          entries: [
            { userId: 'u1', role: 'editor' },
            { userId: 'u2', role: 'editor' },
          ],
        }),
      );
    });

    it('disables adding when everyone already has access', () => {
      members = [members[0], members[1]];
      accessData = [alice];
      setup({ access: 'restricted' }, 'access');
      expect(screen.getByRole('button', { name: ts.addMember })).toBeDisabled();
    });

    it('reports a failed save', async () => {
      accessData = [alice];
      setAccessMutateAsync.mockRejectedValueOnce(new Error('boom'));
      setup({ access: 'restricted' }, 'access');

      fireEvent.click(screen.getByRole('button', { name: en.common.actions.remove }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(ts.accessSaveFailed));
    });

    it('treats a list that has not loaded as empty', () => {
      accessData = undefined;
      setup({ access: 'restricted' }, 'access');
      expect(screen.getByText(ts.owner)).toBeTruthy();
      expect(screen.queryAllByRole('combobox', { name: ts.role })).toHaveLength(0);
    });

    it('hides add and remove and disables roles without manageAccess', () => {
      accessData = [alice];
      setup({ access: 'restricted', permissions: { manageAccess: false } }, 'access');
      expect(screen.queryByRole('button', { name: ts.addMember })).toBeNull();
      expect(screen.queryByRole('button', { name: en.common.actions.remove })).toBeNull();
      expect(screen.getByRole('combobox', { name: ts.role })).toBeDisabled();
    });
  });

  describe('Notifications', () => {
    it('shows the current mode and saves a new one', () => {
      subscriptionData = { mode: 'daily' };
      setup({}, 'notifications');

      const select = selectWith(ts.notifyModes.instant);
      expect(select.value).toBe('daily');
      fireEvent.change(select, { target: { value: 'instant' } });
      expect(setSubscriptionMutate).toHaveBeenCalledWith({ mode: 'instant' }, expect.objectContaining({ onError: expect.any(Function) }));
    });

    it('defaults to off before the setting loads and disables the select while loading', () => {
      subscriptionLoading = true;
      setup({}, 'notifications');
      const select = selectWith(ts.notifyModes.off);
      expect(select.value).toBe('off');
      expect(select).toBeDisabled();
    });

    it('reports a failed save', () => {
      subscriptionData = { mode: 'off' };
      setSubscriptionMutate.mockImplementation((_input: unknown, options: { onError: () => void }) => options.onError());
      setup({}, 'notifications');

      fireEvent.change(selectWith(ts.notifyModes.daily), { target: { value: 'daily' } });
      expect(toastError).toHaveBeenCalledWith(ts.notifySaveFailed);
    });
  });

  describe('Danger zone', () => {
    function openConfirm() {
      setup({}, 'danger');
      expect(screen.getByText(ts.deleteForm)).toBeTruthy();
      expect(screen.getByText(ts.dangerDescription)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: en.common.actions.delete }));
      return screen.getByRole('dialog');
    }

    it('asks for confirmation, then deletes the form and goes back to the list', async () => {
      const dialog = openConfirm();
      expect(within(dialog).getByText(en.weldforms.actions.deleteConfirmTitle)).toBeTruthy();
      expect(deleteMutateAsync).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole('button', { name: en.common.actions.delete }));
      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/weldforms'));
      expect(deleteMutateAsync).toHaveBeenCalledWith('form_1');
      expect(toastSuccess).toHaveBeenCalledWith(en.weldforms.actions.deleted);
    });

    it('reports a failed delete and stays on the form', async () => {
      deleteMutateAsync.mockRejectedValueOnce(new Error('nope'));
      const dialog = openConfirm();

      fireEvent.click(within(dialog).getByRole('button', { name: en.common.actions.delete }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(en.weldforms.actions.deleteFailed));
      expect(routerPush).not.toHaveBeenCalled();
      expect(toastSuccess).not.toHaveBeenCalled();
    });
  });
});
