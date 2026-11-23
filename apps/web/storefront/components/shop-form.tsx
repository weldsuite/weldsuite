/**
 * Forms that post to the renderer's server functions. With page script the
 * form calls the function, shows its message in place (and marks the fields
 * it names), then refreshes the page's data; a redirect it answers with is
 * followed by the router (or the browser, for a payment page). Without
 * script it is an ordinary form post to the same function, which then
 * redirects (lib/server/actions/respond.ts).
 */

import { useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { AlertIcon, CheckIcon, errorMessage, useShop } from '@weldsuite/storefront-theme'
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { isActionResult, type ActionResult } from '@/lib/actions'

/** A server function that takes the form's data. */
export interface FormAction {
  (options: { data: FormData }): Promise<unknown>
  url: string
}

interface FormState {
  result: ActionResult | null
  pending: boolean
}

const FormStateContext = createContext<FormState>({ result: null, pending: false })

export function useFormState(): FormState {
  return useContext(FormStateContext)
}

export interface ShopFormProps {
  action: FormAction
  children: ReactNode | ((state: FormState) => ReactNode)
  className?: string
  /** The page to come back to after a plain (script-less) post. */
  back?: string
  /** Empty the form after a success (a code, a pasted list). */
  resetOnSuccess?: boolean
  /** Called with every result (the checkout keeps its idempotency key from it). */
  onResult?: (result: ActionResult) => void
  'aria-labelledby'?: string
  'aria-label'?: string
}

export function ShopForm({ action, children, className, back, resetOnSuccess = false, onResult, ...aria }: Readonly<ShopFormProps>) {
  const router = useRouter()
  const call = useServerFn(action)
  const { shop } = useShop()
  const form = useRef<HTMLFormElement>(null)
  const [state, setState] = useState<FormState>({ result: null, pending: false })

  // After a failure, focus the first field it marks, or else the message.
  useEffect(() => {
    if (!state.result || state.result.ok || state.pending) return
    const target = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? form.current?.querySelector<HTMLElement>('[data-form-message]')
    target?.focus()
  }, [state])

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (state.pending) return
    const element = event.currentTarget
    const data = new FormData(element)
    // The button that sent the form names the choice (approve / reject, remove).
    const submitter = (event.nativeEvent as SubmitEvent).submitter
    if (submitter instanceof HTMLButtonElement && submitter.name) data.set(submitter.name, submitter.value)
    setState((current) => ({ ...current, pending: true }))
    let result: ActionResult | null = null
    try {
      const answer = await call({ data })
      if (isActionResult(answer)) result = answer
    } catch (error) {
      if (!(error instanceof Error)) throw error
      result = { ok: false, code: 'NETWORK_ERROR', message: errorMessage(shop.strings, 'NETWORK_ERROR') }
    }
    setState({ result, pending: false })
    if (!result) return
    onResult?.(result)
    if (result.ok) {
      if (resetOnSuccess) element.reset()
      await router.invalidate()
    }
  }

  return (
    <form
      ref={form}
      method="post"
      action={action.url}
      encType="multipart/form-data"
      onSubmit={onSubmit}
      className={className}
      aria-busy={state.pending || undefined}
      {...aria}
    >
      {back ? <input type="hidden" name="back" value={back} /> : null}
      <FormStateContext.Provider value={state}>{typeof children === 'function' ? children(state) : children}</FormStateContext.Provider>
    </form>
  )
}

/** The form's message: a status after a success, an alert after a failure (with the lines that failed). */
export function FormMessage({ success = true }: Readonly<{ success?: boolean }>) {
  const { result } = useFormState()
  const { shop } = useShop()
  if (!result?.message || (result.ok && !success)) return null
  const problems = result.problems ?? []
  const s = shop.strings.b2b
  return (
    <div data-form-message tabIndex={-1} role={result.ok ? 'status' : 'alert'} className={result.ok ? 'shop-notice' : 'shop-alert'}>
      {result.ok ? <CheckIcon className="mt-0.5 size-5 shrink-0" /> : <AlertIcon className="mt-0.5 size-5 shrink-0 text-[var(--shop-danger)]" />}
      <div className="flex flex-col gap-3">
        <p>{result.message}</p>
        {problems.length > 0 ? (
          <table className="text-sm">
            <caption className="sr-only">{s.problems}</caption>
            <thead>
              <tr>
                <th scope="col" className="pe-4 text-start font-medium">
                  {s.row}
                </th>
                <th scope="col" className="pe-4 text-start font-medium">
                  {s.sku}
                </th>
                <th scope="col" className="text-start font-medium">
                  {s.problem}
                </th>
              </tr>
            </thead>
            <tbody>
              {problems.map((problem) => (
                <tr key={problem.id}>
                  <td className="pe-4 tabular-nums">{problem.row ?? '–'}</td>
                  <td className="pe-4">{problem.sku ?? '–'}</td>
                  <td>
                    {problem.message} ({problem.added ? s.addedAnyway : s.notAdded})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  )
}

/** A submit button that says what is happening and can't be pressed twice. */
export function SubmitButton({
  children,
  pendingText,
  className = 'shop-btn shop-btn-primary',
  name,
  value,
  disabled = false,
}: Readonly<{ children: ReactNode; pendingText?: string; className?: string; name?: string; value?: string; disabled?: boolean }>) {
  const { pending } = useFormState()
  return (
    <button type="submit" name={name} value={value} className={className} disabled={pending || disabled} aria-disabled={pending || disabled || undefined}>
      {pending && pendingText ? pendingText : children}
    </button>
  )
}

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'name'> {
  name: string
  label: string
  hint?: string
  /** Shows "(optional)" after the label; the other fields are required. */
  optional?: boolean
}

/** A labelled input, marked and described when the last answer named it. */
export function Field({ name, label, hint, optional = false, className, ...input }: Readonly<FieldProps>) {
  const id = useId()
  const { result } = useFormState()
  const { shop } = useShop()
  const error = result && !result.ok ? result.fieldErrors?.[name] : undefined
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ''}`}>
      <label htmlFor={id} className="shop-label">
        {label}
        {optional ? <span className="shop-hint font-normal">{` (${shop.strings.common.optional})`}</span> : null}
      </label>
      <input
        id={id}
        name={name}
        required={!optional}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        className="shop-input"
        {...input}
      />
      {hint ? (
        <p id={`${id}-hint`} className="shop-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="shop-field-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
