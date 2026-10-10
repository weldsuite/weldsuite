/**
 * A partner's public face: logo, name and contact links. Shared by the managed
 * billing page, the territory screen and the banners. Every URL is checked
 * with `safeHttpUrl` because the partner typed it and other people see it.
 */

import { ExternalLink, Globe, LifeBuoy, Mail } from 'lucide-react';
import type { PartnerPublicInfo } from '@weldsuite/app-api-client/schemas/partners';
import { useI18n } from '@/lib/i18n/provider';
import { safeHttpUrl } from '@/lib/partner/safe-url';

export function PartnerLogo({ partner, className = 'h-10 w-10' }: Readonly<{ partner: PartnerPublicInfo; className?: string }>) {
  const logo = safeHttpUrl(partner.logoUrl);
  if (logo) {
    return <img src={logo} alt="" className={`${className} shrink-0 rounded-md border bg-white object-contain`} />;
  }
  return (
    <div
      aria-hidden
      className={`${className} flex shrink-0 items-center justify-center rounded-md border bg-muted text-sm font-semibold`}
    >
      {partner.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

/** `mailto:` link for a partner's support address, with an optional prefilled message. */
export function supportMailto(email: string, subject?: string, body?: string): string {
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  const query = params.toString().replaceAll('+', '%20');
  return `mailto:${email}${query ? `?${query}` : ''}`;
}

export function PartnerContactLinks({ partner }: Readonly<{ partner: PartnerPublicInfo }>) {
  const { t } = useI18n();
  const tm = t.partner.managed;
  const website = safeHttpUrl(partner.websiteUrl);
  const support = safeHttpUrl(partner.supportUrl);

  const linkClass = 'inline-flex items-center gap-2 text-sm underline-offset-2 hover:underline';
  return (
    <ul className="space-y-2">
      {website && (
        <li>
          <a href={website} target="_blank" rel="noopener noreferrer" className={linkClass}>
            <Globe className="h-4 w-4 text-muted-foreground" aria-hidden />
            {tm.website}
            <ExternalLink className="h-3 w-3 text-muted-foreground" aria-hidden />
          </a>
        </li>
      )}
      {partner.supportEmail && (
        <li>
          <a href={supportMailto(partner.supportEmail)} className={linkClass}>
            <Mail className="h-4 w-4 text-muted-foreground" aria-hidden />
            {partner.supportEmail}
          </a>
        </li>
      )}
      {support && (
        <li>
          <a href={support} target="_blank" rel="noopener noreferrer" className={linkClass}>
            <LifeBuoy className="h-4 w-4 text-muted-foreground" aria-hidden />
            {tm.supportPage}
            <ExternalLink className="h-3 w-3 text-muted-foreground" aria-hidden />
          </a>
        </li>
      )}
    </ul>
  );
}
