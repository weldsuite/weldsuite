import { AlertTriangle, ShieldCheck } from 'lucide-react';
import type { SignatureLevel, SignatureReturn } from '@/lib/eidas';
import type { Dictionary } from '@/lib/i18n';

/** Why the signer is back from their trust service provider without having signed. */
export function ReturnedNotice({ returned, provider, t }: Readonly<{ returned: SignatureReturn; provider: string | null; t: Dictionary }>) {
  return (
    <p role="alert" className="mt-3 flex items-start gap-2 rounded-xl border border-amber-600/30 bg-amber-600/5 p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
      {returned === 'cancelled' ? t.eidas.returnedCancelled : t.eidas.returnedFailed(provider)}
    </p>
  );
}

/** Which signature level is asked, and where the signer confirms who they are. */
export function LevelNotice({
  level,
  provider,
  t,
}: Readonly<{ level: NonNullable<SignatureLevel>; provider: string | null; t: Dictionary }>) {
  return (
    <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" />
      <span>
        <span className="font-medium text-foreground">{t.eidas.levelTitle[level]}. </span>
        {provider ? t.eidas.confirmWith(provider) : t.eidas.confirmWithoutProvider}
      </span>
    </p>
  );
}
