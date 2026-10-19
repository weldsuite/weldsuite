import { useUser } from '@clerk/clerk-react';
import { Building2, Eye, Loader2, Lock } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type {
  DriveGeneralAccess,
  DriveItemSharing,
  DriveSharePerson,
  DriveShareRole,
} from '@weldsuite/core-api-client/schemas/drive-shares';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useDriveItemSharing } from '@/hooks/queries/use-drive-queries';
import { driveLabelClass } from './drive-file-card';
import { isDriveUpload } from './drive-utils';

const REMOVE = '__remove__';

const ROLE_LABEL_CLASS: Record<'owner' | DriveShareRole, string> = {
  owner: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950',
  editor: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950',
  viewer: 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary',
};

export const GENERAL_ACCESS_ICON: Record<DriveGeneralAccess, typeof Lock> = {
  workspace_edit: Building2,
  workspace_view: Eye,
  restricted: Lock,
};

function initials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();
}

export function personLabel(person: Pick<DriveSharePerson, 'name' | 'email' | 'userId'>): string {
  return person.name || person.email || person.userId;
}

export function PersonAvatar({ person, className }: Readonly<{ person: Pick<DriveSharePerson, 'picture' | 'name' | 'email' | 'userId'>; className?: string }>) {
  const name = personLabel(person);
  if (person.picture) {
    return <img src={person.picture} alt="" className="w-[22px] h-[22px] rounded-[8px] object-cover shrink-0" />;
  }
  return (
    <div className={cn('w-[22px] h-[22px] rounded-[8px] flex items-center justify-center shrink-0 bg-muted text-muted-foreground', className)}>
      <span className="text-[10px] font-semibold">{initials(name)}</span>
    </div>
  );
}

function RoleLabel({ role }: Readonly<{ role: 'owner' | DriveShareRole }>) {
  const { t } = useI18n();
  return <span className={cn(driveLabelClass, 'shrink-0', ROLE_LABEL_CLASS[role])}>{t.welddrive.share.roles[role]}</span>;
}

interface AccessRow {
  person: DriveSharePerson;
  role: 'owner' | DriveShareRole;
  /** Set for access through a folder above the item. */
  viaFolder?: string;
  /** A direct share the caller may change or remove. */
  direct: boolean;
}

/** One row per person: the owner, the direct shares, then whoever only reaches it through a folder. */
function accessRows(sharing: DriveItemSharing): AccessRow[] {
  const rows: AccessRow[] = [];
  const seen = new Set<string>();
  if (sharing.owner) {
    rows.push({ person: sharing.owner, role: 'owner', direct: false });
    seen.add(sharing.owner.userId);
  }
  for (const share of sharing.shares) {
    if (seen.has(share.userId)) continue;
    rows.push({ person: share, role: share.role, direct: true });
    seen.add(share.userId);
  }
  // Nearest folder first, so the first entry per person is the one that counts.
  for (const share of sharing.inherited) {
    if (seen.has(share.userId)) continue;
    rows.push({ person: share, role: share.role, viaFolder: share.folderName, direct: false });
    seen.add(share.userId);
  }
  return rows;
}

interface DriveAccessListProps {
  sharing: DriveItemSharing;
  /** Show at most this many people (the Details panel); everyone when unset. */
  limit?: number;
  /** Role pickers and Remove on direct shares (the Share dialog, for owners and editors). */
  editable?: boolean;
  onRoleChange?: (person: DriveSharePerson, role: DriveShareRole) => void;
  onRemove?: (person: DriveSharePerson) => void;
  disabled?: boolean;
}

/** The people who can open a Drive file or folder, and their roles. */
export function DriveAccessList({ sharing, limit, editable = false, onRoleChange, onRemove, disabled }: Readonly<DriveAccessListProps>) {
  const { t } = useI18n();
  const { user } = useUser();
  const rows = accessRows(sharing);
  const shown = limit === undefined ? rows : rows.slice(0, limit);

  return (
    <div className="space-y-2.5">
      {shown.map((row) => {
        const isSelf = row.person.userId === user?.id;
        const name = personLabel(row.person);
        return (
          <div key={row.person.userId} className="flex items-center gap-2.5">
            <PersonAvatar
              person={row.person}
              className={row.role === 'owner' ? 'bg-primary text-primary-foreground' : undefined}
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground truncate">
                {name}
                {isSelf && <span className="ml-1 text-xs text-muted-foreground">{t.welddrive.share.youSuffix}</span>}
              </p>
              {row.viaFolder && (
                <p className="text-xs text-muted-foreground truncate">
                  {t.welddrive.share.viaFolder.replace('{folder}', row.viaFolder)}
                </p>
              )}
            </div>
            {row.direct && row.role !== 'owner' && (editable || isSelf) && onRoleChange && onRemove ? (
              <Select
                value={row.role}
                disabled={disabled}
                onValueChange={(next) => {
                  if (next === REMOVE) onRemove(row.person);
                  else onRoleChange(row.person, next as DriveShareRole);
                }}
              >
                <SelectTrigger className="h-7 w-auto gap-1.5 px-2 text-xs" aria-label={name}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {/* Your own role is not yours to change, only to give up. */}
                  {editable && !isSelf ? (
                    <>
                      <SelectItem value="editor">{t.welddrive.share.roles.editor}</SelectItem>
                      <SelectItem value="viewer">{t.welddrive.share.roles.viewer}</SelectItem>
                    </>
                  ) : (
                    <SelectItem value={row.role}>{t.welddrive.share.roles[row.role]}</SelectItem>
                  )}
                  <SelectSeparator />
                  <SelectItem value={REMOVE} className="text-red-600 focus:text-red-600">
                    {isSelf ? t.welddrive.share.leave : t.welddrive.share.removeAccess}
                  </SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <RoleLabel role={row.role} />
            )}
          </div>
        );
      })}
      {limit !== undefined && rows.length > limit && (
        <span className="text-xs text-muted-foreground pl-8">
          {t.welddrive.fileDetail.moreMembers.replace('{count}', String(rows.length - limit))}
        </span>
      )}
    </div>
  );
}

/** The item's general access, as one line with its icon. */
export function DriveGeneralAccessLine({ access }: Readonly<{ access: DriveGeneralAccess }>) {
  const { t } = useI18n();
  const Icon = GENERAL_ACCESS_ICON[access];
  return (
    <div className="flex items-start gap-2.5">
      <div className="w-[22px] h-[22px] rounded-[8px] flex items-center justify-center shrink-0 bg-muted text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0">
        <p className="text-sm text-foreground">{t.welddrive.share.generalAccessOptions[access]}</p>
        <p className="text-xs text-muted-foreground">{t.welddrive.share.generalAccessHints[access]}</p>
      </div>
    </div>
  );
}

/**
 * "Who has access" in the Details panel: the people and the general access
 * for a Drive file, or a note that a module's file follows that module.
 */
export function DriveFileAccess({ file, limit = 5 }: Readonly<{ file: UnifiedFile; limit?: number }>) {
  const { t } = useI18n();
  const item = isDriveUpload(file) ? ({ kind: 'file', id: file.id } as const) : null;
  const { data: sharing, isLoading } = useDriveItemSharing(item);
  if (!item) return <p className="text-xs text-muted-foreground">{t.welddrive.share.moduleFile}</p>;
  if (isLoading || !sharing) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  }
  return (
    <div className="space-y-3">
      <DriveAccessList sharing={sharing} limit={limit} />
      <DriveGeneralAccessLine access={sharing.effectiveGeneralAccess} />
    </div>
  );
}
