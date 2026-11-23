import { format, useShop } from '@weldsuite/storefront-theme'
import { requestCode, restartSignIn, verifyCode } from '@/lib/server/actions/account'
import { Field, FormMessage, ShopForm, SubmitButton } from '../shop-form'
import { QueryError } from '../template-view'

/**
 * Passwordless sign-in in two steps: an email address, then the 6-digit code
 * sent to it. Between the steps the address waits in an httpOnly cookie.
 */
export function SignIn({ step, email, next, reason }: Readonly<{ step: 'email' | 'code'; email: string | null; next: string; reason: 'shop' | 'prices' | null }>) {
  const { shop } = useShop()
  const s = shop.strings.account
  return (
    <div className="shop-container shop-section flex max-w-lg flex-col gap-6">
      <QueryError />
      <h1 className="text-3xl font-semibold md:text-4xl">{s.signInTitle}</h1>
      {reason ? <p className="shop-notice">{reason === 'shop' ? s.signInToSeeShop : s.signInToSeePrices}</p> : null}
      {step === 'email' ? (
        <ShopForm action={requestCode} className="flex flex-col gap-5">
          <p>{s.signInIntro}</p>
          <input type="hidden" name="next" value={next} />
          <Field name="email" label={s.email} type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} enterKeyHint="send" defaultValue={email ?? ''} />
          <FormMessage />
          <div>
            <SubmitButton pendingText={s.sendingCode}>{s.sendCode}</SubmitButton>
          </div>
        </ShopForm>
      ) : (
        <>
          <ShopForm action={verifyCode} className="flex flex-col gap-5">
            <p role="status">{format(s.codeSent, { email: email ?? '' })}</p>
            <input type="hidden" name="next" value={next} />
            <Field
              name="code"
              label={s.code}
              hint={s.codeHint}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\s*\d{6}\s*"
              maxLength={12}
              enterKeyHint="done"
              autoFocus
            />
            <FormMessage />
            <div>
              <SubmitButton pendingText={s.verifying}>{s.verify}</SubmitButton>
            </div>
          </ShopForm>
          <ShopForm action={restartSignIn}>
            <SubmitButton className="text-sm underline underline-offset-4">{s.otherEmail}</SubmitButton>
          </ShopForm>
        </>
      )}
    </div>
  )
}
