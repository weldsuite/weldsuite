'use client';

import { Check } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import type { SignPortalField } from '@weldsuite/app-api-client/schemas/weldsign';
import { isFilled, type SigningState } from '@/lib/fields';
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

export function FieldBox({ field, scale, page, state, autoText, highlighted, register, onValue, onAdopt }: Readonly<FieldBoxProps>) {
  const { t, brandColor } = usePortal();
  const filled = isFilled(field, state);
  const heightPx = field.height * scale;

  const tone = !filled && field.required
    ? 'border-amber-500 bg-amber-100/80'
    : filled
      ? 'border-emerald-600/60 bg-emerald-50/50'
      : 'border-slate-400 bg-slate-100/60';

  const frame: React.CSSProperties = {
    left: `${(field.x / page.width) * 100}%`,
    top: `${(field.y / page.height) * 100}%`,
    width: `${(field.width / page.width) * 100}%`,
    height: `${(field.height / page.height) * 100}%`,
  };
  const base = cn(
    'absolute box-border rounded-sm border text-slate-900 outline-none transition-shadow',
    'focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-sky-600',
    highlighted && 'ring-4 ring-sky-500 ring-offset-2 animate-pulse',
    tone,
  );
  const ref = (el: HTMLElement | null) => register(field.id, el);
  const requiredHint = field.required ? ` (${t.sign.required})` : '';
  const title = field.label ?? '';

  if (field.type === 'signature' || field.type === 'initials') {
    const adopted = field.type === 'signature' ? state.signature : state.initials;
    const isSignature = field.type === 'signature';
    const aria = adopted
      ? isSignature ? t.sign.changeSignature : t.sign.changeInitials
      : `${isSignature ? t.sign.signatureField : t.sign.initialsField}${requiredHint}`;
    return (
      <button
        type="button"
        ref={ref}
        aria-label={aria}
        title={title || undefined}
        className={cn(base, 'flex cursor-pointer items-center justify-center overflow-hidden p-0.5 hover:brightness-95', !adopted && 'border-dashed')}
        style={{ ...frame, minHeight: MIN_TOUCH, ...(adopted ? {} : brandColor ? { borderColor: brandColor } : {}) }}
        onClick={() => onAdopt(field.type === 'signature' ? 'signature' : 'initials')}
      >
        {adopted ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={adopted.image} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="truncate px-1 font-medium text-amber-900" style={{ fontSize: Math.max(11, Math.min(heightPx * 0.4, 16)) }}>
            {isSignature ? t.sign.signHere : t.sign.initialHere}
          </span>
        )}
      </button>
    );
  }

  if (field.type === 'checkbox') {
    const checked = state.values[field.id] === 'true';
    return (
      <button
        type="button"
        ref={ref}
        role="checkbox"
        aria-checked={checked}
        aria-label={`${field.label ?? t.sign.checkboxField}${requiredHint}`}
        className={cn(base, 'flex cursor-pointer items-center justify-center p-0')}
        style={{ ...frame, minWidth: MIN_TOUCH, minHeight: MIN_TOUCH }}
        onClick={() => onValue(field.id, checked ? 'false' : 'true')}
      >
        {checked ? <Check className="size-[70%] text-emerald-700" strokeWidth={3} aria-hidden="true" /> : null}
      </button>
    );
  }

  if (field.type === 'text') {
    return (
      <input
        type="text"
        ref={ref}
        value={state.values[field.id] ?? ''}
        maxLength={1000}
        autoComplete="off"
        aria-label={`${field.label ?? t.sign.textField}${requiredHint}`}
        placeholder={field.label ?? ''}
        className={cn(base, 'px-1 placeholder:text-slate-500')}
        // 16px or more keeps iOS from zooming the page when the field takes focus.
        style={{ ...frame, minHeight: MIN_TOUCH, fontSize: Math.max(16, heightPx * 0.55) }}
        onChange={(e) => onValue(field.id, e.target.value)}
      />
    );
  }

  // name, email, date_signed: the server fills in the real values.
  return (
    <div
      ref={ref}
      title={t.sign.autoField}
      className={cn(base, 'flex items-center overflow-hidden border-dashed border-slate-300 bg-slate-50/70 px-1')}
      style={frame}
    >
      <span className="truncate" style={{ fontSize: Math.max(8, Math.min(heightPx * 0.62, 18)) }}>
        {autoText}
      </span>
    </div>
  );
}
