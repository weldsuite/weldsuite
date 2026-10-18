import { useUser } from '@clerk/clerk-react';
import { cn } from '@/lib/utils';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';
import { useI18n } from '@/lib/i18n/provider';
import { driveLabelClass } from './drive-file-card';

// Shape of a `/team-members` row as consumed here — see `useWorkspaceMembers`
// for the full (visibility-projected) field set; only what this list reads.
interface DriveAccessMember {
  id?: string;
  userId: string;
  name: string;
  picture?: string | null;
}

function initials(name: string | null | undefined): string {
  return (name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();
}

function Avatar({ picture, name, className }: Readonly<{ picture?: string | null; name: string; className: string }>) {
  if (picture) {
    return <img src={picture} alt={name} className="w-[22px] h-[22px] rounded-[8px] object-cover shrink-0" />;
  }
  return (
    <div className={cn('w-[22px] h-[22px] rounded-[8px] flex items-center justify-center shrink-0', className)}>
      <span className="text-[10px] font-semibold">{initials(name)}</span>
    </div>
  );
}

/**
 * Who can open a Drive file. Drive has no per-file permissions: the uploader
 * owns it and every workspace member with WeldDrive access can open it.
 */
export function DriveAccessList({ file, limit = 5 }: Readonly<{ file: Pick<UnifiedFile, 'uploadedById'>; limit?: number }>) {
  const { t } = useI18n();
  const { user } = useUser();
  const { data: membersData } = useWorkspaceMembers();
  const members = (membersData?.data || []) as DriveAccessMember[];
  const owner = file.uploadedById ? members.find((m) => m.userId === file.uploadedById) || null : null;
  const others = members.filter((m) => m.userId !== file.uploadedById && m.userId !== user?.id);

  return (
    <div className="space-y-2.5">
      {owner && (
        <div className="flex items-center gap-2.5">
          <Avatar picture={owner.picture} name={owner.name} className="bg-primary text-primary-foreground" />
          <span className="flex-1 min-w-0 text-sm text-foreground truncate">{owner.name}</span>
          <span className={cn(driveLabelClass, 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950')}>
            {t.welddrive.fileDetail.accessRoles.owner}
          </span>
        </div>
      )}
      {user && owner?.userId !== user.id && (
        <div className="flex items-center gap-2.5">
          <Avatar picture={user.imageUrl} name={user.fullName || ''} className="bg-emerald-500 text-white" />
          <span className="flex-1 min-w-0 text-sm text-foreground truncate">{user.fullName || t.welddrive.fileDetail.you}</span>
          <span className={cn(driveLabelClass, 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950')}>
            {t.welddrive.fileDetail.accessRoles.canEdit}
          </span>
        </div>
      )}
      {others.slice(0, limit).map((m) => (
        <div key={m.userId || m.id} className="flex items-center gap-2.5">
          <Avatar picture={m.picture} name={m.name} className="bg-muted text-muted-foreground" />
          <span className="flex-1 min-w-0 text-sm text-foreground truncate">{m.name}</span>
          <span className={cn(driveLabelClass, 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary')}>
            {t.welddrive.fileDetail.accessRoles.canView}
          </span>
        </div>
      ))}
      {others.length > limit && (
        <span className="text-xs text-muted-foreground pl-8">
          {t.welddrive.fileDetail.moreMembers.replace('{count}', String(others.length - limit))}
        </span>
      )}
    </div>
  );
}
