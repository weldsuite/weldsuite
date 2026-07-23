
import { useState, useEffect, useCallback } from 'react';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useUser, useSession } from '@clerk/clerk-react';
import type { SessionWithActivitiesResource } from '@clerk/types';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { formatDistanceToNow } from 'date-fns';
import {
  Monitor,
  Smartphone,
  Tablet,
  Globe,
  Loader2,
  EllipsisVertical,
  LogOut,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';
import { DeleteAccountSection } from './delete-account-section';

// Get the appropriate icon based on device type
function getDeviceIcon(deviceType?: string, isMobile?: boolean) {
  if (isMobile) return Smartphone;
  if (deviceType?.toLowerCase().includes('tablet')) return Tablet;
  if (deviceType?.toLowerCase().includes('mobile')) return Smartphone;
  if (deviceType?.toLowerCase().includes('desktop')) return Monitor;
  return Globe;
}

// Format the device and browser info
function formatDeviceInfo(
  session: SessionWithActivitiesResource,
  labels: { unknownDevice: string; unknownBrowser: string; mobile: string; desktop: string },
): string {
  const activity = session.latestActivity;
  if (!activity) return labels.unknownDevice;

  const browser = activity.browserName || labels.unknownBrowser;
  const version = activity.browserVersion ? ` ${activity.browserVersion.split('.')[0]}` : '';
  const device = activity.deviceType || (activity.isMobile ? labels.mobile : labels.desktop);

  return `${device}, ${browser}${version}`;
}

// Format the location info
function formatLocationInfo(session: SessionWithActivitiesResource): string {
  const activity = session.latestActivity;
  if (!activity) return '';

  const parts: string[] = [];
  if (activity.ipAddress) parts.push(activity.ipAddress);
  if (activity.city && activity.country) {
    parts.push(`${activity.city}, ${activity.country}`);
  } else if (activity.country) {
    parts.push(activity.country);
  }

  return parts.join(', ');
}

export default function SecuritySettingsPage() {
  const { user } = useUser();
  const { session: currentSession } = useSession();
  const [sessions, setSessions] = useState<SessionWithActivitiesResource[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);
  const [isRevokingAll, setIsRevokingAll] = useState(false);
  const [showSignOutDialog, setShowSignOutDialog] = useState(false);
  const { getClient } = useAppApiClient();
  const { t } = useI18n();
  const ts = t.settings.security;

  // Fetch all sessions
  const fetchSessions = useCallback(async () => {
    if (!user) return;

    try {
      const userSessions = await user.getSessions();
      // Sort by lastActiveAt, most recent first
      const sorted = [...userSessions].sort((a, b) => {
        const aTime = a.lastActiveAt?.getTime() || 0;
        const bTime = b.lastActiveAt?.getTime() || 0;
        return bTime - aTime;
      });
      setSessions(sorted);
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
      toast.error(ts.messages.loadFailed);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Revoke a single session
  const handleRevokeSession = async (session: SessionWithActivitiesResource) => {
    if (session.id === currentSession?.id) {
      toast.error(ts.messages.cannotRevokeCurrent);
      return;
    }

    setRevokingSessionId(session.id);
    try {
      const client = await getClient();
      // app-api POST /api/auth-sessions/:sessionId/revoke (was api-worker
      // /settings/sessions/:id/revoke). A failure now throws rather than
      // resolving with `success: false`, so the catch below reports it.
      await client.post<{ data: { revoked: boolean; sessionId: string } }>(
        `/auth-sessions/${session.id}/revoke`,
        {},
      );
      toast.success(ts.messages.revokeSuccess);
      setSessions((prev) => prev.filter((s) => s.id !== session.id));
    } catch (error) {
      console.error('Failed to revoke session:', error);
      const message = error instanceof Error ? error.message : ts.unknown;
      toast.error(ts.messages.revokeFailed.replace('{error}', message));
    } finally {
      setRevokingSessionId(null);
    }
  };

  // Revoke all other sessions
  const handleRevokeAllSessions = async () => {
    setIsRevokingAll(true);
    try {
      const client = await getClient();
      // app-api POST /api/auth-sessions/revoke-all (was api-worker
      // /settings/sessions/revoke-all). The counts moved from the top level
      // into the `{ data }` envelope; hard failures throw instead of returning
      // an `error` field.
      const result = await client.post<{ data: { revokedCount: number; failedCount: number } }>(
        '/auth-sessions/revoke-all',
        {},
      );
      const { revokedCount = 0, failedCount = 0 } = result.data ?? {};

      if (failedCount > 0) {
        toast.error(ts.messages.revokeAllPartial.replace('{count}', String(revokedCount)).replace('{failedCount}', String(failedCount)));
        await fetchSessions();
      } else if (revokedCount > 0) {
        toast.success(ts.messages.revokeAllSuccess.replace('{count}', String(revokedCount)));
        setSessions((prev) => prev.filter((s) => s.id === currentSession?.id));
      } else {
        toast(ts.messages.noOtherSessions);
      }
    } catch (error) {
      console.error('Failed to revoke all sessions:', error);
      const message = error instanceof Error ? error.message : ts.unknown;
      toast.error(ts.messages.revokeAllFailed.replace('{error}', message));
    } finally {
      setIsRevokingAll(false);
    }
  };

  const otherSessionsCount = sessions.filter((s) => s.id !== currentSession?.id).length;

  const columns: ColumnDef<SessionWithActivitiesResource>[] = [
    {
      id: 'device',
      header: ts.device,
      size: 500,
      cell: ({ row }) => {
        const session = row.original;
        const DeviceIcon = getDeviceIcon(
          session.latestActivity?.deviceType,
          session.latestActivity?.isMobile
        );
        return (
          <div className="flex items-center gap-2">
            <DeviceIcon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <span className="font-medium">{formatDeviceInfo(session, { unknownDevice: ts.unknownDevice, unknownBrowser: ts.unknownBrowser, mobile: ts.mobile, desktop: ts.desktop })}</span>
          </div>
        );
      },
    },
    {
      id: 'location',
      header: ts.location,
      size: 600,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatLocationInfo(row.original) || '—'}
        </span>
      ),
    },
    {
      id: 'lastActive',
      header: ts.lastActive,
      size: 140,
      cell: ({ row }) => {
        const session = row.original;
        const isCurrentSession = session.id === currentSession?.id;

        if (isCurrentSession) {
          return (
            <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400">
              {ts.current}
            </span>
          );
        }

        return (
          <span className="text-sm text-muted-foreground font-mono">
            {session.lastActiveAt
              ? formatDistanceToNow(session.lastActiveAt, { addSuffix: true })
              : ts.unknown}
          </span>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const session = row.original;
        const isCurrentSession = session.id === currentSession?.id;
        const isRevoking = revokingSessionId === session.id;

        if (isCurrentSession) return null;

        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                >
                  <span className="sr-only">{t.common.actions.openMenu}</span>
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => handleRevokeSession(session)}
                  disabled={isRevoking}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  {isRevoking ? (
                    <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                  ) : (
                    <LogOut className="h-4 w-4 mr-0.5 text-destructive" />
                  )}
                  {ts.revokeSession}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  const table = useReactTable({
    data: sessions,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">{ts.description}</p>
      </div>

      <div className="space-y-8">
        {/* Sessions */}
        <div>
          <h3 className="text-base font-medium mb-3">{ts.activeSessions}</h3>

          <div className="space-y-3">
            {isLoading ? (
              <div className="overflow-hidden rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[13.5px]">{ts.device}</TableHead>
                      <TableHead className="text-[13.5px]">{ts.location}</TableHead>
                      <TableHead className="text-[13.5px]">{ts.lastActive}</TableHead>
                      <TableHead className="text-[13.5px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[1, 2].map((i) => (
                      <TableRow key={i}>
                        <TableCell className="h-[42px] py-0 px-3">
                          <div className="flex items-center gap-2">
                            <Skeleton className="h-4 w-4 rounded" />
                            <Skeleton className="h-4 w-32" />
                          </div>
                        </TableCell>
                        <TableCell className="h-[42px] py-0 px-3">
                          <Skeleton className="h-4 w-40" />
                        </TableCell>
                        <TableCell className="h-[42px] py-0 px-3">
                          <Skeleton className="h-4 w-24" />
                        </TableCell>
                        <TableCell className="h-[42px] py-0 px-3">
                          <Skeleton className="h-4 w-8 ml-auto" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="overflow-hidden rounded-md border">
                <Table>
                  <TableHeader>
                    {table.getHeaderGroups().map((headerGroup) => (
                      <TableRow key={headerGroup.id}>
                        {headerGroup.headers.map((header) => (
                          <TableHead key={header.id} className="text-[13.5px]" style={{ width: header.getSize() }}>
                            {header.isPlaceholder
                              ? null
                              : flexRender(
                                  header.column.columnDef.header,
                                  header.getContext()
                                )}
                          </TableHead>
                        ))}
                      </TableRow>
                    ))}
                  </TableHeader>
                  <TableBody>
                    {table.getRowModel().rows?.length ? (
                      table.getRowModel().rows.map((row) => (
                        <TableRow key={row.id} className="group">
                          {row.getVisibleCells().map((cell) => (
                            <TableCell key={cell.id} className="h-[42px] py-0 px-3" style={{ width: cell.column.getSize() }}>
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                          {ts.noSessions}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          {otherSessionsCount > 0 && (
            <div className="flex justify-end mt-4">
            <Button
              variant="outline"
              size="sm"
              className="shadow-none h-[34px]"
              disabled={isRevokingAll}
              onClick={() => setShowSignOutDialog(true)}
            >
              {isRevokingAll ? (
                <>
                  <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                  {ts.signingOut}
                </>
              ) : (
                ts.signOutAll
              )}
            </Button>
            <ConfirmDialog
              open={showSignOutDialog}
              onOpenChange={setShowSignOutDialog}
              title={ts.signOutConfirmTitle}
              description={ts.signOutConfirmDescription.replace('{count}', String(otherSessionsCount))}
              confirmLabel={ts.signOutConfirmButton}
              onConfirm={handleRevokeAllSessions}
            />
            </div>
          )}
        </div>

        {/* Danger zone — account deletion (web resource for the Google Play
            account-deletion requirement of the Weld* mobile apps). */}
        <DeleteAccountSection />
      </div>
    </div>
  );
}
