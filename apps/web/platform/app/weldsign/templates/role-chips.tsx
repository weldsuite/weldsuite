import type { SignTemplateRoleSummary } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';

interface RoleChipsProps {
  roles: SignTemplateRoleSummary[];
  /** Chips shown before the rest collapse into "+2". */
  max?: number;
}

/** The roles of a template as small chips; a role that only gets a copy is drawn dashed. */
export function RoleChips({ roles, max = 3 }: Readonly<RoleChipsProps>) {
  const { t, format } = useI18n();
  const tt = t.weldsign.templates;
  if (roles.length === 0) return <span className="text-sm text-muted-foreground">{tt.noRoles}</span>;

  const shown = roles.slice(0, max);
  const extra = roles.length - shown.length;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((role) => (
        <span
          key={role.id}
          title={t.weldsign.editor.recipients.roles[role.role]}
          className={cn('max-w-[10rem] truncate rounded-full border px-2 py-0.5 text-xs', role.role === 'cc' && 'border-dashed text-muted-foreground')}
        >
          {role.roleName}
        </span>
      ))}
      {extra > 0 && <span className="text-xs text-muted-foreground">{format(tt.rolesMore, { count: extra })}</span>}
    </span>
  );
}
