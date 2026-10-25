/**
 * Step 2 of a template: the roles. A role ("Client", "Director") stands for a
 * person who is not known yet; the name and email are only a default that is
 * filled in when the template is used. Each change is saved as it is made (text
 * fields when they lose focus). An access code is never stored on a template:
 * it is asked for when the template is used.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  SIGN_AUTH_MODES,
  SIGN_LOCALES,
  SIGN_RECIPIENT_ROLES,
  type SignEnvelopeDetail,
  type SignRecipientDto,
  type SignRecipientRole,
  type UpdateSignTemplateRoleInput,
} from '@weldsuite/app-api-client/schemas/weldsign';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { targetOf, useSignTemplateRoleMutations, useUpdateSignEnvelope } from '@/hooks/queries/use-weldsign-queries';
import { ChoiceField } from '../../components/choice-field';
import { SigningOrderToggle } from '../../envelope/settings-fields';
import { apiErrorMessage } from '../../lib/errors';
import { recipientColor } from '../../lib/recipient-colors';
import { parseOptionalEmail, roleNameTaken } from '../../lib/roles';

/** Saves a change to one role; `onError` lets the field put its old value back. */
type SaveRole = (role: SignRecipientDto, input: UpdateSignTemplateRoleInput, onError?: () => void) => void;

export function RolesStep({ template, editable }: Readonly<{ template: SignEnvelopeDetail; editable: boolean }>) {
  const { t, format } = useI18n();
  const tr = t.weldsign.templates.roles;
  const updateTemplate = useUpdateSignEnvelope(targetOf(template));
  const mutations = useSignTemplateRoleMutations(template.id);
  const [removing, setRemoving] = useState<SignRecipientDto | null>(null);
  const roles = template.recipientList;
  const ordered = template.signingOrderEnabled;

  const saveRole: SaveRole = (role, input, onError) =>
    mutations.update.mutate(
      { roleId: role.id, input },
      {
        onError: (err) => {
          toast.error(`${format(tr.saveFailed, { name: role.roleName ?? '' })}: ${apiErrorMessage(err)}`);
          onError?.();
        },
      },
    );

  const swap = (a: SignRecipientDto, b: SignRecipientDto) => {
    saveRole(a, { routingOrder: b.routingOrder });
    saveRole(b, { routingOrder: a.routingOrder });
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-6">
      <div>
        <h2 className="text-lg font-semibold">{tr.title}</h2>
        <p className="text-sm text-muted-foreground">{tr.description}</p>
      </div>

      <SigningOrderToggle
        checked={ordered}
        disabled={!editable}
        onChange={(signingOrderEnabled) => updateTemplate.mutate({ signingOrderEnabled })}
      />

      {roles.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr.empty}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {roles.map((role, i) => (
            <RoleRow
              key={role.id}
              role={role}
              colorIndex={i}
              position={ordered ? i + 1 : null}
              editable={editable}
              roles={roles}
              onSave={saveRole}
              onRemove={() => setRemoving(role)}
              onMoveUp={ordered && i > 0 ? () => swap(role, roles[i - 1]!) : undefined}
              onMoveDown={ordered && i < roles.length - 1 ? () => swap(role, roles[i + 1]!) : undefined}
            />
          ))}
        </ol>
      )}

      {editable && <AddRoleForm templateId={template.id} roles={roles} />}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={tr.removeTitle}
        description={format(tr.removeDescription, { name: removing?.roleName ?? '' })}
        confirmLabel={tr.remove}
        variant="destructive"
        onConfirm={() => {
          if (removing) mutations.remove.mutate(removing.id, { onError: (err) => toast.error(apiErrorMessage(err)) });
          setRemoving(null);
        }}
      />
    </div>
  );
}

