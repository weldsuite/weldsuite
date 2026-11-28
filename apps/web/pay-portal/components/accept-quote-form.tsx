import { useRef, useState, type FormEvent } from 'react'
import { Button } from '@weldsuite/ui/components/button'
import { Input } from '@weldsuite/ui/components/input'
import { Label } from '@weldsuite/ui/components/label'
import { acceptInputSchema, type AcceptResult, type FailureReason, type Result } from '@/lib/contract'
import type { Dictionary } from '@/lib/i18n'

type Field = 'name' | 'email' | 'agree'
type FieldErrors = Partial<Record<Field, string>>

const ORDER: Field[] = ['name', 'email', 'agree']

export function acceptFailureText(t: Dictionary, reason: FailureReason): string {
  switch (reason) {
    case 'conflict':
      return t.accept.conflict
    case 'rate_limited':
      return t.accept.rateLimited
    case 'not_found':
      return t.accept.notFound
    default:
      return t.accept.generic
  }
}

/** Which fields of the form are wrong, with the dictionary's words. */
export function validateAccept(t: Dictionary, values: { name: string; email: string; agree: boolean }): FieldErrors {
  const errors: FieldErrors = {}
  if (!values.name.trim()) errors.name = t.accept.nameRequired
  if (!acceptInputSchema.shape.email.safeParse(values.email).success) errors.email = t.accept.emailInvalid
  if (!values.agree) errors.agree = t.accept.agreeRequired
  return errors
}

interface AcceptQuoteFormProps {
  t: Dictionary
  accept: (input: { name: string; email: string; agree: true }) => Promise<Result<AcceptResult>>
  onAccepted: (result: AcceptResult) => void
}

/**
 * The quote's acceptance: full name, email and a required tick. A field shows
 * its error once the customer has left it (or tried to submit), never while
 * they are still typing. `aria-invalid` and the link to the error text follow
 * what is shown. A failed submit moves focus to the first field in error.
 */
export function AcceptQuoteForm({ t, accept, onAccepted }: AcceptQuoteFormProps) {
  const [values, setValues] = useState({ name: '', email: '', agree: false })
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({})
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const inFlight = useRef(false)
  const refs = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    agree: useRef<HTMLInputElement>(null),
  }

  const all = validateAccept(t, values)
  const shown: FieldErrors = {}
  for (const field of ORDER) if (touched[field] && all[field]) shown[field] = all[field]

  const touch = (field: Field) => setTouched((current) => (current[field] ? current : { ...current, [field]: true }))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    const first = ORDER.find((field) => all[field])
    if (first) {
      setTouched({ name: true, email: true, agree: true })
      refs[first].current?.focus()
      return
    }
    inFlight.current = true
    setBusy(true)
    setFailure(null)
    const result = await accept({ name: values.name.trim(), email: values.email.trim(), agree: true }).catch(
      (): Result<AcceptResult> => ({ ok: false, reason: 'network' }),
    )
    inFlight.current = false
    setBusy(false)
    if (result.ok) onAccepted(result.data)
    else setFailure(acceptFailureText(t, result.reason))
  }

  const describedBy = (field: Field, hint?: string) => [hint, shown[field] ? `accept-${field}-error` : undefined].filter(Boolean).join(' ') || undefined

  return (
    <section aria-labelledby="accept-title" className="grid gap-4 rounded-lg border bg-muted/40 p-4 sm:p-5 print:hidden">
      <div className="grid gap-1">
        <h2 id="accept-title" className="text-lg font-semibold">
          {t.accept.title}
        </h2>
        <p className="text-sm text-muted-foreground">{t.accept.intro}</p>
      </div>
      <form noValidate onSubmit={submit} className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="accept-name">{t.accept.name}</Label>
          <Input
            id="accept-name"
            ref={refs.name}
            name="name"
            autoComplete="name"
            required
            maxLength={200}
            value={values.name}
            aria-invalid={Boolean(shown.name)}
            aria-describedby={describedBy('name')}
            onChange={(event) => setValues({ ...values, name: event.target.value })}
            onBlur={() => touch('name')}
          />
          <FieldError id="accept-name-error" message={shown.name} prefix={t.accept.errorPrefix} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="accept-email">{t.accept.email}</Label>
          <span id="accept-email-hint" className="text-xs text-muted-foreground">
            {t.accept.emailHint}
          </span>
          <Input
            id="accept-email"
            ref={refs.email}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            maxLength={320}
            value={values.email}
            aria-invalid={Boolean(shown.email)}
            aria-describedby={describedBy('email', 'accept-email-hint')}
            onChange={(event) => setValues({ ...values, email: event.target.value })}
            onBlur={() => touch('email')}
          />
          <FieldError id="accept-email-error" message={shown.email} prefix={t.accept.errorPrefix} />
        </div>
        <div className="grid gap-1.5">
          <div className="flex items-start gap-3">
            <input
              id="accept-agree"
              ref={refs.agree}
              name="agree"
              type="checkbox"
              required
              className="mt-1 size-5 shrink-0 accent-primary"
              checked={values.agree}
              aria-invalid={Boolean(shown.agree)}
              aria-describedby={describedBy('agree')}
              onChange={(event) => {
                setValues({ ...values, agree: event.target.checked })
                touch('agree')
              }}
              onBlur={() => touch('agree')}
            />
            <Label htmlFor="accept-agree" className="leading-snug">
              {t.accept.agree}
            </Label>
          </div>
          <FieldError id="accept-agree-error" message={shown.agree} prefix={t.accept.errorPrefix} />
        </div>
        {/* One polite live region for the whole form announces an error that appears when a field is left. */}
        <p role="status" className="sr-only">
          {ORDER.map((field) => shown[field]).find(Boolean) ?? ''}
        </p>
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        <div>
          <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={busy} aria-busy={busy}>
            {busy ? <progress className="loading-spinner" aria-label={t.accept.submitting} /> : null}
            {busy ? t.accept.submitting : t.accept.submit}
          </Button>
        </div>
      </form>
    </section>
  )
}

/** The error text sits in the page only while it is shown, with a text prefix so colour is not the only cue. */
function FieldError({ id, message, prefix }: { id: string; message: string | undefined; prefix: string }) {
  if (!message) return null
  return (
    <p id={id} className="text-sm text-destructive">
      <span className="font-medium">{prefix}: </span>
      {message}
    </p>
  )
}
