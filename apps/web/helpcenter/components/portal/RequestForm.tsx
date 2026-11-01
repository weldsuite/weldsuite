import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { DeskPortalField, DeskPortalRequestType } from '@weldsuite/app-api-client/schemas/desk-portal'
import { submitRequest } from '@/lib/portal'
import {
  BODY_MAX,
  TITLE_MAX,
  answersOf,
  emptyValue,
  fieldsPayload,
  missingRequired,
  shownFields,
  type FieldValue,
} from '@/lib/portal-fields'
import { errorText, usePortalStrings, type PortalStrings } from '@/lib/portal-i18n'
import { useSignInRedirect } from '@/lib/portal-nav'
import {
  fieldErrorClass,
  helpTextClass,
  inputClass,
  invalidInputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from '@/components/portal/styles'

const TITLE = 'title'
const DESCRIPTION = 'description'

interface RequestFormProps {
  type: DeskPortalRequestType
  /** Back to the type picker; absent when the help center has one type. */
  onChangeType?: () => void
}

/** The form for one request type: title, description, then the type's own fields. */
export function RequestForm({ type, onChangeType }: Readonly<RequestFormProps>) {
  const t = usePortalStrings()
  const navigate = useNavigate()
  const toSignIn = useSignInRedirect()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [values, setValues] = useState<Record<string, FieldValue>>(() =>
    Object.fromEntries(type.fields.map((f) => [f.key, emptyValue(f)])),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const answers = useMemo(() => answersOf(type, title, description, values), [type, title, description, values])
  const visible = useMemo(() => shownFields(type, answers), [type, answers])

  const setValue = (key: string, value: FieldValue) => {
    setValues((prev) => ({ ...prev, [key]: value }))
    setErrors(({ [key]: _cleared, ...rest }) => rest)
  }

  const submit = async () => {
    const missing = missingRequired(type, answers)
    if (missing.length > 0) {
      setErrors(Object.fromEntries(missing.map((key) => [key, t.errors.required])))
      setFormError(null)
      document.getElementById(inputId(missing[0] ?? TITLE))?.focus()
      return
    }

    setBusy(true)
    setErrors({})
    setFormError(null)
    try {
      const result = await submitRequest({
        data: {
          ticketTypeId: type.id,
          title: title.trim(),
          ...(type.descriptionLabel !== null && description.trim() ? { description: description.trim() } : {}),
          fields: fieldsPayload(type, answers),
        },
      })
      if (result.ok) {
        await navigate({ to: '/requests/$id', params: { id: result.data.id } })
        return
      }
      if (result.code === 'SIGN_IN_REQUIRED') {
        toSignIn()
        return
      }
      const field = result.field
      const known = field === TITLE || field === DESCRIPTION || visible.some((f) => f.key === field)
      if (field && known) {
        setErrors({ [field]: t.errors.invalidField })
        document.getElementById(inputId(field))?.focus()
      } else {
        setFormError(errorText(t, result.code))
      }
    } catch {
      setFormError(t.errors.generic)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      className="space-y-6"
    >
      <div className="flex items-start justify-between gap-4 rounded-xl bg-zinc-50 px-4 py-3 dark:bg-zinc-900/60">
        <div className="min-w-0">
          <p className="font-medium text-zinc-900 dark:text-white">{type.name}</p>
          {type.description && <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{type.description}</p>}
        </div>
        {onChangeType && (
          <button
            type="button"
            onClick={onChangeType}
            className="shrink-0 text-sm font-medium text-[var(--hc-accent)] hover:underline"
          >
            {t.form.changeType}
          </button>
        )}
      </div>

      <FormRow id={inputId(TITLE)} label={type.titleLabel} required error={errors[TITLE]} t={t}>
        <input
          id={inputId(TITLE)}
          type="text"
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => {
            setTitle(e.target.value)
            setErrors(({ [TITLE]: _cleared, ...rest }) => rest)
          }}
          {...invalidProps(TITLE, errors[TITLE])}
          className={inputCls(errors[TITLE])}
        />
      </FormRow>

      {type.descriptionLabel !== null && (
        <FormRow
          id={inputId(DESCRIPTION)}
          label={type.descriptionLabel}
          required={type.descriptionRequired}
          error={errors[DESCRIPTION]}
          t={t}
        >
          <textarea
            id={inputId(DESCRIPTION)}
            rows={6}
            value={description}
            maxLength={BODY_MAX}
            onChange={(e) => {
              setDescription(e.target.value)
              setErrors(({ [DESCRIPTION]: _cleared, ...rest }) => rest)
            }}
            {...invalidProps(DESCRIPTION, errors[DESCRIPTION])}
            className={inputCls(errors[DESCRIPTION])}
          />
        </FormRow>
      )}

      {visible.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={values[field.key] ?? emptyValue(field)}
          error={errors[field.key]}
          onChange={(value) => setValue(field.key, value)}
          t={t}
        />
      ))}

      {formError && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {formError}
        </p>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button type="button" onClick={() => void navigate({ to: '/requests' })} className={secondaryButtonClass}>
          {t.form.cancel}
        </button>
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? t.form.submitting : t.form.submit}
        </button>
      </div>
    </form>
  )
}

