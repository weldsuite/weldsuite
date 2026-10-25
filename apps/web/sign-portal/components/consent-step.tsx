import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { BrandButton } from './brand-button';
import { usePortal } from './portal-context';

interface ConsentStepProps {
  title: string;
  senderName: string | null;
  message: string | null;
  busy: boolean;
  error: string | null;
  onAgree: () => void;
  onDecline: () => void;
}

/** The e-signature disclosure the signer has to accept before seeing the fields. */
export function ConsentStep({ title, senderName, message, busy, error, onAgree, onDecline }: Readonly<ConsentStepProps>) {
  const { t } = usePortal();
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-4 p-3 sm:p-6">
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm sm:p-6">
        <h1 className="text-xl font-semibold">{t.consent.title}</h1>
        <p className="text-sm">{senderName ? t.consent.intro(senderName, title) : t.consent.introNoSender(title)}</p>
        {message ? <p className="whitespace-pre-line rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">{message}</p> : null}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm sm:p-6" aria-labelledby="sign-disclosure-title">
        <h2 id="sign-disclosure-title" className="text-base font-semibold">
          {t.consent.disclosureTitle}
        </h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted-foreground">
          {t.consent.disclosure.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 pt-1 sm:flex-row-reverse">
          <BrandButton size="lg" className="sm:flex-1" onClick={onAgree} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {busy ? t.consent.agreeing : t.consent.agree}
          </BrandButton>
          <Button variant="ghost" size="lg" onClick={onDecline} disabled={busy}>
            {t.consent.decline}
          </Button>
        </div>
      </section>
    </main>
  );
}
