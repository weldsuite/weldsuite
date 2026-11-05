import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Info, Loader2 } from 'lucide-react'
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert'
import { Button } from '@weldsuite/ui/components/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form'
import { Input } from '@weldsuite/ui/components/input'
import { PORTAL_CODE_LENGTH } from '@weldsuite/app-api-client/schemas/project-portal'
import { requestCode, verifyCode, type FailureCode } from '@/lib/portal'
import type { PortalStrings } from '@/lib/i18n'
import { usePortal } from '@/components/portal-context'

/** Seconds before "send a new code" is offered again. flow-api limits requests per address as well. */
const RESEND_COOLDOWN = 30

type EmailValues = { email: string }
type CodeValues = { code: string }

/** The message for a call that failed. 401 here means the code was wrong or has expired. */
function failureText(t: PortalStrings, code: FailureCode): string {
  switch (code) {
    case 'wrong_code':
      return t.signIn.errors.wrongCode
    case 'rate_limited':
      return t.signIn.errors.rateLimited
    case 'unavailable':
      return t.signIn.errors.unavailable
    case 'invalid':
      return t.signIn.errors.codeInvalid
    default:
      return t.signIn.errors.generic
  }
}

function Notice({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Alert>
      <Info aria-hidden="true" />
      <AlertDescription role="status">{children}</AlertDescription>
    </Alert>
  )
}

function Problem({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  )
}

/** Sign in with an emailed code: the address first, then the six digits. No password, no account. */
export function SignIn({
  workspace,
  reason,
}: Readonly<{ workspace: string; reason?: 'expired' | 'revoked' }>) {
  const { t, locale, fill } = usePortal()
  const [email, setEmail] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const [resending, setResending] = useState(false)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setTimeout(() => setCooldown((seconds) => seconds - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  const emailSchema = useMemo(
    () =>
      z.object({
        email: z
          .string()
          .trim()
          .min(1, t.signIn.errors.emailRequired)
          .max(255, t.signIn.errors.emailInvalid)
          .email(t.signIn.errors.emailInvalid),
      }),
    [t],
  )
  const codeSchema = useMemo(
    () =>
      z.object({
        code: z.string().trim().regex(new RegExp(`^[0-9]{${PORTAL_CODE_LENGTH}}$`), t.signIn.errors.codeInvalid),
      }),
    [t],
  )
  const emailForm = useForm<EmailValues>({ resolver: zodResolver(emailSchema), defaultValues: { email: '' } })
  const codeForm = useForm<CodeValues>({ resolver: zodResolver(codeSchema), defaultValues: { code: '' } })

  async function sendCode(address: string): Promise<boolean> {
    const result = await requestCode({ data: { workspace, email: address, locale } })
    if (result.ok) return true
    setProblem(result.code === 'invalid' ? t.signIn.errors.emailInvalid : failureText(t, result.code))
    return false
  }

  async function onEmail(values: EmailValues) {
    setProblem(null)
    const address = values.email.trim()
    if (await sendCode(address)) {
      setEmail(address)
      setInfo(t.signIn.codeSent)
      setCooldown(RESEND_COOLDOWN)
      codeForm.reset({ code: '' })
    }
  }

  async function onResend() {
    if (!email || cooldown > 0 || resending) return
    setProblem(null)
    setResending(true)
    try {
      if (await sendCode(email)) {
        setInfo(t.signIn.resent)
        setCooldown(RESEND_COOLDOWN)
      }
    } finally {
      setResending(false)
    }
  }

  async function onCode(values: CodeValues) {
    if (!email) return
    setProblem(null)
    const result = await verifyCode({ data: { workspace, email, code: values.code.trim() } })
    if (result.ok) {
      // A full load: the new session cookie and a clean cache, straight to the projects.
      window.location.assign(`/${encodeURIComponent(workspace)}/projects`)
      return
    }
    setProblem(failureText(t, result.code))
  }

  function changeEmail() {
    setEmail(null)
    setInfo(null)
    setProblem(null)
    setCooldown(0)
  }

  return (
    <div className="mx-auto w-full max-w-md py-8 sm:py-14">
      <div className="rounded-xl border bg-card p-5 sm:p-7">
        <h1 className="text-xl font-semibold">{email ? t.signIn.codeTitle : t.signIn.title}</h1>
        {!email && <p className="mt-1.5 text-sm text-muted-foreground">{t.signIn.subtitle}</p>}

        <div className="mt-5 flex flex-col gap-4">
          {!email && reason && <Notice>{reason === 'revoked' ? t.signIn.notices.revoked : t.signIn.notices.expired}</Notice>}

          {email === null ? (
            <Form {...emailForm}>
              <form onSubmit={emailForm.handleSubmit(onEmail)} noValidate className="flex flex-col gap-4">
                <FormField
                  control={emailForm.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t.signIn.emailLabel}</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          autoFocus
                          placeholder={t.signIn.emailPlaceholder}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {problem && <Problem>{problem}</Problem>}
                <Button type="submit" disabled={emailForm.formState.isSubmitting}>
                  {emailForm.formState.isSubmitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                  {emailForm.formState.isSubmitting ? t.signIn.sendingCode : t.signIn.sendCode}
                </Button>
              </form>
            </Form>
          ) : (
            <>
              {info && <Notice>{info}</Notice>}
              <p className="text-sm text-muted-foreground">{fill(t.signIn.codeBody, { email })}</p>
              <Form {...codeForm}>
                <form onSubmit={codeForm.handleSubmit(onCode)} noValidate className="flex flex-col gap-4">
                  <FormField
                    control={codeForm.control}
                    name="code"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t.signIn.codeLabel}</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            onChange={(event) => field.onChange(event.target.value.replace(/\D/g, '').slice(0, PORTAL_CODE_LENGTH))}
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            autoFocus
                            maxLength={PORTAL_CODE_LENGTH}
                            placeholder="000000"
                            className="text-center font-mono text-lg tracking-[0.4em]"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  {problem && <Problem>{problem}</Problem>}
                  <Button type="submit" disabled={codeForm.formState.isSubmitting}>
                    {codeForm.formState.isSubmitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                    {codeForm.formState.isSubmitting ? t.signIn.verifying : t.signIn.verify}
                  </Button>
                </form>
              </Form>
              <div className="flex flex-col gap-1 sm:flex-row sm:justify-between">
                <Button
                  type="button"
                  variant="link"
                  className="h-auto justify-start p-0"
                  disabled={cooldown > 0 || resending}
                  onClick={() => void onResend()}
                >
                  {cooldown > 0 ? fill(t.signIn.resendIn, { seconds: cooldown }) : t.signIn.resend}
                </Button>
                <Button type="button" variant="link" className="h-auto justify-start p-0" onClick={changeEmail}>
                  {t.signIn.differentEmail}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
