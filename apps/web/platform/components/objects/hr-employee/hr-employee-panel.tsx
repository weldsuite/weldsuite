/**
 * WeldHR employee object panel.
 *
 * The record view of an employee, built like the WeldCRM company panel
 * (`components/objects/company/company-panel.tsx`): the `EntityDetailView`
 * shell from `useObjectPanelShell` (side panel ↔ fullscreen, previous / next,
 * back arrow), an avatar + name header with email / call buttons and the "⋮"
 * menu, the icon tab strip whose tabs can be hidden from that menu, and a
 * Details tab of inline-editable property rows.
 *
 * It replaces the standalone `/weldhr/employees/:id` page, which now redirects
 * to the employee list with this panel open in fullscreen.
 *
 * Tabs: Details · Direct reports · Personal · Attendance · Leave · Payroll,
 * each shown only with the permission (and, for payroll, the feature flag) the
 * old page asked for.
 */

import { useCallback, useMemo, useState, type ComponentProps } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  Briefcase,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarX,
  CircleUser,
  Clock,
  EllipsisVertical,
  Globe,
  Hash,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Smile,
  Speech,
  SquareArrowOutUpRight,
  Trash2,
  User,
  UserRound,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr';
import {
  hrEmployeeStatusSchema,
  hrEmploymentTypeSchema,
  type UpdateHrEmployeeInput,
} from '@weldsuite/app-api-client/schemas/weldhr';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import {
  ObjectPanelTabs,
  useObjectPanel,
  useObjectPanelNavigationReporter,
  useObjectPanelShell,
  useObjectPanelTabConfig,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { EntityList, type ActiveFilter, type FilterConfig, type HeaderColumn } from '@/components/entity-list';
import { applySelectFilters } from '@/lib/list-filters';
import { CustomFieldsSidebarSection } from '@/components/custom-fields/custom-fields-sidebar-section';
import { ConfigureTabsSubmenu } from '@/components/objects/_shared/configure-tabs-submenu';
import { LinkedRecordStatus } from '@/components/objects/_shared/linked-record-row';
import { PropertyRow, StatusPropertyRow } from '@/components/objects/_shared/property-row';
import { PanelRow, RecordLoadFailed } from '@/components/objects/_shared/record-panel-parts';
import { SelectPropertyRow, type SelectPropertyOption } from '@/components/objects/_shared/select-property-row';
import {
  PeopleIllustration,
  TAB_EMPTY_STATE_TABLE_CLASS,
  tabBodyClassName,
} from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useComposeSafe } from '@/contexts/compose-context';
import {
  useDeleteHrEmployee,
  useHrDepartments,
  useHrEmployee,
  useHrEmployees,
  useUpdateHrEmployee,
} from '@/hooks/queries/use-weldhr-queries';
import { useHrPayrollFlag } from '@/hooks/queries/use-weldhr-payroll-queries';
import { EmployeeAttendanceTab } from '@/app/weldhr/components/employee-tabs/attendance-tab';
import { EmployeeLeaveTab } from '@/app/weldhr/components/employee-tabs/leave-tab';
import { EmployeePayrollTab } from '@/app/weldhr/components/employee-tabs/payroll-tab';
import { errorMessage, formatDate } from '@/app/weldhr/components/shared';
import { EditEmployeeDialog } from '@/app/weldhr/employees/components/edit-employee-dialog';
import { isPhoneNumber } from '@/app/weldhr/employees/components/employee-field-rules';
import { SensitivePanel } from '@/app/weldhr/employees/components/sensitive-panel';
import { EmployeeWorkspaceAccountRow } from '@/app/weldhr/employees/components/workspace-account-row';
import {
  HR_EMPLOYEE_PANEL_TYPE,
  HR_EMPLOYEE_STATUS_TONE,
  HR_EMPLOYEE_TAB_ICONS,
  isHrEmployeeTabId,
  type HrEmployeeTabId,
} from './hr-employee-tabs';

const HR_EMPLOYEE_PANEL_WIDTH = 400;

/** Who can still be someone's manager: everyone not gone. */
const MANAGER_STATUSES = 'onboarding,active,on_leave,offboarding';

