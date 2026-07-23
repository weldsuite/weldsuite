
import { useParams, useRouter } from '@/lib/router';
import { MemberForm } from '../../../components/member-form';
import { useDepartment, useHelpdeskUsers } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';

export default function NewMemberPage() {
  const params = useParams();
  const router = useRouter();
  const departmentId = params.id as string;

  const { data: deptResult, isLoading: deptLoading } = useDepartment(departmentId);
  const { data: usersResult, isLoading: usersLoading } = useHelpdeskUsers();

  const isLoading = deptLoading || usersLoading;

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!deptResult?.success || !deptResult?.data) {
    router.push('/welddesk/teams');
    return null;
  }

  return (
    <MemberForm
      departmentId={departmentId}
      departmentName={deptResult.data.name}
      users={usersResult?.data || []}
      mode="add"
    />
  );
}
