/** "Advanced signature" or "Qualified signature" next to a signer; nothing for a simple one. */

import { ShieldCheck } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import type { SignTrustLevel } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';

export function SignatureLevelBadge({ level }: Readonly<{ level: SignTrustLevel | undefined }>) {
  const { t } = useI18n();
  if (!level) return null;
  return (
    <Badge variant="secondary" className="shrink-0 gap-1">
      <ShieldCheck className="size-3" aria-hidden />
      {t.weldsign.eidas.badges[level]}
    </Badge>
  );
}
