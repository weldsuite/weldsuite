
import { useParams } from '@/lib/router';
import { useDepartment } from '@/hooks/queries/use-helpdesk-queries';
import { DepartmentForm } from '../../components/department-form';
import { PageLoader } from '@/components/page-loader';

export default function EditDepartmentPage() {
  const params = useParams();
  const departmentId = params.id as string;

  const { data: result, isLoading } = useDepartment(departmentId, !!departmentId);

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!result?.success || !result?.data) return null;

  const department = result.data;
  // app-api's business hours don't carry a per-department timezone; the form
  // only reads it for display, so default rather than block the edit form.
  const businessHours = department.businessHours
    ? { timezone: 'UTC', ...department.businessHours }
    : undefined;

  return <DepartmentForm mode="edit" department={{ ...department, businessHours }} />;
}
