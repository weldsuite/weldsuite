
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

  return <DepartmentForm mode="edit" department={result.data} />;
}