interface RoleRowProps {
  role: SignRecipientDto;
  colorIndex: number;
  /** Place in the signing order (#2); null when the template has none. */
  position: number | null;
  editable: boolean;
  /** Every role of the template, to refuse a name that is taken. */
  roles: SignRecipientDto[];
  onSave: SaveRole;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

function RoleRow({ role, colorIndex, position, editable, roles, onSave, onRemove, onMoveUp, onMoveDown }: Readonly<RoleRowProps>) {
  const { t } = useI18n();
  const color = recipientColor(colorIndex);

  return (
    <li className="rounded-lg border p-4" style={{ borderLeft: `4px solid ${color.border}` }}>
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <RoleNameInput role={role} roles={roles} editable={editable} onSave={onSave} />
        {editable && (
          <RoleActions
            position={position}
            label={role.roleName ?? ''}
            onRemove={onRemove}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            moveUpLabel={t.weldsign.editor.documents.moveUp}
            moveDownLabel={t.weldsign.editor.documents.moveDown}
          />
        )}
      </div>
      <RoleSettings role={role} editable={editable} onSave={onSave} />
      <RoleDefaults role={role} editable={editable} onSave={onSave} />
    </li>
  );
}

interface RoleActionsProps {
  position: number | null;
  label: string;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  moveUpLabel: string;
  moveDownLabel: string;
}

function RoleActions({ position, label, onRemove, onMoveUp, onMoveDown, moveUpLabel, moveDownLabel }: Readonly<RoleActionsProps>) {
  const { t } = useI18n();
  return (
    <div className="flex items-end gap-1">
      {position !== null && (
        <>
          <span className="mr-1 self-center text-sm tabular-nums text-muted-foreground" aria-label={t.weldsign.editor.recipients.order}>
            {position}
          </span>
          <Button variant="ghost" size="icon" className="size-8" aria-label={moveUpLabel} disabled={!onMoveUp} onClick={onMoveUp}>
            <ArrowUp />
          </Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label={moveDownLabel} disabled={!onMoveDown} onClick={onMoveDown}>
            <ArrowDown />
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={`${t.weldsign.templates.roles.remove}: ${label}`}
        onClick={onRemove}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

function RoleNameInput({ role, roles, editable, onSave }: Readonly<{ role: SignRecipientDto; roles: SignRecipientDto[]; editable: boolean; onSave: SaveRole }>) {
  const { t, format } = useI18n();
  const tr = t.weldsign.templates.roles;
  const [value, setValue] = useState(role.roleName ?? '');
  useEffect(() => setValue(role.roleName ?? ''), [role.roleName]);
  const revert = () => setValue(role.roleName ?? '');

  const commit = () => {
    const next = value.trim();
    if (next === (role.roleName ?? '')) return;
    if (!next) {
      toast.error(tr.roleNameRequired);
      revert();
    } else if (roleNameTaken(roles, next, role.id)) {
      toast.error(format(tr.duplicateName, { name: next }));
      revert();
    } else onSave(role, { roleName: next }, revert);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`role-${role.id}-name`}>{tr.roleName}</Label>
      <Input
        id={`role-${role.id}-name`}
        value={value}
        maxLength={100}
        disabled={!editable}
        placeholder={tr.roleNamePlaceholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </div>
  );
}

/** Type, language and identity check; a role that only gets a copy has no identity check. */
function RoleSettings({ role, editable, onSave }: Readonly<{ role: SignRecipientDto; editable: boolean; onSave: SaveRole }>) {
  const { t } = useI18n();
  const tr = t.weldsign.editor.recipients;
  const isSigner = role.role === 'signer';

  return (
    <>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <ChoiceField
          label={t.weldsign.templates.roles.type}
          value={role.role}
          options={SIGN_RECIPIENT_ROLES.map((value) => ({ value, label: tr.roles[value] }))}
          disabled={!editable}
          // A copy has no identity check, so it goes back to the plain link.
          onChange={(next: SignRecipientRole) => onSave(role, next === 'cc' ? { role: next, authMode: 'link' } : { role: next })}
        />
        <ChoiceField
          label={tr.language}
          value={role.locale}
          options={SIGN_LOCALES.map((value) => ({ value, label: tr.languages[value] }))}
          disabled={!editable}
          onChange={(locale) => onSave(role, { locale })}
        />
        {isSigner && (
          <ChoiceField
            label={tr.verification}
            value={role.authMode}
            options={SIGN_AUTH_MODES.map((value) => ({ value, label: tr.authModes[value] }))}
            disabled={!editable}
            onChange={(authMode) => onSave(role, { authMode })}
          />
        )}
      </div>
      {isSigner && role.authMode === 'access_code' && (
        <p className="mt-2 text-xs text-muted-foreground">{t.weldsign.templates.roles.accessCodeNote}</p>
      )}
    </>
  );
}

/** Who usually fills the role: optional, and only a default. */
function RoleDefaults({ role, editable, onSave }: Readonly<{ role: SignRecipientDto; editable: boolean; onSave: SaveRole }>) {
  const { t } = useI18n();
  const tr = t.weldsign.templates.roles;
  const [name, setName] = useState(role.name ?? '');
  const [email, setEmail] = useState(role.email ?? '');
  useEffect(() => setName(role.name ?? ''), [role.name]);
  useEffect(() => setEmail(role.email ?? ''), [role.email]);

  const commitName = () => {
    const next = name.trim() || null;
    if (next !== role.name) onSave(role, { name: next }, () => setName(role.name ?? ''));
  };
  const commitEmail = () => {
    const next = parseOptionalEmail(email);
    if (next === undefined) {
      toast.error(tr.invalidEmail);
      setEmail(role.email ?? '');
    } else if (next !== role.email) onSave(role, { email: next }, () => setEmail(role.email ?? ''));
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`role-${role.id}-default-name`}>{tr.usualName}</Label>
          <Input
            id={`role-${role.id}-default-name`}
            value={name}
            maxLength={255}
            disabled={!editable}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`role-${role.id}-default-email`}>{tr.usualEmail}</Label>
          <Input
            id={`role-${role.id}-default-email`}
            type="email"
            value={email}
            maxLength={320}
            disabled={!editable}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={commitEmail}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{tr.defaultsHint}</p>
    </div>
  );
}

function AddRoleForm({ templateId, roles }: Readonly<{ templateId: string; roles: SignRecipientDto[] }>) {
  const { t, format, language } = useI18n();
  const tr = t.weldsign.templates.roles;
  const { add } = useSignTemplateRoleMutations(templateId);
  const [roleName, setRoleName] = useState('');
  const [role, setRole] = useState<SignRecipientRole>('signer');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = roleName.trim();
    if (!name) return void toast.error(tr.roleNameRequired);
    if (roleNameTaken(roles, name)) return void toast.error(format(tr.duplicateName, { name }));
    add.mutate(
      { roleName: name, role, locale: language === 'nl' ? 'nl' : 'en' },
      { onSuccess: () => setRoleName(''), onError: (err) => toast.error(apiErrorMessage(err)) },
    );
  };

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-lg border border-dashed p-4 sm:grid-cols-[1fr_200px_auto] sm:items-end">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-role-name">{tr.roleName}</Label>
        <Input
          id="new-role-name"
          value={roleName}
          maxLength={100}
          placeholder={tr.roleNamePlaceholder}
          onChange={(e) => setRoleName(e.target.value)}
        />
      </div>
      <ChoiceField
        label={tr.type}
        value={role}
        options={SIGN_RECIPIENT_ROLES.map((value) => ({ value, label: t.weldsign.editor.recipients.roles[value] }))}
        disabled={false}
        onChange={setRole}
      />
      <Button type="submit" disabled={add.isPending}>
        <Plus />
        {tr.add}
      </Button>
    </form>
  );
}
