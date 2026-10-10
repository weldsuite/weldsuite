import { Navigate } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageLoader } from '@/components/page-loader';
import { MY_HR_PATHS } from '../../access';
import { useMyHrSelf } from '../components/my-hr-context';
import { MyHrPage } from '../components/my-hr-page';
import { useMyPayroll } from '../components/my-payroll';
import { MyPayrollTab } from '../components/payroll-tab';

/**
 * My HR → Payroll: your payslips, annual statements, payment details and tax
 * forms. Only with the weldhr-payroll flag and once you are on payroll (or
 * have payslips); otherwise the link lands on the My HR overview.
 */
export default function MyPayrollPage() {
  const t = useTranslations();
  const { employee } = useMyHrSelf();
  const payroll = useMyPayroll();

  if (payroll.isLoading) return <PageLoader fullScreen={false} />;
  if (!payroll.show) return <Navigate to={MY_HR_PATHS.overview} replace />;

  return (
    <MyHrPage title={t('weldhr.me.pages.payroll')}>
      <MyPayrollTab employeeName={employee.displayName} />
    </MyHrPage>
  );
}
