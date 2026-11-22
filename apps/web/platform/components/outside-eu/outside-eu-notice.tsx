import type { OutsideEuService } from '@weldsuite/app-api-client/schemas/outside-eu-services';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { countryName, fill } from '@/app/settings/outside-eu/outside-eu-view';
import {
  hasOutsideEuServices,
  outsideEuServiceFor,
  useOutsideEuServiceFor,
  useOutsideEuServices,
} from '@/hooks/queries/use-outside-eu-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';

/** Where the switches are. */
export const OUTSIDE_EU_SETTINGS_PATH = '/settings/outside-eu';

/**
 * The "Leaves the EU" label for an integration code (`gmail`, `slack`, …) or
 * service id: nothing for an EU service, or where the install doesn't
 * enforce the opt-in (Global, self-hosted). Only the EU edition offers it
 * (`outside-eu-services`); elsewhere nothing is asked of the API.
 */
export function OutsideEuBadge(props: Readonly<{ code: string; className?: string }>) {
  return hasOutsideEuServices() ? <ServiceBadge {...props} /> : null;
}

function ServiceBadge({ code, className }: Readonly<{ code: string; className?: string }>) {
  const { t } = useI18n();
  const to = t.settings.outsideEu;
  const service = useOutsideEuServiceFor(code);
  if (!service) return null;
  return (
    <SoftBadge
      tone="warning"
      className={className}
      title={fill(to.where, { company: service.company, country: countryName(to, service.country) })}
      data-testid={`outside-eu-badge-${service.id}`}
    >
      {to.leavesEu}
    </SoftBadge>
  );
}

/** Each service once, in the order given. */
function servicesFor(
  data: Parameters<typeof outsideEuServiceFor>[0],
  codes: readonly string[],
): OutsideEuService[] {
  const found: OutsideEuService[] = [];
  for (const code of codes) {
    const service = outsideEuServiceFor(data, code);
    if (service && !found.some((s) => s.id === service.id)) found.push(service);
  }
  return found;
}

/**
 * What a page's services outside the EU mean for the workspace: the ones
 * switched off are named with why the features that need them don't work
 * and a link to the switches; when all are on, a quiet note that they are
 * used. Nothing where the install doesn't enforce the opt-in.
 */
export function OutsideEuNotice(props: Readonly<{ services: readonly string[]; className?: string }>) {
  return hasOutsideEuServices() ? <ServicesNotice {...props} /> : null;
}

function ServicesNotice({ services, className }: Readonly<{ services: readonly string[]; className?: string }>) {
  const { t } = useI18n();
  const to = t.settings.outsideEu;
  const { data } = useOutsideEuServices(services.length > 0);
  if (!data?.enforced) return null;
  const found = servicesFor(data, services);
  if (found.length === 0) return null;
  const names = (list: OutsideEuService[]) => list.map((s) => s.name).join(', ');
  const off = found.filter((s) => !s.enabled);
  const link = (
    <Link href={OUTSIDE_EU_SETTINGS_PATH} className="text-sm font-medium underline underline-offset-4">
      {to.notice.link}
    </Link>
  );
  if (off.length > 0) {
    return (
      <InfoBanner
        variant="warning"
        className={className}
        title={fill(to.notice.offTitle, { services: names(off) })}
        action={link}
        data-testid="outside-eu-notice"
      >
        {to.notice.off}
      </InfoBanner>
    );
  }
  return (
    <InfoBanner variant="neutral" className={className} action={link} data-testid="outside-eu-notice">
      {fill(to.notice.on, { services: names(found) })}
    </InfoBanner>
  );
}
