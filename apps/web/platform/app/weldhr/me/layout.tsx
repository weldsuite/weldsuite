import { useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { UserPlus, UserRoundSearch } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { useMyHr } from '@/hooks/queries/use-weldhr-queries';
import { CreateEmployeeDialog } from '../employees/components/create-employee-dialog';
import { DetailPage, emptyIcon } from '../components/page-kit';
import { ErrorBanner, errorMessage } from '../components/shared';
import { MyHrProvider } from './components/my-hr-context';
import { useMyHrBreadcrumbs } from './components/my-hr-page';

/**
 * My HR: the signed-in member's own WeldHR employee record, one page per
 * sidebar item (overview, time off, expenses, schedule, payroll, tasks, reviews).
 * Every endpoint resolves the employee from the session, so these pages never
 * take an employee id. This layout loads that record once; members who are not
 * linked to an employee (or whose record is terminated) get a "not set up yet"
 * state instead of the page.
 */
export default function MyHrLayout({ children }: Readonly<{ children: ReactNode }>) {
  const t = useTranslations();
  const { can, isOwner, isLoading: permissionsLoading } = usePermissions();
  // Same rule as the sidebar: the owner always passes (the server resolves an owner to '*').
  const allowed = isOwner || can('employees:self');
  const { data: self, isLoading, error } = useMyHr({ enabled: allowed });

  if (permissionsLoading || isLoading) return <PageLoader fullScreen={false} />;

  if (!allowed) {
    return (
      <MyHrState>
        <ErrorBanner error={t('weldhr.common.noPermission')} />
      </MyHrState>
    );
  }

  if (!self) {
    return (
      <MyHrState>
        <ErrorBanner error={errorMessage(error, t('weldhr.me.loadFailed'))} />
      </MyHrState>
    );
  }

  if (!self.employee) return <NotSetUp />;

  return <MyHrProvider value={{ employee: self.employee, features: self.features }}>{children}</MyHrProvider>;
}

/**
 * Shown instead of the page. Sets the breadcrumb itself: a page sets its own,
 * and a child's effect runs before its parent's, so the layout must not set
 * one while it renders a page.
 */
function MyHrState({ children }: Readonly<{ children: ReactNode }>) {
  useMyHrBreadcrumbs();
  return <DetailPage>{children}</DetailPage>;
}

/**
 * The member has My HR access but no (active) employee record to show. Someone
 * who can add employees (usually the HR admin themselves) gets to add their own
 * record right here instead of being told to ask HR.
 */
function NotSetUp() {
  const t = useTranslations();
  const { can } = usePermissions();
  const { userId } = useAuth();
  const [adding, setAdding] = useState(false);
  const canAddSelf = Boolean(userId) && (can('employees:create') || can('employees:manage'));
  return (
    <MyHrState>
      <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
        {emptyIcon(UserRoundSearch)}
        <h2 className="mb-1.5 text-[15px] font-semibold">{t('weldhr.me.notSetUp.title')}</h2>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          {canAddSelf ? t('weldhr.me.notSetUp.descriptionAdmin') : t('weldhr.me.notSetUp.description')}
        </p>
        {canAddSelf && (
          <Button size="sm" className="mt-4" onClick={() => setAdding(true)}>
            <UserPlus className="mr-1.5 h-4 w-4" />
            {t('weldhr.me.notSetUp.addMe')}
          </Button>
        )}
      </div>
      {adding && userId && (
        // Creating the record refetches My HR (every WeldHR query is invalidated), which then renders the page.
        <CreateEmployeeDialog defaultUserId={userId} onClose={() => setAdding(false)} onCreated={() => setAdding(false)} />
      )}
    </MyHrState>
  );
}
