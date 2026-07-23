import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import { useProject } from '@/hooks/queries/use-projects-queries';
import {
  SimpleObjectPanel,
  formatPanelDate,
  formatPanelMoney,
  SectionHeader,
  ProseBlock,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';

interface ProjectRecord {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  customerId: string | null;
  customerName?: string | null;
  projectManagerId: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  budgetedHours: string | null;
  budgetedAmount: string | null;
  currency?: string | null;
  createdAt: string;
}

export function ProjectPanel(props: ObjectPanelComponentProps) {
  const t = useTranslations();
  const { id } = props;
  const { data, isLoading, error } = useProject(id);
  const project = (data?.data ?? null) as ProjectRecord | null;

  const title = project?.name ?? t('sweep.entities.projectFallbackTitle');
  const subtitle = project?.code
    ? `${project.code}${project.status ? ' · ' + project.status : ''}`
    : project?.status ?? undefined;

  return (
    <SimpleObjectPanel
      {...props}
      objectType="project"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!project}
      title={project ? title : undefined}
      subtitle={subtitle ?? undefined}
      openHref={project ? `/weldflow/projects/${project.id}` : undefined}
      statusBadges={project && (
        <>
          {project.status && <Badge variant="outline" className="capitalize">{project.status}</Badge>}
          {project.code && <Badge variant="secondary">{project.code}</Badge>}
        </>
      )}
      fields={
        project
          ? [
              { label: t('sweep.entities.fieldCustomer'), value: project.customerName },
              { label: t('sweep.entities.fieldBudget'), value: formatPanelMoney(project.budgetedAmount, project.currency ?? undefined) },
              { label: t('sweep.entities.fieldBudgetedHours'), value: project.budgetedHours },
              { label: t('sweep.entities.fieldStartDate'), value: formatPanelDate(project.startDate) },
              { label: t('sweep.entities.fieldEndDate'), value: formatPanelDate(project.endDate) },
              { label: t('sweep.entities.fieldActualStart'), value: formatPanelDate(project.actualStartDate) },
              { label: t('sweep.entities.fieldActualEnd'), value: formatPanelDate(project.actualEndDate) },
              { label: t('sweep.entities.fieldCreated'), value: formatPanelDate(project.createdAt) },
            ]
          : undefined
      }
      extras={
        project && project.description && (
          <>
            <SectionHeader>{t('sweep.entities.fieldDescription')}</SectionHeader>
            <ProseBlock>{project.description}</ProseBlock>
          </>
        )
      }
    />
  );
}
