
import { useMemo } from 'react';
import { Bell, Check, CheckCheck, Trash2, X, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { FloatingDrawer } from '@/components/layout/floating-drawer';
import { getAvatarColor } from '@/components/shared/conversation-list/utils';
import {
  useUnifiedNotifications,
  type UnifiedNotification,
} from '@/contexts/unified-notification-context';
import { useNotificationStore } from '@/lib/notifications/notification-store';
import { Link } from '@/lib/router';
import { useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import { useResolveAccessRequest } from '@/hooks/queries/use-access-requests-queries';
import { renderContentWithMentions } from '@/lib/render-mentions';

type NotificationType = 'message' | 'task' | 'mention' | 'system' | 'order' | 'invoice' | 'calendar' | 'mail' | 'helpdesk' | 'crm' | 'commerce' | 'parcel' | 'projects';

interface DisplayNotification {
  id: string;
  type: NotificationType;
  notificationType: string;
  entityId?: string;
  title: string;
  description?: string;
  timestamp: Date;
  read: boolean;
  href?: string;
  actorName?: string;
  actorImageUrl?: string;
  /** Set on access_request notifications once any admin has resolved them. */
  resolvedStatus?: 'approved' | 'denied';
}

interface GlobalNotificationsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  width?: number;
  skipAnimation?: boolean;
}

// Map UnifiedNotification category to display type
function mapCategoryToType(category: string): NotificationType {
  const categoryMap: Record<string, NotificationType> = {
    mail: 'mail',
    helpdesk: 'helpdesk',
    crm: 'crm',
    commerce: 'commerce',
    parcel: 'parcel',
    projects: 'projects',
    task: 'task',
    system: 'system',
    calendar: 'calendar',
    invoice: 'invoice',
    order: 'order',
    message: 'message',
    mention: 'mention',
  };
  return categoryMap[category] || 'system';
}

// Transform UnifiedNotification to DisplayNotification
function transformNotification(notification: UnifiedNotification): DisplayNotification {
  // Server hydrates the actor (workspace member or contact) per notification
  // type. For legacy rows or system events `actor` may be null — we fall back
  // to initials, no avatar.
  const actor = notification.actor ?? null;

  const data = (notification.data ?? {}) as Record<string, unknown>;
  const rawResolved = data.resolvedStatus;
  const resolvedStatus =
    rawResolved === 'approved' || rawResolved === 'denied'
      ? (rawResolved as 'approved' | 'denied')
      : undefined;

  return {
    id: notification.id,
    type: mapCategoryToType(notification.category),
    notificationType: notification.notificationType,
    entityId: notification.entityId,
    title: notification.title,
    description: notification.body || undefined,
    timestamp: new Date(notification.createdAt),
    read: notification.isRead ?? false,
    href: notification.actionUrl || undefined,
    actorName: actor?.name,
    actorImageUrl: actor?.imageUrl ?? undefined,
    resolvedStatus,
  };
}

export function GlobalNotificationsPanel({ isOpen, onClose, width = 400, skipAnimation }: GlobalNotificationsPanelProps) {
  const {
    notifications: rawNotifications,
    unreadCount,
    isLoading,
    markAsRead: markAsReadAction,
    markAllAsRead: markAllAsReadAction,
    deleteNotification: deleteNotificationAction,
  } = useUnifiedNotifications();

  // Transform notifications from the hook
  const notifications = useMemo(
    () => rawNotifications.map(transformNotification),
    [rawNotifications]
  );

  // Build a userId → display-name map so `<@user_xxx>` tokens in notification
  // bodies render as @-mention badges (matching WeldChat's rendering).
  const { data: membersData } = useWorkspaceMembers();
  const membersMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersData?.data ?? []) {
      if (m.userId && m.name) map.set(m.userId, m.name);
    }
    return map;
  }, [membersData]);

  const formatTimestamp = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m`;
    if (hours < 24) return `${hours}h`;
    if (days < 7) return `${days}d`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const handleMarkAsRead = (id: string) => {
    markAsReadAction(id);
  };

  const handleMarkAllAsRead = () => {
    markAllAsReadAction();
  };

  const handleDeleteNotification = (id: string) => {
    deleteNotificationAction(id);
  };

  const { mutate: resolveAccessRequest, isPending: resolving, variables: resolveVars } =
    useResolveAccessRequest();
  const patchNotificationsByEntity = useNotificationStore(
    (state) => state.patchNotificationsByEntity,
  );

  const handleResolveAccessRequest = (
    e: React.MouseEvent,
    notificationId: string,
    requestId: string,
    status: 'approved' | 'denied',
  ) => {
    e.stopPropagation();
    e.preventDefault();
    if (resolving) return;
    resolveAccessRequest(
      { id: requestId, status },
      {
        onSuccess: () => {
          toast.success(status === 'approved' ? 'Access granted.' : 'Access denied.');
          // Stamp the local notification so the row swaps to the status pill
          // immediately for the resolving admin (the workspace-wide topic
          // event covers the OTHER admins).
          patchNotificationsByEntity('access_request', requestId, {
            resolvedStatus: status,
          });
          markAsReadAction(notificationId);
        },
        onError: (err: Error & { status?: number }) => {
          if (err?.status === 409) {
            toast.message('Already resolved by another admin.');
            markAsReadAction(notificationId);
          } else {
            toast.error('Could not resolve the request. Please try again.');
          }
        },
      },
    );
  };

  return (
    <FloatingDrawer
      isOpen={isOpen}
      width={width}
      skipAnimation={skipAnimation}
      data-testid="notifications-panel"
    >
      {/* Panel Header */}
      <div className="px-4 py-3.5 border-b border-gray-200 dark:border-border bg-white dark:bg-background">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
            <span className="font-medium text-gray-900 dark:text-foreground">Notifications</span>
            {unreadCount > 0 && (
              <span className="h-[9px] w-[9px] rounded-full bg-red-500 border border-red-600" />
            )}
            {isLoading && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleMarkAllAsRead}
              disabled={unreadCount === 0}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400"
              title="Mark all as read"
              aria-label="Mark all as read"
            >
              <CheckCheck className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-all"
              aria-label="Close panel"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Notifications List */}
      <div className="flex-1 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center px-4">
            <p className="text-[13px] font-medium text-gray-900 dark:text-foreground">
              No notifications
            </p>
            <p className="text-[12px] text-gray-500 dark:text-muted-foreground mt-1">
              You&apos;ll see notifications here
            </p>
          </div>
        ) : (
          <div>
            {notifications.map((notification) => {
              const hasUnread = !notification.read;
              const displayName = notification.actorName || notification.title;
              const avatarSeed = displayName || '?';
              const initial = (avatarSeed.charAt(0) || '?').toUpperCase();
              // Approve/Deny stays visible as long as the underlying access
              // request is still pending — the read flag alone is meaningless
              // because clicking the row auto-marks-read without resolving
              // anything. Once any admin (locally or via the workspace topic
              // event) resolves the request, `resolvedStatus` is set and the
              // row swaps to a status pill instead.
              const isAccessRequest =
                notification.notificationType === 'access_request' &&
                !!notification.entityId &&
                !notification.resolvedStatus;
              const accessRequestResolved =
                notification.notificationType === 'access_request' &&
                !!notification.resolvedStatus;

              // Email-list-style row body
              const content = (
                <div className="px-3 md:px-4 py-3">
                  <div className="flex items-start gap-2.5">
                    {/* Avatar */}
                    <div className="relative flex-shrink-0 mt-[3px]">
                      {notification.actorImageUrl ? (
                        <img
                          src={notification.actorImageUrl}
                          alt={displayName}
                          className="w-7 h-7 rounded-[10px] object-cover"
                        />
                      ) : (
                        <div
                          className="w-7 h-7 rounded-[10px] flex items-center justify-center text-white font-semibold text-xs"
                          style={{ backgroundColor: getAvatarColor(avatarSeed) }}
                        >
                          {initial}
                        </div>
                      )}
                      {hasUnread && (
                        <div className="absolute top-1/2 -translate-y-1/2 -left-2.5 w-1.5 h-1.5 rounded-full bg-blue-600" />
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <span
                        className={cn(
                          'block text-sm truncate',
                          hasUnread
                            ? 'font-semibold text-gray-900 dark:text-foreground'
                            : 'font-medium text-gray-500 dark:text-muted-foreground'
                        )}
                      >
                        {notification.title}
                      </span>
                      {notification.description && (
                        <div
                          className={cn(
                            'text-[13px] truncate mt-0.5',
                            hasUnread
                              ? 'text-gray-500 dark:text-muted-foreground'
                              : 'text-gray-400 dark:text-muted-foreground'
                          )}
                        >
                          {renderContentWithMentions(notification.description, membersMap)}
                        </div>
                      )}
                      <div className="text-[11.5px] text-gray-400 dark:text-muted-foreground mt-1">
                        {formatTimestamp(notification.timestamp)}
                      </div>
                      {isAccessRequest && notification.entityId && (
                        <div className="flex items-center gap-2 mt-2">
                          <Button
                            type="button"
                            variant="default"
                            disabled={resolving}
                            onClick={(e) =>
                              handleResolveAccessRequest(e, notification.id, notification.entityId!, 'approved')
                            }
                            className="h-7 px-3 text-xs font-medium rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {resolving && resolveVars?.id === notification.entityId && resolveVars?.status === 'approved'
                              ? 'Approving…'
                              : 'Approve'}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={resolving}
                            onClick={(e) =>
                              handleResolveAccessRequest(e, notification.id, notification.entityId!, 'denied')
                            }
                            className="h-7 px-3 text-xs font-medium rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {resolving && resolveVars?.id === notification.entityId && resolveVars?.status === 'denied'
                              ? 'Denying…'
                              : 'Deny'}
                          </Button>
                        </div>
                      )}
                      {accessRequestResolved && (
                        <div className="mt-2">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-medium',
                              notification.resolvedStatus === 'approved'
                                ? 'bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-400'
                                : 'bg-gray-100 text-gray-600 dark:bg-secondary dark:text-muted-foreground',
                            )}
                          >
                            {notification.resolvedStatus === 'approved' ? (
                              <>
                                <Check className="h-3 w-3" />
                                Approved
                              </>
                            ) : (
                              <>
                                <X className="h-3 w-3" />
                                Denied
                              </>
                            )}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Hover actions */}
                    <div className="absolute right-3 md:right-4 top-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {hasUnread && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleMarkAsRead(notification.id); }}
                          className="h-7 w-7 inline-flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-all"
                          title="Mark as read"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleDeleteNotification(notification.id); }}
                        className="h-7 w-7 inline-flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-all"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              );

              const baseClassName = cn(
                'relative group block border-b border-gray-100 dark:border-border transition-colors cursor-pointer',
                'hover:bg-gray-50 dark:hover:bg-secondary'
              );

              if (notification.href && !isAccessRequest) {
                return (
                  <Link
                    key={notification.id}
                    href={notification.href}
                    className={baseClassName}
                    onClick={() => handleMarkAsRead(notification.id)}
                  >
                    {content}
                  </Link>
                );
              }

              return (
                <div
                  key={notification.id}
                  className={baseClassName}
                  onClick={isAccessRequest ? undefined : () => handleMarkAsRead(notification.id)}
                >
                  {content}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </FloatingDrawer>
  );
}
