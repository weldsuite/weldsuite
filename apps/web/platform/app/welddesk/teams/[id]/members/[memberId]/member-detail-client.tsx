
import { useRouter, Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { format } from 'date-fns';
import {
  Mail,
  Calendar,
  EllipsisVertical,
  ExternalLink,
  Copy,
  User,
  MapPin,
  Hash,
  Globe,
  Briefcase,
  MessageSquare,
  LogIn,
  UserCheck,
  Settings,
  Pencil,
  Trash2,
  UserMinus,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { Badge } from '@weldsuite/ui/components/badge';
import { Ticket as TicketIcon } from 'lucide-react';
import {
  PersonDetailLayout,
  type SidebarField,
} from '@/components/person-detail';

interface TicketData {
  id: string;
  subject: string;
  customer: string;
  priority: string;
  status: string;
  createdAt: Date;
}

interface MemberDetailClientProps {
  memberData: {
    id: string;
    name: string;
    email: string;
    avatar: string;
    role: string;
    status: 'online' | 'away' | 'offline';
    activeTickets: number;
    resolvedToday: number;
    avgResponseTime: string;
    phone: string;
    department: string;
    joinedDate: Date;
    recentTickets: TicketData[];
    performanceMetrics: {
      totalResolved: number;
      avgSatisfactionRating: number;
      avgFirstResponseTime: string;
      resolutionRate: number;
    };
  };
  teamId: string;
}

export function MemberDetailClient({ memberData, teamId }: MemberDetailClientProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const md = t.helpdesk.memberDetailPage;
  const router = useRouter();

  useBreadcrumbs([
    { label: md.helpdeskBreadcrumb, href: '/welddesk' },
    { label: md.teamsBreadcrumb, href: '/welddesk/teams' },
    { label: md.teamBreadcrumb, href: `/welddesk/teams/${teamId}` },
    { label: memberData.name },
  ]);

  const getPriorityBadge = (priority: string) => {
    switch (priority) {
      case 'urgent': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800';
      case 'high': return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800';
      case 'medium': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800';
      case 'low': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800';
      default: return 'bg-gray-100 text-gray-800 dark:bg-secondary dark:text-muted-foreground border-gray-200 dark:border-border';
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'open': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800';
      case 'in-progress': return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200 dark:border-purple-800';
      case 'pending': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800';
      case 'resolved': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800';
      case 'closed': return 'bg-gray-100 text-gray-800 dark:bg-secondary dark:text-muted-foreground border-gray-200 dark:border-border';
      default: return 'bg-gray-100 text-gray-800 dark:bg-secondary dark:text-muted-foreground border-gray-200 dark:border-border';
    }
  };

  // Tickets table component
  const TicketsTable = () => (
    <div className="rounded-lg border border-border/60 bg-card">
      <Table>
        <TableHeader className="[&_tr]:border-border/60">
          <TableRow className="border-border/60">
            <TableHead>{md.ticketColumn}</TableHead>
            <TableHead>{md.subjectColumn}</TableHead>
            <TableHead>{md.customerColumn}</TableHead>
            <TableHead>{md.priorityColumn}</TableHead>
            <TableHead>{md.statusColumn}</TableHead>
            <TableHead>{md.dateColumn}</TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_tr]:border-border/60">
          {memberData.recentTickets.length > 0 ? (
            memberData.recentTickets.map((ticket) => (
              <TableRow
                key={ticket.id}
                className="cursor-pointer border-border/60"
                onClick={() => router.push(`/welddesk/tickets/${ticket.id}`)}
              >
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <TicketIcon className="h-4 w-4 text-muted-foreground" />
                    #{ticket.id}
                  </div>
                </TableCell>
                <TableCell className="max-w-[200px] truncate">{ticket.subject}</TableCell>
                <TableCell>{ticket.customer}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={getPriorityBadge(ticket.priority)}>
                    {ticket.priority}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={getStatusBadge(ticket.status)}>
                    {ticket.status.replace('-', ' ')}
                  </Badge>
                </TableCell>
                <TableCell>{format(ticket.createdAt, 'MMM d, yyyy')}</TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                        <EllipsisVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={`/welddesk/tickets/${ticket.id}`} className="flex items-center">
                          <ExternalLink className="h-3.5 w-3.5 mr-2" />
                          {md.viewTicket}
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(ticket.id);
                      }}>
                        <Copy className="h-3.5 w-3.5 mr-2" />
                        {md.copyId}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem>{md.reassignTicket}</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">
                <TicketIcon className="h-12 w-12 mx-auto mb-2 opacity-20" />
                <p>{md.noTicketsAssigned}</p>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );

  // Activity log component
  const ActivityLog = () => (
    <div className="rounded-lg border border-border/60 bg-card divide-y divide-border/60">
      <div className="flex items-start gap-3 p-4">
        <div className="h-8 w-8 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center flex-shrink-0">
          <LogIn className="h-4 w-4 text-green-600 dark:text-green-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground">{st('sweep.welddesk.memberDetail.activityLoggedIn')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{st('sweep.welddesk.memberDetail.activityTodayTime')}</p>
        </div>
      </div>
      <div className="flex items-start gap-3 p-4">
        <div className="h-8 w-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
          <MessageSquare className="h-4 w-4 text-blue-600 dark:text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground">{st('sweep.welddesk.memberDetail.activityRepliedTicket', { ticketNumber: 'TK-1234' })}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{st('sweep.welddesk.memberDetail.activityYesterdayTime1')}</p>
        </div>
      </div>
      <div className="flex items-start gap-3 p-4">
        <div className="h-8 w-8 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center flex-shrink-0">
          <UserCheck className="h-4 w-4 text-purple-600 dark:text-purple-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground">{st('sweep.welddesk.memberDetail.activityResolvedTicket', { ticketNumber: 'TK-1198' })}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{st('sweep.welddesk.memberDetail.activityYesterdayTime2')}</p>
        </div>
      </div>
      <div className="flex items-start gap-3 p-4">
        <div className="h-8 w-8 rounded-full bg-gray-100 dark:bg-secondary flex items-center justify-center flex-shrink-0">
          <Settings className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground">{st('sweep.welddesk.memberDetail.activityUpdatedProfile')}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{st('sweep.welddesk.memberDetail.activityDecDate')}</p>
        </div>
      </div>
    </div>
  );

  return (
    <PersonDetailLayout
      header={{
        name: memberData.name,
        avatar: memberData.avatar,
        backUrl: `/welddesk/teams/${teamId}`,
        backLabel: md.backToTeam,
        primaryAction: {
          label: md.emailAction,
          icon: <Mail className="h-4 w-4" />,
          href: `mailto:${memberData.email}`,
        },
        dropdownItems: (
          <>
            <DropdownMenuItem onClick={() => router.push(`/welddesk/teams/${teamId}/members/edit`)}>
              <Pencil className="h-3.5 w-3.5 mr-2" />
              {md.editMember}
            </DropdownMenuItem>
            <DropdownMenuItem>
              <RefreshCw className="h-3.5 w-3.5 mr-2" />
              {md.resetPassword}
            </DropdownMenuItem>
            <DropdownMenuItem>
              <UserMinus className="h-3.5 w-3.5 mr-2" />
              {md.removeFromTeam}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive">
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              {md.deleteMember}
            </DropdownMenuItem>
          </>
        ),
      }}
      sidebar={{
        sections: [
          {
            fields: [
              { icon: <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: md.roleLabel, value: memberData.role },
              { icon: <MapPin className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: md.locationLabel, value: md.locationUnknown },
              { icon: <Briefcase className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: md.departmentLabel, value: memberData.department },
              { icon: <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: md.emailLabel, value: memberData.email },
              { icon: <Hash className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: md.idLabel, value: memberData.id.slice(0, 12) },
              { icon: <Globe className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: md.timezoneLabel, value: 'UTC+1' },
              { icon: <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: md.joinedLabel, value: format(memberData.joinedDate, 'MMM d, yyyy') },
            ],
          },
          {
            title: md.detailsSection,
            fields: [
              { label: md.nameField, value: memberData.name },
              { label: md.emailLabel, value: memberData.email },
              { label: md.phoneField, editable: true },
              { label: md.timezoneLabel, editable: true },
              { label: md.languageField, editable: true },
              { label: md.companyField, editable: true },
              { label: md.locationField, editable: true },
              { label: md.titleField, editable: true },
            ],
          },
          {
            title: md.skillsSection,
            fields: [
              { label: md.expertiseField, editable: true },
              { label: md.languagesField, editable: true },
              { label: md.certificationsField, editable: true },
            ],
          },
        ],
      }}
      content={{
        stats: [
          { label: md.activeTicketsStat, value: memberData.activeTickets },
          { label: md.resolvedTodayStat, value: memberData.resolvedToday },
          { label: md.totalResolvedStat, value: memberData.performanceMetrics.totalResolved },
          { label: md.avgResponseStat, value: memberData.performanceMetrics.avgFirstResponseTime },
        ],
        tabs: [
          { id: 'tickets', label: md.ticketsTab, content: <TicketsTable /> },
          { id: 'activity', label: md.activityTab, content: <ActivityLog /> },
        ],
        defaultTab: 'tickets',
      }}
    />
  );
}
