/**
 * Entry point to the partner portal, shown in the workspace sidebar to people
 * who belong to a partner and to nobody else (`GET /api/partner/me` answers an
 * empty list for everyone else).
 */

import { Handshake } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';
import { usePartnerMemberships } from '@/lib/partner/partner-context';
import { Link } from '@/lib/router';

export function PartnerPortalLink({ collapsed = false }: Readonly<{ collapsed?: boolean }>) {
  const { t } = useI18n();
  const { memberships } = usePartnerMemberships();

  if (memberships.length === 0) return null;
  const label = t.partner.menuEntry;

  if (collapsed) {
    return (
      <div className="mb-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-md text-muted-foreground transition-colors hover:text-foreground"
            >
              <Link href="/partner" aria-label={label}>
                <Handshake className="h-4 w-4" />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <Button
      asChild
      variant="ghost"
      className="mb-2 flex w-full items-center justify-start gap-2 rounded-md px-3 py-[7px] text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <Link href="/partner">
        <Handshake className="h-4 w-4" />
        <span>{label}</span>
      </Link>
    </Button>
  );
}

/** The same entry for the mobile navigation sheet. */
export function PartnerPortalMobileEntry({ onNavigate }: Readonly<{ onNavigate: () => void }>) {
  const { t } = useI18n();
  const { memberships } = usePartnerMemberships();

  if (memberships.length === 0) return null;

  return (
    <Button
      asChild
      variant="ghost"
      className="flex w-full items-center justify-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <Link href="/partner" onClick={onNavigate}>
        <Handshake className="h-4 w-4" />
        <span>{t.partner.menuEntry}</span>
      </Link>
    </Button>
  );
}
