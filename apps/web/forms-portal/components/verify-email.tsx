import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@weldsuite/ui/components/button'
import { Input } from '@weldsuite/ui/components/input'
import { Label } from '@weldsuite/ui/components/label'
import { ApiError, formsApi } from '@/lib/client/api'
import { usePortal } from './portal-context'

interface VerifyEmailProps {
  publicId: string
  /** A fresh bot-check token for the code request. */
  takeBotToken: () => Promise<string | undefined>
  /** The proof forms-api issued for the address; the session start sends it. */
  onVerified: (verification: string) => void
}

/** A step's error line, under its field. */
function StepError({ error }: Readonly<{ error: string | null }>) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null
}

/** A step's confirmation line (the code was sent again). */
function StepNotice({ notice }: Readonly<{ notice: string | null }>) {
  return notice ? (
    <p role="status" className="text-sm text-emerald-700">
      {notice}
    </p>
  ) : null
}

interface SubmitButtonProps {
  busy: boolean
  disabled: boolean
  label: string
  /** Shown, with a spinner, while the request runs. */
  busyLabel: string
}

/** A step's submit button. */
function SubmitButton({ busy, disabled, label, busyLabel }: Readonly<SubmitButtonProps>) {
  return (
    <Button type="submit" size="lg" disabled={disabled}>
      {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
      {busy ? busyLabel : label}
    </Button>
  )
}

/** Verified-email forms: address, then the 6-digit code, then a verification token. */
export function VerifyEmail({ publicId, takeBotToken, onVerified }: Readonly<VerifyEmailProps>) {
  const { t, fill } = usePortal()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [locked, setLocked] = useState(false)

  async function requestCode(): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      const botToken = await takeBotToken()
      await formsApi.sendCode(publicId, { email: email.trim(), ...(botToken ? { botToken } : {}) })
      return true
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setError(t.verify.rateLimited)
      else if (err instanceof ApiError && err.code === 'BOT_CHECK_FAILED') setError(t.verify.botFailed)
      else setError(t.verify.generic)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function onEmail(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || busy) return
    if (await requestCode()) setStep('code')
  }

  async function onResend() {
    setNotice(null)
    if (await requestCode()) setNotice(t.verify.sent)
  }

  async function onCode(e: React.FormEvent) {
    e.preventDefault()
    if (!/^\d{6}$/.test(code.trim()) || busy || locked) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await formsApi.verifyCode(publicId, { email: email.trim(), code: code.trim() })
      onVerified(result.verification)
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'LOCKED' || err.status === 429)) {
        setLocked(true)
        setError(t.verify.locked)
      } else if (err instanceof ApiError && err.code === 'INVALID_CODE') {
        const left = err.details?.attemptsLeft
        setError(fill(t.verify.wrongCode, { attemptsLeft: typeof left === 'number' ? left : 0 }))
      } else {
        setError(t.verify.generic)
      }
      setBusy(false)
    }
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-4 text-left">
      <h1 className="text-xl font-semibold">{step === 'email' ? t.verify.emailTitle : t.verify.codeTitle}</h1>
      <p className="text-sm opacity-70">{step === 'email' ? t.verify.emailBody : fill(t.verify.codeBody, { email: email.trim() })}</p>
      {step === 'email' ? (
        <form onSubmit={onEmail} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wf-verify-email">{t.verify.emailLabel}</Label>
            <Input
              id="wf-verify-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t.verify.emailPlaceholder}
              autoComplete="email"
              autoFocus
              required
              maxLength={320}
              className="h-11 text-base"
              aria-invalid={error ? true : undefined}
            />
          </div>
          <StepError error={error} />
          <SubmitButton busy={busy} disabled={busy || !email.trim()} label={t.verify.sendCode} busyLabel={t.verify.sending} />
        </form>
      ) : (
        <form onSubmit={onCode} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wf-verify-code">{t.verify.codeLabel}</Label>
            <Input
              id="wf-verify-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              disabled={locked}
              className="h-11 text-base tracking-widest"
              aria-invalid={error ? true : undefined}
            />
          </div>
          <StepError error={error} />
          <StepNotice notice={notice} />
          <SubmitButton busy={busy} disabled={busy || locked || code.length !== 6} label={t.verify.verify} busyLabel={t.verify.verifying} />
          <div className="flex justify-between">
            <Button type="button" variant="ghost" onClick={onResend} disabled={busy || locked}>
              {t.verify.resend}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStep('email')
                setCode('')
                setError(null)
                setNotice(null)
              }}
              disabled={busy}
            >
              {t.verify.changeEmail}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
