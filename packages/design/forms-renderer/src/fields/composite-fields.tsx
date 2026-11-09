import type { FieldBlockOf } from '@weldsuite/forms-engine';
import { partsOf } from '@weldsuite/forms-engine';
import { useFieldEnv, type FieldViewProps } from '../env';
import type { FormRendererLabels } from '../types';

const AUTOCOMPLETE: Record<string, string> = {
  firstName: 'given-name',
  lastName: 'family-name',
  email: 'email',
  phone: 'tel',
  company: 'organization',
  line1: 'address-line1',
  line2: 'address-line2',
  city: 'address-level2',
  state: 'address-level1',
  postalCode: 'postal-code',
  country: 'country-name',
};

function partLabel(labels: FormRendererLabels, part: string): string {
  const map: Record<string, string> = {
    firstName: labels.firstName,
    lastName: labels.lastName,
    email: labels.email,
    phone: labels.phone,
    company: labels.company,
    line1: labels.line1,
    line2: labels.line2,
    city: labels.city,
    state: labels.state,
    postalCode: labels.postalCode,
    country: labels.country,
  };
  return map[part] ?? part;
}

/** The input type (and keyboard) of a part: email and phone get their own, the rest is text. */
function partInputType(part: string): 'email' | 'tel' | 'text' {
  if (part === 'email') return 'email';
  if (part === 'phone') return 'tel';
  return 'text';
}

/** Contact info and address: one input per enabled sub-field. */
export function CompositeField({
  field,
  value,
  onChange,
  error,
  inputId,
  describedBy,
}: FieldViewProps<FieldBlockOf<'contact_info' | 'address'>>) {
  const { labels } = useFieldEnv();
  const current: Record<string, string> =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, string>) : {};
  const parts = partsOf(field).filter((p) => p.enabled);

  function change(part: string, text: string) {
    const next = { ...current, [part]: text };
    if (text === '') delete next[part];
    onChange(Object.keys(next).length === 0 ? undefined : next);
  }

  return (
    <div
      id={inputId}
      role="group"
      aria-labelledby={`${inputId}-label`}
      aria-describedby={describedBy}
      className="wf-composite"
      data-kind={field.type}
    >
      {parts.map(({ part, required }, i) => {
        const wrong = error?.part === part;
        const label = partLabel(labels, part);
        const inputType = partInputType(part);
        return (
          <label key={part} className="wf-composite-part" data-part={part}>
            <span className="wf-sublabel">
              {label}
              {required ? '' : ` (${labels.optional})`}
            </span>
            <input
              className="wf-input"
              type={inputType}
              inputMode={inputType}
              autoComplete={AUTOCOMPLETE[part]}
              value={current[part] ?? ''}
              aria-invalid={wrong ? true : undefined}
              aria-required={required || undefined}
              data-wf-focus={i === 0 ? '' : undefined}
              onChange={(e) => change(part, e.target.value)}
            />
          </label>
        );
      })}
    </div>
  );
}
