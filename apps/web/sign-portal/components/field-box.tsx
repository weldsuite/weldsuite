import { Check } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import type { SignPortalField } from '@weldsuite/app-api-client/schemas/weldsign';
import { isFilled, type SigningState } from '@/lib/fields';
import type { AdoptedSignature } from '@/lib/signing-types';
import { usePortal } from './portal-context';

interface FieldBoxProps {
  field: SignPortalField;
  /** CSS pixels per PDF point. */
  scale: number;
  /** Page size in PDF points, to turn the field box into percentages. */
  page: { width: number; height: number };
  state: SigningState;
  /** Display text for the name, email and date_signed fields. */
  autoText: string;
  highlighted: boolean;
  register: (id: string, el: HTMLElement | null) => void;
  onValue: (id: string, value: string) => void;
  onAdopt: (kind: 'signature' | 'initials') => void;
}

/** Smallest comfortable touch target, in CSS pixels. */
const MIN_TOUCH = 28;

function toneOf(filled: boolean, required: boolean): string {
  if (filled) return 'border-emerald-600/60 bg-emerald-50/50';
  return required ? 'border-amber-500 bg-amber-100/80' : 'border-slate-400 bg-slate-100/60';
}

/** What every kind of field box shares: its place on the page, its look, the ref and the "(required)" suffix. */
interface BoxParts {
  field: SignPortalField;
  className: string;
  frame: React.CSSProperties;
  fieldRef: (el: HTMLElement | null) => void;
  requiredHint: string;
  heightPx: number;
}

export function FieldBox({ field, scale, page, state, autoText, highlighted, register, onValue, onAdopt }: Readonly<FieldBoxProps>) {
  const { t } = usePortal();
  const parts: BoxParts = {
    field,
    className: cn(
      'absolute box-border rounded-sm border text-slate-900 outline-none transition-shadow',
      'focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-sky-600',
      highlighted && 'ring-4 ring-sky-500 ring-offset-2 animate-pulse',
      toneOf(isFilled(field, state), field.required),
    ),
    frame: {
      left: `${(field.x / page.width) * 100}%`,
      top: `${(field.y / page.height) * 100}%`,
      width: `${(field.width / page.width) * 100}%`,
      height: `${(field.height / page.height) * 100}%`,
    },
    fieldRef: (el) => register(field.id, el),
    requiredHint: field.required ? ` (${t.sign.required})` : '',
    heightPx: field.height * scale,
  };

  switch (field.type) {
    case 'signature':
    case 'initials':
      return <AdoptBox parts={parts} adopted={field.type === 'signature' ? state.signature : state.initials} onAdopt={onAdopt} />;
    case 'checkbox':
      return <CheckboxBox parts={parts} checked={state.values[field.id] === 'true'} onValue={onValue} />;
    case 'text':
      return <TextBox parts={parts} value={state.values[field.id] ?? ''} onValue={onValue} />;
    default:
      // name, email, date_signed: the server fills in the real values.
      return <AutoBox parts={parts} text={autoText} />;
  }
}

function AdoptBox({ parts, adopted, onAdopt }: Readonly<{ parts: BoxParts; adopted: AdoptedSignature | null; onAdopt: FieldBoxProps['onAdopt'] }>) {
  const { t, brandColor } = usePortal();
  const isSignature = parts.field.type === 'signature';
  let label = (isSignature ? t.sign.signatureField : t.sign.initialsField) + parts.requiredHint;
  if (adopted) label = isSignature ? t.sign.changeSignature : t.sign.changeInitials;
  return (
    <button
      type="button"
      ref={parts.fieldRef}
      aria-label={label}
      title={parts.field.label || undefined}
      className={cn(parts.className, 'flex cursor-pointer items-center justify-center overflow-hidden p-0.5 hover:brightness-95', !adopted && 'border-dashed')}
      style={{ ...parts.frame, minHeight: MIN_TOUCH, borderColor: adopted ? undefined : brandColor || undefined }}
      onClick={() => onAdopt(isSignature ? 'signature' : 'initials')}
    >
      {adopted ? (
        <img src={adopted.image} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
      ) : (
        <span className="truncate px-1 font-medium text-amber-900" style={{ fontSize: Math.max(11, Math.min(parts.heightPx * 0.4, 16)) }}>
          {isSignature ? t.sign.signHere : t.sign.initialHere}
        </span>
      )}
    </button>
  );
}

function CheckboxBox({ parts, checked, onValue }: Readonly<{ parts: BoxParts; checked: boolean; onValue: FieldBoxProps['onValue'] }>) {
  const { t } = usePortal();
  return (
    <button
      type="button"
      ref={parts.fieldRef}
      role="checkbox"
      aria-checked={checked}
      aria-label={`${parts.field.label ?? t.sign.checkboxField}${parts.requiredHint}`}
      className={cn(parts.className, 'flex cursor-pointer items-center justify-center p-0')}
      style={{ ...parts.frame, minWidth: MIN_TOUCH, minHeight: MIN_TOUCH }}
      onClick={() => onValue(parts.field.id, checked ? 'false' : 'true')}
    >
      {checked ? <Check className="size-[70%] text-emerald-700" strokeWidth={3} aria-hidden="true" /> : null}
    </button>
  );
}

function TextBox({ parts, value, onValue }: Readonly<{ parts: BoxParts; value: string; onValue: FieldBoxProps['onValue'] }>) {
  const { t } = usePortal();
  return (
    <input
      type="text"
      ref={parts.fieldRef}
      value={value}
      maxLength={1000}
      autoComplete="off"
      aria-label={`${parts.field.label ?? t.sign.textField}${parts.requiredHint}`}
      placeholder={parts.field.label ?? ''}
      className={cn(parts.className, 'px-1 placeholder:text-slate-500')}
      // 16px or more keeps iOS from zooming the page when the field takes focus.
      style={{ ...parts.frame, minHeight: MIN_TOUCH, fontSize: Math.max(16, parts.heightPx * 0.55) }}
      onChange={(e) => onValue(parts.field.id, e.target.value)}
    />
  );
}

function AutoBox({ parts, text }: Readonly<{ parts: BoxParts; text: string }>) {
  const { t } = usePortal();
  return (
    <div
      ref={parts.fieldRef}
      title={t.sign.autoField}
      className={cn(parts.className, 'flex items-center overflow-hidden border-dashed border-slate-300 bg-slate-50/70 px-1')}
      style={parts.frame}
    >
      <span className="truncate" style={{ fontSize: Math.max(8, Math.min(parts.heightPx * 0.62, 18)) }}>
        {text}
      </span>
    </div>
  );
}
