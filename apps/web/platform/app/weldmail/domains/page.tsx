import { Globe } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';

// Mail-domain management moved into WeldHost. Say so, instead of silently
// redirecting, and offer the way there.
export default function DomainsPage() {
  const { t } = useI18n();

  return (
    <div className="flex h-full items-center justify-center p-6" data-testid="weldmail-domains-moved">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Globe className="size-5" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">{t.mail.domains.movedTitle}</h2>
        <p className="text-sm text-muted-foreground">{t.mail.domains.movedDescription}</p>
        <Button asChild className="mt-1">
          <Link href="/weldhost/domains">{t.mail.domains.openWeldHost}</Link>
        </Button>
      </div>
    </div>
  );
}
