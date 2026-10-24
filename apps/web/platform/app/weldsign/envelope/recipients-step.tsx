/**
 * Step 2: who signs and who gets a copy. Each change is saved when it is made
 * (text fields when they lose focus). Choosing "access code" waits for the code
 * before it is saved, since the server refuses that mode without one.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import {
  SIGN_AUTH_MODES,
  SIGN_LOCALES,
  SIGN_RECIPIENT_ROLES,
  type SignAuthMode,
  type SignEnvelopeDetail,
  type SignLocale,
  type SignRecipientDto,
  type SignRecipientRole,
  type UpdateSignRecipientInput,
} from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { useSignRecipientMutations, useUpdateSignEnvelope } from '@/hooks/queries/use-weldsign-queries';
import { recipientColor } from '../lib/recipient-colors';
import { apiErrorMessage } from '../lib/errors';

const emailSchema = z.string().trim().email();

export function RecipientsStep({ envelope, editable }: Readonly<{ envelope: SignEnvelopeDetail; editable: boolean }>) {
  const { t, format } = useI18n();
  const tr = t.weldsign.editor.recipients;
  const updateEnvelope = useUpdateSignEnvelope(envelope.id);
  const mutations = useSignRecipientMutations(envelope.id);
  const recipients = envelope.recipientList;
  const ordered = envelope.signingOrderEnabled;

  const swap = (a: SignRecipientDto, b: SignRecipientDto) => {
    mutations.update.mutate({ recipientId: a.id, input: { routingOrder: b.routingOrder } });
    mutations.update.mutate({ recipientId: b.id, input: { routingOrder: a.routingOrder } });
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-6">
      <div>
        <h2 className="text-lg font-semibold">{tr.title}</h2>
        <p className="text-sm text-muted-foreground">{tr.description}</p>
      </div>

      <label className="flex items-start gap-3 rounded-lg border p-3">
        <Switch
          checked={ordered}
          disabled={!editable}
          onCheckedChange={(checked) => updateEnvelope.mutate({ signingOrderEnabled: checked })}
          className="mt-0.5"
        />
        <span>
          <span className="block text-sm font-medium">{tr.signingOrder}</span>
          <span className="block text-xs text-muted-foreground">{tr.signingOrderHint}</span>
        </span>
      </label>

      {recipients.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tr.empty}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {recipients.map((recipient, i) => (
            <RecipientRow
              key={recipient.id}
              recipient={recipient}
              colorIndex={i}
              position={ordered ? i + 1 : null}
              editable={editable}
              onSave={(input) =>
                mutations.update.mutate(
                  { recipientId: recipient.id, input },
                  { onError: (err) => toast.error(`${format(tr.saveFailed, { name: recipient.name ?? '' })}: ${apiErrorMessage(err)}`) },
                )
              }
              onRemove={() => mutations.remove.mutate(recipient.id)}
              onMoveUp={ordered && i > 0 ? () => swap(recipient, recipients[i - 1]!) : undefined}
              onMoveDown={ordered && i < recipients.length - 1 ? () => swap(recipient, recipients[i + 1]!) : undefined}
            />
          ))}
        </ol>
      )}

      {editable && <AddRecipientForm envelopeId={envelope.id} />}
    </div>
  );
}

function RecipientRow({
  recipient,
  colorIndex,
  position,
  editable,
  onSave,
  onRemove,
  onMoveUp,
  onMoveDown,
}: Readonly<{
  recipient: SignRecipientDto;
  colorIndex: number;
  position: number | null;
  editable: boolean;
  onSave: (input: UpdateSignRecipientInput) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}>) {
  const { t } = useI18n();
  const tr = t.weldsign.editor.recipients;
  const [name, setName] = useState(recipient.name ?? '');
  const [email, setEmail] = useState(recipient.email ?? '');
  const [authMode, setAuthMode] = useState<SignAuthMode>(recipient.authMode);
  const [accessCode, setAccessCode] = useState('');
  useEffect(() => setName(recipient.name ?? ''), [recipient.name]);
  useEffect(() => setEmail(recipient.email ?? ''), [recipient.email]);
  useEffect(() => setAuthMode(recipient.authMode), [recipient.authMode]);

  const color = recipientColor(colorIndex);
  const id = (part: string) => `recipient-${recipient.id}-${part}`;

  const saveName = () => {
    const next = name.trim();
    if (!next) {
      toast.error(tr.nameRequired);
      setName(recipient.name ?? '');
    } else if (next !== recipient.name) onSave({ name: next });
  };
  const saveEmail = () => {
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      toast.error(tr.invalidEmail);
      setEmail(recipient.email ?? '');
    } else if (parsed.data.toLowerCase() !== recipient.email) onSave({ email: parsed.data });
  };
  const changeAuthMode = (mode: SignAuthMode) => {
    setAuthMode(mode);
    // Access code mode is saved together with its code.
    if (mode !== 'access_code' || recipient.hasAccessCode) onSave({ authMode: mode });
  };
  const saveAccessCode = () => {
    const code = accessCode.trim();
    if (code.length < 4) return;
    onSave({ authMode: 'access_code', accessCode: code });
    setAccessCode('');
  };

  return (
    <li className="rounded-lg border p-4" style={{ borderLeft: `4px solid ${color.border}` }}>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id('name')}>{tr.name}</Label>
          <Input id={id('name')} value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} onBlur={saveName} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id('email')}>{tr.email}</Label>
          <Input id={id('email')} type="email" value={email} disabled={!editable} onChange={(e) => setEmail(e.target.value)} onBlur={saveEmail} />
        </div>
        {editable && (
          <div className="flex items-end gap-1">
            {position !== null && (
              <>
                <span className="mr-1 self-center text-sm tabular-nums text-muted-foreground" aria-label={tr.order}>
                  {position}
                </span>
                <Button variant="ghost" size="icon" className="size-8" aria-label={t.weldsign.editor.documents.moveUp} disabled={!onMoveUp} onClick={onMoveUp}>
                  <ArrowUp />
                </Button>
                <Button variant="ghost" size="icon" className="size-8" aria-label={t.weldsign.editor.documents.moveDown} disabled={!onMoveDown} onClick={onMoveDown}>
                  <ArrowDown />
                </Button>
              </>
            )}
            <Button variant="ghost" size="icon" className="size-8" aria-label={tr.remove} onClick={onRemove}>
              <Trash2 />
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <ChoiceField
          label={tr.role}
          value={recipient.role}
          options={SIGN_RECIPIENT_ROLES.map((value) => ({ value, label: tr.roles[value] }))}
          disabled={!editable}
          onChange={(role: SignRecipientRole) => onSave({ role })}
        />
        <ChoiceField
          label={tr.language}
          value={recipient.locale}
          options={SIGN_LOCALES.map((value) => ({ value, label: tr.languages[value] }))}
          disabled={!editable}
          onChange={(locale: SignLocale) => onSave({ locale })}
        />
        {recipient.role === 'signer' && (
          <ChoiceField
            label={tr.verification}
            value={authMode}
            options={SIGN_AUTH_MODES.map((value) => ({ value, label: tr.authModes[value] }))}
            disabled={!editable}
            onChange={changeAuthMode}
          />
        )}
      </div>

      {recipient.role === 'signer' && authMode === 'access_code' && editable && (
        <div className="mt-3 flex flex-col gap-1.5 sm:max-w-xs">
          <Label htmlFor={id('code')}>{tr.accessCode}</Label>
          <Input
            id={id('code')}
            value={accessCode}
            minLength={4}
            maxLength={64}
            autoComplete="off"
            placeholder={recipient.hasAccessCode ? '••••••' : ''}
            onChange={(e) => setAccessCode(e.target.value)}
            onBlur={saveAccessCode}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <p className="text-xs text-muted-foreground">{recipient.hasAccessCode ? tr.accessCodeSet : tr.accessCodeHint}</p>
        </div>
      )}
    </li>
  );
}

function ChoiceField<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: Readonly<{ label: string; value: T; options: { value: T; label: string }[]; disabled: boolean; onChange: (value: T) => void }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <Select value={value} disabled={disabled} onValueChange={(next) => next !== value && onChange(next as T)}>
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function AddRecipientForm({ envelopeId }: Readonly<{ envelopeId: string }>) {
  const { t, language } = useI18n();
  const tr = t.weldsign.editor.recipients;
  const { add } = useSignRecipientMutations(envelopeId);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<SignRecipientRole>('signer');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return void toast.error(tr.nameRequired);
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) return void toast.error(tr.invalidEmail);
    add.mutate(
      { name: name.trim(), email: parsed.data, role, locale: language === 'nl' ? 'nl' : 'en' },
      {
        onSuccess: () => {
          setName('');
          setEmail('');
        },
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );
  };

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-lg border border-dashed p-4 sm:grid-cols-[1fr_1fr_180px_auto] sm:items-end">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-recipient-name">{tr.name}</Label>
        <Input id="new-recipient-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-recipient-email">{tr.email}</Label>
        <Input id="new-recipient-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <ChoiceField
        label={tr.role}
        value={role}
        options={SIGN_RECIPIENT_ROLES.map((value) => ({ value, label: tr.roles[value] }))}
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
