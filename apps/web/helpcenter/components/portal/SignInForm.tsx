import { useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useLazyI18n } from '@weldsuite/i18n/lazy-provider'
import { requestSignInCode, verifySignInCode } from '@/lib/portal'
import { errorText, fill, usePortalStrings } from '@/lib/portal-i18n'
import { safeNext } from '@/lib/portal-nav'
import {
  fieldErrorClass,
  inputClass,
  invalidInputClass,
  labelClass,
  linkButtonClass,
  primaryButtonClass,
} from '@/components/portal/styles'

type Step = 'email' | 'code'

/** Email step, then code step. On success the reader goes to `next`. */
export function SignInForm({ next }: Readonly<{ next?: string }>) {
  const t = usePortalStrings()
  const { language } = useLazyI18n()
  const router = useRouter()

  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus()
    else emailRef.current?.focus()
  }, [step])

  const sendCode = async (resend: boolean) => {
    const address = email.trim()
    if (!address) {
      setError(t.errors.invalidEmail)
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await requestSignInCode({ data: { email: address, locale: language } })
      if (!result.ok) {
        setError(errorText(t, result.code))
        return
      }
      setCode('')
      setStep('code')
      if (resend) setNotice(t.codeResent)
    } catch {
      setError(t.errors.generic)
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    const digits = code.replace(/\D/g, '')
    if (digits.length !== 6) {
      setError(t.errors.invalidCode)
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await verifySignInCode({ data: { email: email.trim(), code: digits } })
      if (!result.ok) {
        setError(errorText(t, result.code))
        setBusy(false)
        return
      }
      // The header shows who is signed in: reload the site data, then go on.
      router.clearCache()
      await router.navigate({ href: safeNext(next), replace: true })
      await router.invalidate({ filter: (match) => match.routeId === '__root__' })
    } catch {
      setError(t.errors.generic)
      setBusy(false)
    }
  }

  if (step === 'email') {
    return (
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void sendCode(false)
        }}
      >
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-white">{t.signInTitle}</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t.signInIntro}</p>

        <div className="mt-8">
          <label htmlFor="hc-email" className={labelClass}>
            {t.emailLabel}
          </label>
          <input
            ref={emailRef}
            id="hc-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            maxLength={255}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t.emailPlaceholder}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'hc-signin-error' : undefined}
            className={`${inputClass} mt-1.5 ${error ? invalidInputClass : ''}`}
          />
          {error && (
            <p id="hc-signin-error" role="alert" className={fieldErrorClass}>
              {error}
            </p>
          )}
        </div>

        <button type="submit" disabled={busy} className={`${primaryButtonClass} mt-6 w-full`}>
          {busy ? t.sendingCode : t.sendCode}
        </button>
      </form>
    )
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void verify()
      }}
    >
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-white">{t.codeTitle}</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        {fill(t.codeIntro, { email: email.trim() })}
      </p>

      <div className="mt-8">
        <label htmlFor="hc-code" className={labelClass}>
          {t.codeLabel}
        </label>
        <input
          ref={codeRef}
          id="hc-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'hc-signin-error' : undefined}
          className={`${inputClass} mt-1.5 text-center font-mono text-lg tracking-[0.5em] ${error ? invalidInputClass : ''}`}
        />
        {error && (
          <p id="hc-signin-error" role="alert" className={fieldErrorClass}>
            {error}
          </p>
        )}
        {notice && !error && (
          <p role="status" className="mt-1.5 text-sm text-emerald-700 dark:text-emerald-400">
            {notice}
          </p>
        )}
      </div>

      <button type="submit" disabled={busy || code.length !== 6} className={`${primaryButtonClass} mt-6 w-full`}>
        {busy ? t.verifying : t.verify}
      </button>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <button type="button" disabled={busy} onClick={() => void sendCode(true)} className={linkButtonClass}>
          {t.resend}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setStep('email')
            setError(null)
            setNotice(null)
          }}
          className="text-sm text-zinc-500 hover:text-zinc-800 disabled:opacity-60 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          {t.useOtherEmail}
        </button>
      </div>
    </form>
  )
}
