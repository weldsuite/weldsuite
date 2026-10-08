import type { ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { Landmark } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { PageLoader } from '@/components/page-loader';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';

const NAV = [
  { key: 'overview', href: '/weldbooks/sales-tax' },
  { key: 'returns', href: '/weldbooks/sales-tax/returns' },
  { key: 'reports', href: '/weldbooks/sales-tax/reports' },
  { key: 'certificates', href: '/weldbooks/sales-tax/certificates/reports' },
  { key: 'nexus', href: '/weldbooks/sales-tax/nexus' },
] as const;

export type SalesTaxSection = (typeof NAV)[number]['key'];

/** The section of the Sales Tax Center a path belongs to; `overview` for the landing page and anything else. */
export function sectionOf(pathname: string): SalesTaxSection {
  const path = pathname.replace(/\/+$/, '');
  if (path.startsWith('/weldbooks/sales-tax/returns')) return 'returns';
  if (path.startsWith('/weldbooks/sales-tax/reports')) return 'reports';
  if (path.startsWith('/weldbooks/sales-tax/certificates')) return 'certificates';
  if (path.startsWith('/weldbooks/sales-tax/nexus')) return 'nexus';
  return 'overview';
}

/** Sales tax is for US entities: anyone else gets a notice instead of the screen. */
export function SalesTaxGate({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const tu = t.weldbooksUs.salesTax.center.usOnly;
  const { features, isResolved, isError } = useCurrentJurisdiction();

  // Never assume a jurisdiction while it is unknown: wait for it, but let the API answer when it cannot be loaded.
  if (!isResolved && !isError) return <PageLoader fullScreen={false} />;
  if (isResolved && !features.salesTax) {
    return (
      <div className="p-4 sm:p-6">
        <Card>
          <CardContent className="space-y-3 py-10 text-center">
            <Landmark className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="font-medium">{tu.title}</p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">{tu.description}</p>
            <Button asChild variant="outline">
              <Link to="/weldbooks/dashboard">{tu.back}</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}

interface SalesTaxFrameProps {
  title: string;
  subtitle?: string;
  /** Buttons on the right of the title. */
  actions?: ReactNode;
  children: ReactNode;
}

/** The shell of every Sales Tax Center screen: the US gate, the title and the section tabs. */
export function SalesTaxFrame({ title, subtitle, actions, children }: Readonly<SalesTaxFrameProps>) {
  const { t } = useI18n();
  const tn = t.weldbooksUs.salesTax.center.nav;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = sectionOf(pathname);

  return (
    <SalesTaxGate>
      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">{title}</h1>
            {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>

        <nav aria-label={tn.title} className="flex flex-wrap gap-1 border-b">
          {NAV.map((item) => (
            <Link
              key={item.key}
              to={item.href}
              aria-current={active === item.key ? 'page' : undefined}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                active === item.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tn[item.key]}
            </Link>
          ))}
        </nav>

        {children}
      </div>
    </SalesTaxGate>
  );
}