const STATUS_COLOR = HR_EMPLOYEE_STATUS_TONE;

const emailSchema = z.string().email();

type Translate = ReturnType<typeof useTranslations>;

// ─── Header ────────────────────────────────────────────────────────────────

function EmployeePanelAvatar({ employee }: Readonly<{ employee?: HrEmployeeDetail }>) {
  if (!employee) return <div className="size-[22px] rounded-[32%] bg-muted animate-pulse" />;
  return (
    <Avatar className="size-[22px]">
      {employee.avatarUrl && (
        <AvatarImage src={employee.avatarUrl} alt={employee.displayName} className="object-cover" />
      )}
      <AvatarFallback className="bg-muted text-[10px] font-medium">
        {(employee.displayName.trim()[0] ?? '#').toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

function EmployeePanelTitle({ employee }: Readonly<{ employee?: HrEmployeeDetail }>) {
  if (!employee) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <span className="block text-[15px] font-medium leading-6 text-foreground truncate">
      {employee.displayName}
    </span>
  );
}

type TabConfigEntry = { id: HrEmployeeTabId; label: string; required?: boolean; defaultVisible: boolean };

/** The header actions of an employee: email, call and the "⋮" menu. */
function EmployeePanelActions({
  employee,
  canUpdate,
  canDelete,
  onEdit,
  onDelete,
  tabFields,
  isTabVisible,
  onToggleTab,
  onResetTabs,
}: Readonly<{
  employee?: HrEmployeeDetail;
  canUpdate: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
  tabFields: TabConfigEntry[];
  isTabVisible: (id: string) => boolean;
  onToggleTab: (id: string) => void;
  onResetTabs: () => void;
}>) {
  const t = useTranslations();
  const compose = useComposeSafe();
  if (!employee) return null;

  const handleCompose = () => {
    if (compose) {
      compose.openCompose({ to: employee.email });
      return;
    }
    window.location.href = `mailto:${employee.email}`;
  };

  // Same 28px icon buttons as the shell's Expand / Close, returned as a
  // fragment so the shell's own spacing applies between every header button.
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7"
            onClick={handleCompose}
            aria-label={t('sweep.entities.composeEmail')}
          >
            <Mail className="size-4 text-muted-foreground" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('sweep.entities.composeEmail')}</TooltipContent>
      </Tooltip>
      {employee.phone && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              onClick={() => {
                window.location.href = `tel:${employee.phone}`;
              }}
              aria-label={t('sweep.entities.call')}
            >
              <Phone className="size-4 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('sweep.entities.call')}</TooltipContent>
        </Tooltip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={t('sweep.entities.moreActions')}
          >
            <EllipsisVertical className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* Every field, including the employer and work locations the
              Details rows don't edit. */}
          {canUpdate && (
            <DropdownMenuItem onClick={onEdit}>
              <Pencil />
              {t('weldhr.employees.detail.actions.edit')}
            </DropdownMenuItem>
          )}
          <ConfigureTabsSubmenu
            tabs={tabFields}
            isTabVisible={isTabVisible}
            onToggleTab={onToggleTab}
            onResetTabs={onResetTabs}
          />
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 />
                {t('weldhr.employees.detail.actions.delete')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

// ─── Details tab ───────────────────────────────────────────────────────────

/** A text / date row: inline-editable, or read-only with a dash when empty. */
function FieldRow({
  readOnly,
  ...props
}: Readonly<ComponentProps<typeof PropertyRow> & { readOnly: boolean }>) {
  if (readOnly) {
    return (
      <PanelRow
        icon={props.icon}
        label={props.label}
        value={props.value}
        type={props.type}
        renderValue={props.renderValue}
        tabular={props.tabular}
      />
    );
  }
  return <PropertyRow {...props} />;
}

/** A row picked from a fixed list: a picker, or its label read-only. */
function ChoiceRow({
  readOnly,
  icon,
  label,
  value,
  options,
  onChange,
}: Readonly<{
  readOnly: boolean;
  icon: ComponentProps<typeof SelectPropertyRow>['icon'];
  label: string;
  value: string | null | undefined;
  options: SelectPropertyOption[];
  onChange: (next: string | null) => void;
}>) {
  if (readOnly) {
    const display = value ? (options.find((option) => option.value === value)?.label ?? value) : null;
    return <PanelRow icon={icon} label={label} value={display} />;
  }
  return <SelectPropertyRow icon={icon} label={label} value={value} options={options} onChange={onChange} />;
}

function employeeStatusLabel(t: Translate, status: string): string {
  return t(`weldhr.status.employee.${status}`);
}

function EmployeeDetailsTab({
  employee,
  canUpdate,
  showWorkspaceAccount,
}: Readonly<{ employee: HrEmployeeDetail; canUpdate: boolean; showWorkspaceAccount: boolean }>) {
  const t = useTranslations();
  const readOnly = !canUpdate;
  const updateMut = useUpdateHrEmployee();
  // Only the pickers need these lists; a read-only row shows the names on the record.
  const { data: departments } = useHrDepartments({ enabled: canUpdate });
  const { data: managerCandidates } = useHrEmployees(
    { limit: 200, status: MANAGER_STATUSES },
    { enabled: canUpdate },
  );

  const save = useCallback(
    async (patch: UpdateHrEmployeeInput) => {
      try {
        await updateMut.mutateAsync({ id: employee.id, ...patch });
      } catch (err) {
        toast.error(errorMessage(err, t('weldhr.employees.detail.edit.failed')));
      }
    },
    [updateMut, employee.id, t],
  );

  /** A field the employee can't be without: clearing it is refused, not saved. */
  const saveRequired = useCallback(
    (field: 'firstName' | 'lastName', requiredMessage: string) => async (next: string | null) => {
      if (!next) {
        toast.error(requiredMessage);
        return;
      }
      await save({ [field]: next });
    },
    [save],
  );

  const departmentOptions = useMemo<SelectPropertyOption[]>(
    () => (departments ?? []).map((department) => ({ value: department.id, label: department.name })),
    [departments],
  );

  const managerOptions = useMemo<SelectPropertyOption[]>(() => {
    const options = (managerCandidates?.data ?? [])
      .filter((candidate) => candidate.id !== employee.id)
      .map((candidate) => ({ value: candidate.id, label: candidate.displayName }));
    // The current manager stays pickable even when the list doesn't hold them.
    if (employee.managerId && !options.some((option) => option.value === employee.managerId)) {
      options.unshift({ value: employee.managerId, label: employee.managerName ?? employee.managerId });
    }
    return options;
  }, [managerCandidates, employee.id, employee.managerId, employee.managerName]);

  const employmentTypeOptions = useMemo<SelectPropertyOption[]>(
    () =>
      hrEmploymentTypeSchema.options.map((type) => ({
        value: type,
        label: t(`weldhr.status.employmentType.${type}`),
      })),
    [t],
  );

  const statusOptions = useMemo(
    () =>
      hrEmployeeStatusSchema.options.map((status) => ({
        value: status,
        label: employeeStatusLabel(t, status),
        color: STATUS_COLOR[status],
      })),
    [t],
  );

  const renderDate = (value: string | null | undefined) => formatDate(value);

  return (
    <div className="p-4 space-y-1">
      <FieldRow
        readOnly={readOnly}
        icon={User}
        label={t('weldhr.employees.create.firstName')}
        value={employee.firstName}
        onSave={saveRequired('firstName', t('weldhr.employees.validation.firstNameRequired'))}
      />
      <FieldRow
        readOnly={readOnly}
        icon={User}
        label={t('weldhr.employees.create.lastName')}
        value={employee.lastName}
        onSave={saveRequired('lastName', t('weldhr.employees.validation.lastNameRequired'))}
      />
      <FieldRow
        readOnly={readOnly}
        icon={Smile}
        label={t('weldhr.employees.detail.fields.preferredName')}
        value={employee.preferredName}
        onSave={(next) => save({ preferredName: next })}
      />
      <FieldRow
        readOnly={readOnly}
        icon={Mail}
        label={t('weldhr.employees.create.email')}
        type="email"
        value={employee.email}
        onSave={async (next) => {
          if (!next) {
            toast.error(t('weldhr.employees.validation.emailRequired'));
            return;
          }
          if (!emailSchema.safeParse(next).success) {
            toast.error(t('weldhr.employees.validation.emailInvalid'));
            return;
          }
          await save({ email: next });
        }}
      />
      <FieldRow
        readOnly={readOnly}
        icon={Phone}
        label={t('weldhr.employees.create.phone')}
        type="phone"
        value={employee.phone}
        onSave={async (next) => {
          if (next && !isPhoneNumber(next)) {
            toast.error(t('weldhr.employees.validation.phoneInvalid'));
            return;
          }
          await save({ phone: next });
        }}
      />
      <FieldRow
        readOnly={readOnly}
        icon={Briefcase}
        label={t('weldhr.employees.create.jobTitle')}
        value={employee.jobTitle}
        onSave={(next) => save({ jobTitle: next })}
      />
      <ChoiceRow
        readOnly={readOnly}
        icon={Building2}
        label={t('weldhr.employees.create.department')}
        value={employee.departmentId}
        options={
          // Read-only members may not see the department list; the name is on the record.
          readOnly && employee.departmentId
            ? [{ value: employee.departmentId, label: employee.departmentName ?? employee.departmentId }]
            : departmentOptions
        }
        onChange={(next) => void save({ departmentId: next })}
      />
      <ChoiceRow
        readOnly={readOnly}
        icon={UserRound}
        label={t('weldhr.employees.detail.fields.manager')}
        value={employee.managerId}
        options={managerOptions}
        onChange={(next) => void save({ managerId: next })}
      />
      <ChoiceRow
        readOnly={readOnly}
        icon={BriefcaseBusiness}
        label={t('weldhr.employees.detail.fields.employmentType')}
        value={employee.employmentType}
        options={employmentTypeOptions}
        // Employment type can't be empty: clearing the picker keeps the current one.
        onChange={(next) => {
          if (next) void save({ employmentType: next as HrEmployeeDetail['employmentType'] });
        }}
      />
      {readOnly ? (
        <PanelRow
          icon={CircleUser}
          label={t('weldhr.employees.create.status')}
          value={employee.status}
          renderValue={(status) => (
            <LinkedRecordStatus tone={STATUS_COLOR[status as HrEmployeeDetail['status']] ?? 'gray'}>
              {employeeStatusLabel(t, status ?? '')}
            </LinkedRecordStatus>
          )}
        />
      ) : (
        <StatusPropertyRow
          value={employee.status}
          options={statusOptions}
          onChange={(next) => {
            if (next) void save({ status: next as HrEmployeeDetail['status'] });
          }}
        />
      )}
      <FieldRow
        readOnly={readOnly}
        icon={Hash}
        label={t('weldhr.employees.detail.fields.employeeNumber')}
        value={employee.employeeNumber}
        onSave={(next) => save({ employeeNumber: next })}
      />
      <FieldRow
        readOnly={readOnly}
        icon={Speech}
        label={t('weldhr.employees.detail.fields.pronouns')}
        value={employee.pronouns}
        onSave={(next) => save({ pronouns: next })}
      />
      <FieldRow
        readOnly={readOnly}
        icon={CalendarDays}
        label={t('weldhr.employees.create.startDate')}
        type="date"
        value={employee.startDate}
        renderValue={renderDate}
        onSave={(next) => save({ startDate: next })}
      />
      <FieldRow
        readOnly={readOnly}
        icon={CalendarClock}
        label={t('weldhr.employees.detail.fields.probationEndDate')}
        type="date"
        value={employee.probationEndDate}
        renderValue={renderDate}
        onSave={(next) => save({ probationEndDate: next })}
      />
      <FieldRow
        readOnly={readOnly}
        icon={CalendarX}
        label={t('weldhr.employees.detail.overview.endDate')}
        type="date"
        value={employee.endDate}
        renderValue={renderDate}
        onSave={(next) => save({ endDate: next })}
      />
      <FieldRow
        readOnly={readOnly}
        icon={MapPin}
        label={t('weldhr.employees.detail.overview.location')}
        value={employee.location}
        onSave={(next) => save({ location: next })}
      />
      <FieldRow
        readOnly={readOnly}
        icon={Globe}
        label={t('weldhr.employees.detail.overview.timezone')}
        value={employee.timezone}
        onSave={(next) => save({ timezone: next })}
      />
      <FieldRow
        readOnly={readOnly}
        icon={Clock}
        label={t('weldhr.employees.detail.fields.weeklyHours')}
        value={employee.weeklyHours === null ? null : String(employee.weeklyHours)}
        tabular
        onSave={async (next) => {
          if (next === null) {
            await save({ weeklyHours: null });
            return;
          }
          const hours = Number(next.replace(',', '.'));
          if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
            toast.error(t('weldhr.employees.validation.weeklyHoursInvalid'));
            return;
          }
          await save({ weeklyHours: hours });
        }}
      />
      {showWorkspaceAccount && <EmployeeWorkspaceAccountRow employee={employee} icon={CircleUser} />}

      <CustomFieldsSidebarSection
        entityType="employee"
        values={employee.customFields}
        onSave={(next) => save({ customFields: next })}
        readOnly={readOnly}
        layout="row"
      />
    </div>
  );
}

// ─── Direct reports tab ────────────────────────────────────────────────────

type DirectReport = HrEmployeeDetail['directReports'][number];
/** Flattened for `EntityList`'s `searchFields`, which can't read a null. */
type DirectReportItem = Omit<DirectReport, 'jobTitle'> & { jobTitle: string };

const REPORT_COLUMN = {
  name: 'min-w-0 flex-1',
  jobTitle: 'w-[200px] @max-[560px]:w-[140px]',
  status: 'w-[110px] @max-[560px]:hidden',
};

function EmployeeReportsTab({ employee }: Readonly<{ employee: HrEmployeeDetail }>) {
  const t = useTranslations();
  const { open: openPanel } = useObjectPanel();
  // Previous / next in a report's panel step through this list.
  const reportDisplayed = useObjectPanelNavigationReporter<DirectReportItem>({ type: HR_EMPLOYEE_PANEL_TYPE });

  const items = useMemo<DirectReportItem[]>(
    () => employee.directReports.map((report) => ({ ...report, jobTitle: report.jobTitle ?? '' })),
    [employee.directReports],
  );

  const filterConfigs = useMemo<FilterConfig[]>(
    () => [
      {
        field: 'status',
        label: t('weldhr.employees.table.status'),
        options: hrEmployeeStatusSchema.options.map((status) => ({
          value: status,
          label: employeeStatusLabel(t, status),
        })),
      },
    ],
    [t],
  );

  const applyFilters = useCallback(
    (list: DirectReportItem[], filters: ActiveFilter[]) =>
      applySelectFilters(list, filters, { status: (report, value) => report.status === value }),
    [],
  );

  const headerColumns = useMemo<HeaderColumn[]>(
    () => [
      { id: 'name', header: t('weldhr.employees.table.name'), width: REPORT_COLUMN.name },
      { id: 'jobTitle', header: t('weldhr.employees.table.jobTitle'), width: REPORT_COLUMN.jobTitle },
      { id: 'status', header: t('weldhr.employees.table.status'), width: REPORT_COLUMN.status },
    ],
    [t],
  );

  const openReport = useCallback(
    (reportId: string) => openPanel({ type: HR_EMPLOYEE_PANEL_TYPE, id: reportId, stack: true }),
    [openPanel],
  );

  const renderRow = useCallback(
    (report: DirectReportItem) => (
      <TabListRow
        key={report.id}
        label={report.displayName}
        onOpen={() => openReport(report.id)}
        menuLabel={t('sweep.entities.moreActions')}
        menu={
          <DropdownMenuItem onClick={() => openReport(report.id)}>
            <SquareArrowOutUpRight />
            {t('sweep.weldcrm.contactsSection.viewProfile')}
          </DropdownMenuItem>
        }
      >
        <div className={`${REPORT_COLUMN.name} flex items-center gap-2`}>
          <Avatar className="h-[18px] w-[18px] flex-shrink-0">
            {report.avatarUrl && <AvatarImage src={report.avatarUrl} alt={report.displayName} className="object-cover" />}
            <AvatarFallback className="text-[9px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
              {(report.displayName.trim()[0] ?? '?').toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="truncate text-sm font-medium text-foreground">{report.displayName}</span>
        </div>
        <div className={`${REPORT_COLUMN.jobTitle} min-w-0`}>
          <span className="block truncate text-sm text-muted-foreground">{report.jobTitle || '—'}</span>
        </div>
        <div className={`${REPORT_COLUMN.status} flex items-center min-w-0`}>
          <LinkedRecordStatus tone={STATUS_COLOR[report.status]}>
            {employeeStatusLabel(t, report.status)}
          </LinkedRecordStatus>
        </div>
      </TabListRow>
    ),
    [openReport, t],
  );

  return (
    <TabListScope>
      <EntityList<DirectReportItem>
        items={items}
        onDisplayedItemsChange={reportDisplayed}
        isLoading={false}
        error={null}
        filters={filterConfigs}
        applyFilters={applyFilters}
        headerColumns={headerColumns}
        renderRow={renderRow}
        searchPlaceholder={t('weldhr.employees.detail.reports.searchPlaceholder')}
        searchFields={['displayName', 'jobTitle']}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{
          icon: <PeopleIllustration />,
          title: t('weldhr.employees.detail.reports.emptyTitle'),
          description: t('weldhr.employees.detail.reports.emptyDescription'),
        }}
        noResultsState={{
          title: t('weldhr.employees.detail.reports.noResultsTitle'),
          description: t('weldhr.employees.detail.reports.noResultsDescription'),
        }}
      />
    </TabListScope>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function HrEmployeePanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const { id, onClose, initialTab } = props;
  const { can } = usePermissions();
  const employeeQuery = useHrEmployee(id);
  const employee = employeeQuery.data;
  const deleteMut = useDeleteHrEmployee();

  const shell = useObjectPanelShell({
    ...props,
    width: HR_EMPLOYEE_PANEL_WIDTH,
    loading: employeeQuery.isLoading && !employee,
  });
  const mode = shell.mode;

  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);

  const canUpdate = can('employees:update') || can('employees:manage');
  const canDelete = can('employees:delete') || can('employees:manage');
  const canSensitive = can('employees:sensitive');
  const canReadAttendance = can('attendance:read');
  const canReadLeave = can('leave:read');
  const showWorkspaceAccount = canUpdate || can('team:create') || can('team:read');
  // The Payroll tab needs the weldhr-payroll flag and payroll:read.
  const payrollFlag = useHrPayrollFlag();
  const canSeePayroll = payrollFlag.enabled && can('payroll:read');

  // The tabs this member may open, in strip order.
  const tabConfigEntries = useMemo<TabConfigEntry[]>(() => {
    const allowed: Record<HrEmployeeTabId, boolean> = {
      overview: true,
      reports: true,
      personal: canSensitive,
      attendance: canReadAttendance,
      leave: canReadLeave,
      payroll: canSeePayroll,
    };
    const entries: TabConfigEntry[] = [
      { id: 'overview', label: t('sweep.entities.detailsTab'), required: true, defaultVisible: true },
      { id: 'reports', label: t('weldhr.employees.detail.overview.directReports.title'), defaultVisible: true },
      { id: 'personal', label: t('weldhr.employees.detail.tabs.personal'), defaultVisible: true },
      { id: 'attendance', label: t('weldhr.employees.detail.tabs.attendance'), defaultVisible: true },
      { id: 'leave', label: t('weldhr.employees.detail.tabs.leave'), defaultVisible: true },
      { id: 'payroll', label: t('weldhr.payroll.employeeTab'), defaultVisible: true },
    ];
    return entries.filter((entry) => allowed[entry.id]);
  }, [t, canSensitive, canReadAttendance, canReadLeave, canSeePayroll]);

  const {
    isVisible: isTabVisible,
    toggle: toggleTab,
    resetToDefaults: resetTabs,
  } = useObjectPanelTabConfig({
    objectType: HR_EMPLOYEE_PANEL_TYPE,
    mode,
    tabs: tabConfigEntries,
  });

  const [activeTab, setActiveTab] = useState<HrEmployeeTabId>(() =>
    isHrEmployeeTabId(initialTab) ? initialTab : 'overview',
  );

  const visibleTabs = useMemo(
    () => tabConfigEntries.filter((entry) => isTabVisible(entry.id)),
    [tabConfigEntries, isTabVisible],
  );
  // A tab that is switched off, or not (yet) allowed, shows the first visible
  // one instead — without forgetting the choice, so a deep link to Payroll
  // opens it once the payroll flag has loaded.
  const shownTab: HrEmployeeTabId = visibleTabs.some((entry) => entry.id === activeTab)
    ? activeTab
    : (visibleTabs[0]?.id ?? 'overview');

  const directReportCount = employee?.directReports.length ?? 0;
  const tabs = useMemo(
    () =>
      visibleTabs.map((entry) => ({
        id: entry.id,
        label: entry.label,
        icon: HR_EMPLOYEE_TAB_ICONS[entry.id],
        count: entry.id === 'reports' && directReportCount > 0 ? directReportCount : undefined,
      })),
    [visibleTabs, directReportCount],
  );

  const handleDelete = useCallback(async () => {
    try {
      await deleteMut.mutateAsync(id);
      setDialog(null);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, t('sweep.entities.deleteFailed')));
    }
  }, [deleteMut, id, onClose, t]);

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(mode)}
      avatar={<EmployeePanelAvatar employee={employee} />}
      title={<EmployeePanelTitle employee={employee} />}
      actions={
        <EmployeePanelActions
          employee={employee}
          canUpdate={canUpdate}
          canDelete={canDelete}
          onEdit={() => setDialog('edit')}
          onDelete={() => setDialog('delete')}
          tabFields={tabConfigEntries}
          isTabVisible={isTabVisible}
          onToggleTab={toggleTab}
          onResetTabs={resetTabs}
        />
      }
      tabs={
        <ObjectPanelTabs
          tabs={tabs}
          activeTab={shownTab}
          onChange={(tabId) => setActiveTab(tabId as HrEmployeeTabId)}
        />
      }
    >
      {!employee && employeeQuery.isError && (
        <RecordLoadFailed
          notFound={false}
          message={errorMessage(employeeQuery.error, t('weldhr.employees.detail.notFound'))}
          retryLabel={t('common.actions.retry')}
          onRetry={() => void employeeQuery.refetch()}
        />
      )}

      {employee && shownTab === 'overview' && (
        <EmployeeDetailsTab employee={employee} canUpdate={canUpdate} showWorkspaceAccount={showWorkspaceAccount} />
      )}
      {employee && shownTab === 'reports' && <EmployeeReportsTab employee={employee} />}
      {employee && shownTab === 'personal' && (
        <div className="p-4">
          <SensitivePanel employeeId={employee.id} />
        </div>
      )}
      {employee && shownTab === 'attendance' && (
        <div className="p-4">
          <EmployeeAttendanceTab employeeId={employee.id} />
        </div>
      )}
      {employee && shownTab === 'leave' && (
        <div className="p-4">
          <EmployeeLeaveTab employeeId={employee.id} />
        </div>
      )}
      {employee && shownTab === 'payroll' && (
        <div className="p-4">
          <EmployeePayrollTab employeeId={employee.id} />
        </div>
      )}

      {dialog === 'edit' && employee && <EditEmployeeDialog employee={employee} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && employee && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t('weldhr.employees.detail.deleteConfirm.title')}
          description={t('weldhr.employees.detail.deleteConfirm.description', { name: employee.displayName })}
          variant="destructive"
          confirmLabel={t('weldhr.common.delete')}
          cancelLabel={t('weldhr.common.cancel')}
          onConfirm={handleDelete}
        />
      )}
    </EntityDetailView>
  );
}