function inputId(key: string): string {
  return `hc-field-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

function inputCls(error: string | undefined): string {
  return `${inputClass} mt-1.5 ${error ? invalidInputClass : ''}`
}

function invalidProps(key: string, error: string | undefined) {
  return error ? { 'aria-invalid': true as const, 'aria-describedby': `${inputId(key)}-error` } : {}
}

interface FormRowProps {
  id: string
  label: string
  required?: boolean
  error?: string
  helpText?: string | null
  t: PortalStrings
  children: React.ReactNode
  /** Render the label after the control (checkbox). */
  inline?: boolean
}

function FormRow({ id, label, required, error, helpText, t, children, inline }: Readonly<FormRowProps>) {
  const labelEl = (
    <label htmlFor={id} className={inline ? 'text-sm text-zinc-800 dark:text-zinc-200' : labelClass}>
      {label}
      {required ? (
        <span className="ml-0.5 text-red-500" aria-hidden="true">
          *
        </span>
      ) : (
        !inline && <span className="ml-1.5 text-xs font-normal text-zinc-400">({t.form.optional})</span>
      )}
    </label>
  )
  return (
    <div>
      {inline ? (
        <div className="flex items-start gap-2.5">
          {children}
          {labelEl}
        </div>
      ) : (
        <>
          {labelEl}
          {children}
        </>
      )}
      {helpText && <p className={helpTextClass}>{helpText}</p>}
      {error && (
        <p id={`${id}-error`} role="alert" className={fieldErrorClass}>
          {error}
        </p>
      )}
    </div>
  )
}

interface FieldInputProps {
  field: DeskPortalField
  value: FieldValue
  error?: string
  onChange: (value: FieldValue) => void
  t: PortalStrings
}

function FieldInput({ field, value, error, onChange, t }: Readonly<FieldInputProps>) {
  const id = inputId(field.key)
  const row = { id, label: field.label, required: field.required, error, helpText: field.helpText, t }
  const text = typeof value === 'string' ? value : ''
  const common = {
    id,
    placeholder: field.placeholder ?? undefined,
    ...invalidProps(field.key, error),
    className: inputCls(error),
  }

  switch (field.type) {
    case 'textarea':
      return (
        <FormRow {...row}>
          <textarea {...common} rows={4} value={text} maxLength={BODY_MAX} onChange={(e) => onChange(e.target.value)} />
        </FormRow>
      )

    case 'select':
      return (
        <FormRow {...row}>
          <select {...common} value={text} onChange={(e) => onChange(e.target.value)}>
            <option value="">{field.placeholder || t.form.selectPlaceholder}</option>
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </FormRow>
      )

    case 'multiselect': {
      const selected = Array.isArray(value) ? value : []
      return (
        <fieldset aria-describedby={error ? `${id}-error` : undefined}>
          <legend className={labelClass}>
            {field.label}
            {field.required ? (
              <span className="ml-0.5 text-red-500" aria-hidden="true">
                *
              </span>
            ) : (
              <span className="ml-1.5 text-xs font-normal text-zinc-400">({t.form.optional})</span>
            )}
          </legend>
          <div id={id} tabIndex={-1} className="mt-2 space-y-2">
            {field.options.map((o) => {
              const checked = selected.includes(o.value)
              return (
                <label key={o.value} className="flex items-center gap-2.5 text-sm text-zinc-800 dark:text-zinc-200">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onChange(checked ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
                    className="h-4 w-4 rounded border-zinc-300 accent-[var(--hc-accent)] dark:border-zinc-700"
                  />
                  {o.label}
                </label>
              )
            })}
          </div>
          {field.helpText && <p className={helpTextClass}>{field.helpText}</p>}
          {error && (
            <p id={`${id}-error`} role="alert" className={fieldErrorClass}>
              {error}
            </p>
          )}
        </fieldset>
      )
    }

    case 'checkbox':
      return (
        <FormRow {...row} inline>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            {...invalidProps(field.key, error)}
            className="mt-1 h-4 w-4 shrink-0 rounded border-zinc-300 accent-[var(--hc-accent)] dark:border-zinc-700"
          />
        </FormRow>
      )

    case 'number':
      return (
        <FormRow {...row}>
          <input {...common} type="number" inputMode="decimal" step="any" value={text} onChange={(e) => onChange(e.target.value)} />
        </FormRow>
      )

    case 'date':
      return (
        <FormRow {...row}>
          <input {...common} type="date" value={text} onChange={(e) => onChange(e.target.value)} />
        </FormRow>
      )

    case 'email':
      return (
        <FormRow {...row}>
          <input {...common} type="email" inputMode="email" maxLength={255} value={text} onChange={(e) => onChange(e.target.value)} />
        </FormRow>
      )

    case 'url':
      return (
        <FormRow {...row}>
          <input {...common} type="url" inputMode="url" maxLength={2048} value={text} onChange={(e) => onChange(e.target.value)} />
        </FormRow>
      )

    case 'text':
    default:
      return (
        <FormRow {...row}>
          <input {...common} type="text" maxLength={1000} value={text} onChange={(e) => onChange(e.target.value)} />
        </FormRow>
      )
  }
}
