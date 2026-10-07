import { useState } from 'react';
import { CalendarDays, Link2, MoreVertical, Pencil, Plus, Power, PowerOff, Trash2 } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useOrganization } from '@clerk/clerk-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@weldsuite/ui/components/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useToggleBookingPage } from '@/hooks/queries/use-calendar-queries';
import { usePathname } from '@/lib/router';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { buildBookingPageUrl } from '@/lib/weldcalendar/booking-portal-url';
import { DeleteBookingPageDialog } from './delete-booking-page-dialog';

export interface BookingPageSidebarItem {
  id: string;
  name: string;
  slug: string;
  isDraft?: boolean;
  /** False when the page is switched off (its public link takes no bookings). Defaults to active. */
  isActive?: boolean;
}

interface BookingPagesSidebarSectionProps {
  bookingPages: BookingPageSidebarItem[];
  onAdd?: () => void;
}

export function BookingPagesSidebarSection({ bookingPages, onAdd }: Readonly<BookingPagesSidebarSectionProps>) {
  const navigate = useNavigate();
  const { organization } = useOrganization();
  const toggleBookingPage = useToggleBookingPage();
  const pathname = usePathname();
  const t = getTranslations('weldcalendar');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  const orgSlug = organization?.slug || organization?.id || '';

  const copyLink = (slug: string) => {
    // The public booking portal link, never the platform origin (which needs a login).
    const url = buildBookingPageUrl(orgSlug, slug);
    void navigator.clipboard.writeText(url);
    toast.success(t.toast.bookingLinkCopied);
  };

  const handleToggle = async (bp: BookingPageSidebarItem) => {
    try {
      const result = await toggleBookingPage.mutateAsync(bp.id);
      const message = result?.data?.isActive
        ? t.bookingPagesSidebar.activated
        : t.bookingPagesSidebar.deactivated;
      toast.success(message.replace('{name}', bp.name));
    } catch {
      toast.error(t.bookingPagesSidebar.toggleFailed);
    }
  };

  // Deleting the page that is open would leave its view showing a page that no longer exists.
  const handleDeleted = (id: string) => {
    const basePath = `/weldcalendar/scheduling/${id}`;
    if (pathname === basePath || pathname.startsWith(`${basePath}/`)) {
      void navigate({ to: '/weldcalendar/scheduling' });
    }
  };

  return (
    <>
      <SidebarMenu>
        {bookingPages.length === 0 && onAdd && (
          <SidebarMenuItem>
            <Button
              variant="ghost"
              onClick={onAdd}
              className="flex items-center justify-center gap-2 w-full px-3 py-2 text-xs text-muted-foreground hover:text-foreground border border-dashed border-gray-300 dark:border-border hover:border-gray-400 dark:hover:border-gray-500 rounded-md transition-colors"
            >
              <Plus className="h-4 w-4" />
              <span>{t.bookingPagesSidebar.addBookingPage}</span>
            </Button>
          </SidebarMenuItem>
        )}
        {bookingPages.map((bp) => {
          if (bp.isDraft) {
            const isActive =
              pathname === '/weldcalendar/scheduling/new' ||
              pathname === '/weldcalendar/scheduling/__draft__';
            return (
              <SidebarMenuItem key={bp.id}>
                <SidebarMenuButton
                  isActive={isActive}
                  className="justify-between"
                  onClick={() => navigate({ to: '/weldcalendar/scheduling/new' })}
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="truncate text-sm">{bp.name}</span>
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          }
          const basePath = `/weldcalendar/scheduling/${bp.id}`;
          const isActive = pathname === basePath || pathname.startsWith(`${basePath}/`);
          const isInactive = bp.isActive === false;
          return (
          <SidebarMenuItem key={bp.id} className="group/bp relative">
            <SidebarMenuButton
              isActive={isActive}
              onClick={() => navigate({ to: '/weldcalendar/scheduling/$id/view', params: { id: bp.id } })}
              // The action icons live in an absolutely-positioned sibling, so
              // hovering them takes the cursor off this button. Drive the row
              // highlight off the row group instead so it stays put while the
              // icons (and their own darker hover patch) are being used.
              className="group-hover/bp:bg-sidebar-accent group-hover/bp:text-sidebar-accent-foreground"
            >
              <div className="flex items-center gap-2 flex-1 min-w-0 pr-0 group-hover/bp:pr-14">
                <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className={cn('truncate text-sm', isInactive && 'text-muted-foreground')}>{bp.name}</span>
                {isInactive && (
                  <Badge variant="secondary" className="ml-auto shrink-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground group-hover/bp:hidden">
                    {t.bookingPagesSidebar.inactive}
                  </Badge>
                )}
              </div>
            </SidebarMenuButton>
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover/bp:opacity-100 focus-within:opacity-100 pointer-events-none group-hover/bp:pointer-events-auto focus-within:pointer-events-auto">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 hover:bg-black/[0.05] dark:hover:bg-black/20 rounded-md"
                aria-label={t.bookingPagesSidebar.copyLinkFor.replace('{name}', bp.name)}
                title={t.bookingPagesSidebar.copyLink}
                onClick={(e) => { e.stopPropagation(); copyLink(bp.slug); }}
              >
                <Link2 className="h-3.5 w-3.5" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 hover:bg-black/[0.05] dark:hover:bg-black/20 rounded-md"
                    aria-label={t.bookingPagesSidebar.menuLabel.replace('{name}', bp.name)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreVertical className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onClick={() => navigate({ to: '/weldcalendar/scheduling/$id/edit', params: { id: bp.id } })}>
                    <Pencil className="h-4 w-4 mr-0.5" />
                    {t.bookingPagesSidebar.edit}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleToggle(bp)}
                    disabled={toggleBookingPage.isPending}
                  >
                    {isInactive ? <Power className="h-4 w-4 mr-0.5" /> : <PowerOff className="h-4 w-4 mr-0.5" />}
                    {isInactive ? t.bookingPagesSidebar.activate : t.bookingPagesSidebar.deactivate}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setPendingDelete({ id: bp.id, name: bp.name })}
                    variant="destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-0.5" />
                    {t.bookingPagesSidebar.delete}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
      <DeleteBookingPageDialog
        bookingPage={pendingDelete}
        onOpenChange={(open) => { if (!open) setPendingDelete(null); }}
        onDeleted={handleDeleted}
      />
    </>
  );
}
