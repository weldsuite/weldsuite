import type { ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { Landmark } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { PageLoader } from '@/components/page-loader';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';

const NAV = [
  { key: 'runs', href: '/weldbooks/payment-runs' },
  { key: 'checkRegister', href: '/weldbooks/payment-runs/check-register' },
  { key: 'positivePay', href: '/weldbooks/payment-runs/positive-pay' },
  { key: 'settings', href: '/weldbooks/payment-runs/settings' },
] as const;

/** The section of the payment screens a path belongs to; `runs` for the list, a run and the wizard. */
export function sectionOf(pathname: string): (typeof NAV)[number]['key'] {
  const path = pathname.replace(/\/+$/, '');
  if (path.startsWith('/weldbooks/payment-runs/check-register')) return 'checkRegister';
  if (path.startsWith('/weldbooks/payment-runs/positive-pay')) return 'positivePay';
  if (path.startsWith('/weldbooks/payment-runs/settings')) return 'settings';
  return 'runs';
}

/** Vendor payments are for US entities: anyone else gets a notice instead of the screen. */
export function UsOnlyGate({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const tu = t.weldbooksUs.payments.usOnly;
  const { code, isError } = useCurrentJurisdiction();

  if (!code && !isError) return <PageLoader fullScreen={false} />;
  if (code && !isUsJurisdictionCode(code)) {
    return (
      <div className="p-6">
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

interface PaymentRunsFrameProps {
  title: string;
  subtitle?: string;
  /** Buttons on the right of the title. */
  actions?: ReactNode;
  children: ReactNode;
}

/** The shell of every vendor payment screen: the US gate, the title and the section tabs. */
export function PaymentRunsFrame({ title, subtitle, actions, children }: Readonly<PaymentRunsFrameProps>) {
  const { t } = useI18n();
  const tn = t.weldbooksUs.payments.nav;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = sectionOf(pathname);

  return (
    <UsOnlyGate>
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
    </UsOnlyGate>
  );
}
