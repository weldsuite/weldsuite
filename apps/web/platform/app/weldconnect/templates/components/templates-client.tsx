
import { useState, useMemo, useCallback } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter } from '@/lib/router';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  X,
  Database,
  Plug,
  FileText,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCreateWorkflow } from '@/hooks/queries/use-automation-queries';
import {
  EntityList,
  type FilterConfig,
  type GroupConfig,
  type ActiveFilter,
  type HeaderColumn,
} from '@/components/entity-list';
import {
  useLocalizedTemplates,
  useLocalizedCategories,
  LargeWorkflowPreview,
  stepActionIcons,
  stepIconColors,
  resolveTemplateForApply,
  type WorkflowTemplate,
} from '../../components/workflow-template-dialog';

export function TemplatesClient() {
  const { t } = useI18n();
  const builtInTemplates = useLocalizedTemplates();
  const CATEGORIES = useLocalizedCategories();

  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.task, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.templates },
  ]);

  const router = useRouter();
  const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplate | null>(null);
  const createWorkflowMutation = useCreateWorkflow();
  const isCreating = createWorkflowMutation.isPending;

  const handleUseTemplate = (template: WorkflowTemplate) => {
    const resolved = resolveTemplateForApply(template);
    createWorkflowMutation.mutate({
      name: template.name,
      description: template.description,
      triggers: [resolved.trigger],
      steps: resolved.steps,
    }, {
      onSuccess: (data) => {
        toast.success(t.weldconnect.templates.toasts.created.replace('{name}', template.name));
        if (data?.data?.id) {
          router.push(`/weldconnect/workflows/${data.data.id}/edit`);
        }
      },
      onError: () => {
        toast.error(t.weldconnect.templates.toasts.createFailed);
      },
    });
  };

  // Filter configurations
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'category',
      label: t.weldconnect.templatesClient.columnCategory,
      options: CATEGORIES.filter(c => c.id !== 'all').map(c => ({ value: c.id, label: c.label })),
      getDisplayValue: (value) => CATEGORIES.find(c => c.id === value)?.label || value,
    },
  ], [t, CATEGORIES]);

  // Group configurations - group by category
  const groupConfigs: GroupConfig<WorkflowTemplate>[] = useMemo(() =>
    CATEGORIES.filter(c => c.id !== 'all').map((cat, index) => ({
      id: cat.id,
      label: cat.label,
      filter: (t: WorkflowTemplate) => t.category === cat.id,
      sortOrder: index + 1,
    })),
  [CATEGORIES]);

  // Apply filters
  const applyFilters = useCallback((items: WorkflowTemplate[], filters: ActiveFilter[]) => {
    let result = items;
    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;
      if (filter.field === 'category') {
        result = filter.operator === 'is'
          ? result.filter(t => t.category === filter.value)
          : result.filter(t => t.category !== filter.value);
      }
    });
    return result;
  }, []);

  const getCategoryLabel = useCallback((categoryId: string) => {
    return CATEGORIES.find(c => c.id === categoryId)?.label || categoryId;
  }, [CATEGORIES]);

  // Header columns — mirrors the row layout in renderTemplateRow
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t.weldconnect.templatesClient.columnTemplate, width: 'min-w-[280px] flex-1' },
    { id: 'category', header: t.weldconnect.templatesClient.columnCategory, width: 'w-[140px]' },
    { id: 'steps', header: t.weldconnect.components.workflowTemplate.steps, width: 'w-[90px]' },
    { id: 'objects', header: t.weldconnect.components.workflowTemplate.requiredObjects, width: 'w-[180px]' },
    { id: 'integrations', header: t.weldconnect.components.workflowTemplate.requiredIntegrations, width: 'w-[180px]' },
    { id: 'action', header: '', width: 'w-[110px] flex-shrink-0' },
  ], [t]);

  // Render a single template row (tasks-page style)
  const renderTemplateRow = useCallback(
    (template: WorkflowTemplate) => {
      const Icon = template.icon || FileText;
      const stepCount = template.workflowSteps?.length ?? template.steps ?? 0;
      return (
        <div
          key={template.id}
          onClick={() => setSelectedTemplate(template)}
          className="flex items-center gap-4 py-3 px-4 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer group border-b border-gray-200/70 dark:border-border"
        >
          {/* Icon + Name + Description */}
          <div className="min-w-[280px] flex-1 flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-md bg-muted/50 dark:bg-secondary border border-border flex items-center justify-center flex-shrink-0">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate">
                {template.name}
              </span>
              <span className="text-xs text-muted-foreground truncate">
                {template.description}
              </span>
            </div>
          </div>

          {/* Category badge */}
          <div className="w-[140px]">
            <span className="-translate-y-[1.5px] inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-muted text-foreground">
              {getCategoryLabel(template.category)}
            </span>
          </div>

          {/* Steps count */}
          <div className="w-[90px]">
            <span className="-translate-y-[1.5px] inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none font-mono tabular-nums bg-gray-100 dark:bg-secondary text-gray-600 dark:text-muted-foreground border border-gray-200 dark:border-border">
              {stepCount}
            </span>
          </div>

          {/* Required Objects */}
          <div className="w-[180px] flex items-center gap-1 flex-wrap">
            {template.requiredObjects && template.requiredObjects.length > 0 ? (
              template.requiredObjects.slice(0, 2).map((obj) => (
                <span
                  key={obj}
                  className="inline-flex items-center gap-1 h-[22px] px-1.5 rounded text-[11px] font-medium leading-none bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400"
                >
                  <Database className="h-3 w-3" />
                  <span className="truncate max-w-[80px]">{obj}</span>
                </span>
              ))
            ) : (
              <span className="text-gray-400">—</span>
            )}
            {template.requiredObjects && template.requiredObjects.length > 2 && (
              <span className="text-[11px] text-muted-foreground">+{template.requiredObjects.length - 2}</span>
            )}
          </div>

          {/* Required Integrations */}
          <div className="w-[180px] flex items-center gap-1 flex-wrap">
            {template.requiredIntegrations && template.requiredIntegrations.length > 0 ? (
              template.requiredIntegrations.slice(0, 2).map((integration) => (
                <span
                  key={integration}
                  className="inline-flex items-center gap-1 h-[22px] px-1.5 rounded text-[11px] font-medium leading-none bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400"
                >
                  <Plug className="h-3 w-3" />
                  <span className="truncate max-w-[80px]">{integration}</span>
                </span>
              ))
            ) : (
              <span className="text-gray-400">—</span>
            )}
            {template.requiredIntegrations && template.requiredIntegrations.length > 2 && (
              <span className="text-[11px] text-muted-foreground">+{template.requiredIntegrations.length - 2}</span>
            )}
          </div>

          {/* Use button */}
          <div className="w-[110px] flex-shrink-0 flex justify-end" onClick={(e) => e.stopPropagation()}>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
              onClick={() => setSelectedTemplate(template)}
            >
              {t.weldconnect.templates.useTemplate}
            </Button>
          </div>
        </div>
      );
    },
    [getCategoryLabel, t],
  );

  return (
    <>
      <EntityList<WorkflowTemplate>
        items={builtInTemplates}
        isLoading={false}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        applyFilters={applyFilters}
        renderRow={renderTemplateRow}
        searchPlaceholder={t.weldconnect.templates.searchPlaceholder}
        searchFields={['name', 'description']}
        noResultsState={{
          title: t.weldconnect.templates.noTemplates,
          description: t.weldconnect.templates.noTemplatesDescription,
        }}
      />

      {/* Template Detail Dialog */}
      {selectedTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center animate-in fade-in duration-200">
          <div className="fixed inset-0 bg-black/50 animate-in fade-in duration-200" onClick={() => setSelectedTemplate(null)} />
          <div className="relative bg-background rounded-xl shadow-lg w-[1000px] max-w-[95vw] h-[700px] max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200">
            {/* Header */}
            <header className="flex h-12 shrink-0 items-center justify-end border-b px-4">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 -mr-2"
                onClick={() => setSelectedTemplate(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </header>

            {/* Content */}
            <div className="flex flex-1 min-h-0">
              {/* Left - Workflow Preview */}
              <div className="flex-1 border-r overflow-hidden relative">
                <LargeWorkflowPreview template={selectedTemplate} />
              </div>

              {/* Right - Details Panel */}
              <div className="w-80 flex flex-col">
                <div className="flex-1 overflow-y-auto p-4">
                  {/* Category Badge */}
                  <Badge variant="secondary" className="mb-3 rounded-sm">
                    {getCategoryLabel(selectedTemplate.category)}
                  </Badge>

                  {/* Title */}
                  <h2 className="text-lg font-semibold mb-2">{selectedTemplate.name}</h2>

                  {/* Description */}
                  <p className="text-sm text-muted-foreground mb-6">
                    {selectedTemplate.longDescription || selectedTemplate.description}
                  </p>

                  {/* Required Objects */}
                  {selectedTemplate.requiredObjects && selectedTemplate.requiredObjects.length > 0 && (
                    <div className="mb-4">
                      <h3 className="text-sm font-medium mb-2">{t.weldconnect.components.workflowTemplate.requiredObjects}</h3>
                      <div className="flex flex-col gap-2">
                        {selectedTemplate.requiredObjects.map((obj) => (
                          <div
                            key={obj}
                            className="flex items-center gap-2 text-xs text-muted-foreground"
                          >
                            <div className="w-5 h-5 rounded-[4.5px] bg-amber-100 flex items-center justify-center">
                              <Database className="w-3 h-3 text-amber-600" />
                            </div>
                            <span>{obj}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Required Integrations */}
                  {selectedTemplate.requiredIntegrations && selectedTemplate.requiredIntegrations.length > 0 && (
                    <div className="mb-4">
                      <h3 className="text-sm font-medium mb-2">{t.weldconnect.components.workflowTemplate.requiredIntegrations}</h3>
                      <div className="flex flex-col gap-2">
                        {selectedTemplate.requiredIntegrations.map((integration) => (
                          <div
                            key={integration}
                            className="flex items-center gap-2 text-xs text-muted-foreground"
                          >
                            <div className="w-5 h-5 rounded-[4.5px] bg-blue-100 flex items-center justify-center">
                              <Plug className="w-3 h-3 text-blue-600" />
                            </div>
                            <span>{integration}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Steps Overview */}
                  <div className="mb-4">
                    <h3 className="text-sm font-medium mb-2">{t.weldconnect.components.workflowTemplate.steps}</h3>
                    <div className="flex flex-col gap-1.5">
                      {selectedTemplate.workflowSteps.map((step) => {
                        const StepIcon = stepActionIcons[step.type] || FileText;
                        const iconColor = stepIconColors[step.type] || { bg: 'bg-gray-100', text: 'text-gray-600' };
                        return (
                          <div
                            key={step.id}
                            className="flex items-center gap-2 text-xs text-muted-foreground"
                          >
                            <div className={cn('w-5 h-5 rounded-[4.5px] flex items-center justify-center shrink-0', iconColor.bg)}>
                              <StepIcon className={cn('w-3 h-3', iconColor.text)} />
                            </div>
                            <span className="truncate">{step.name}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t">
                  <Button
                    className="w-full rounded-[9px]"
                    onClick={() => {
                      handleUseTemplate(selectedTemplate);
                      setSelectedTemplate(null);
                    }}
                    disabled={isCreating}
                  >
                    {isCreating ? t.weldconnect.templates.creating : t.weldconnect.templates.useTemplate}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
