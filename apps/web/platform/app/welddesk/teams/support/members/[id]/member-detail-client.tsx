
import { useRouter, Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { format } from 'date-fns';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { CheckCircle, Clock, Mail, User, Phone, Calendar, Building, MoreVertical, Eye, Star, TrendingUp } from 'lucide-react';
import { EntityDataTable, type ColumnDefinition } from '@/components/entity-overview';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';

interface Ticket {
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
    recentTickets: Ticket[];
    performanceMetrics: {
      totalResolved: number;
      avgSatisfactionRating: number;
      avgFirstResponseTime: string;
      resolutionRate: number;
    };
  };
}

export function MemberDetailClient({ memberData }: MemberDetailClientProps) {
  const { t } = useI18n();
  const md = t.helpdesk.memberDetailPage;
  const router = useRouter();

  useBreadcrumbs([
    { label: md.helpdeskBreadcrumb, href: '/welddesk' },
    { label: md.teamsBreadcrumb, href: '/welddesk/teams' },
    { label: md.supportTeamBreadcrumb, href: '/welddesk/teams/support' },
    { label: memberData.name },
  ]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online': return 'bg-green-500';
      case 'away': return 'bg-yellow-500';
      case 'offline': return 'bg-gray-400';
      default: return 'bg-gray-400';
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'urgent': return 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400';
      case 'high': return 'bg-orange-100 text-orange-800 dark:bg-orange-900/20 dark:text-orange-400';
      case 'medium': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400';
      case 'low': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400';
      default: return 'bg-gray-100 text-gray-800 dark:bg-background/20 dark:text-muted-foreground';
    }
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'open': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400';
      case 'in-progress': return 'bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400';
      case 'pending': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400';
      case 'resolved': return 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400';
      case 'closed': return 'bg-gray-100 text-gray-800 dark:bg-background/20 dark:text-muted-foreground';
      default: return 'bg-gray-100 text-gray-800 dark:bg-background/20 dark:text-muted-foreground';
    }
  };

  // Recent Tickets Table Columns
  const ticketColumns: ColumnDefinition<Ticket>[] = [
    {
      key: 'id',
      label: md.ticketIdColumn,
      sortable: true,
      render: (ticket) => (
        <Link
          href={`/welddesk/tickets/${ticket.id}`}
          className="font-medium hover:underline text-primary"
        >
          {ticket.id}
        </Link>
      ),
    },
    {
      key: 'subject',
      label: md.subjectColumn,
      sortable: true,
      width: '300px',
      render: (ticket) => (
        <span className="font-medium">{ticket.subject}</span>
      ),
    },
    {
      key: 'customer',
      label: md.customerColumn,
      sortable: true,
      render: (ticket) => (
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <span>{ticket.customer}</span>
        </div>
      ),
    },
    {
      key: 'priority',
      label: md.priorityColumn,
      sortable: true,
      render: (ticket) => (
        <Badge className={getPriorityColor(ticket.priority)}>
          {ticket.priority}
        </Badge>
      ),
    },
    {
      key: 'status',
      label: md.statusColumn,
      sortable: true,
      render: (ticket) => (
        <Badge className={getStatusBadgeColor(ticket.status)}>
          {ticket.status.replace('-', ' ')}
        </Badge>
      ),
    },
    {
      key: 'createdAt',
      label: md.createdColumn,
      sortable: true,
      render: (ticket) => (
        <span className="text-sm text-muted-foreground">
          {format(ticket.createdAt, 'MMM d, yyyy · h:mm a')}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '',
      width: '50px',
      render: (ticket) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0 shadow-none hover:bg-muted">
              <span className="sr-only">{md.openMenuLabel}</span>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>{md.actionsLabel}</DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <Link href={`/welddesk/tickets/${ticket.id}`} className="flex items-center">
                <Eye className="h-4 w-4 mr-0.5" />
                {md.viewTicket}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              {md.changePriority}
            </DropdownMenuItem>
            <DropdownMenuItem>
              {md.reassignTicket}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Member Profile Card */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-4">
            <div className="relative">
              <Avatar className="h-20 w-20">
                <AvatarFallback className="bg-primary text-primary-foreground text-2xl">
                  {memberData.avatar}
                </AvatarFallback>
              </Avatar>
              <div className={`absolute bottom-0 right-0 h-5 w-5 rounded-full border-4 border-background ${getStatusColor(memberData.status)}`} />
            </div>
            <div className="flex-1">
              <CardTitle className="text-2xl">{memberData.name}</CardTitle>
              <CardDescription className="text-base mt-1">{memberData.role}</CardDescription>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Mail className="h-4 w-4" />
                  <span>{memberData.email}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Phone className="h-4 w-4" />
                  <span>{memberData.phone}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Building className="h-4 w-4" />
                  <span>{memberData.department}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="h-4 w-4" />
                  <span>{md.joinedDate.replace('{date}', format(memberData.joinedDate, 'MMM d, yyyy'))}</span>
                </div>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Performance Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>{md.totalResolvedMetric}</CardDescription>
            <CardTitle className="text-3xl">{memberData.performanceMetrics.totalResolved}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle className="h-3 w-3" />
              <span>{md.allTime}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>{md.satisfactionRatingMetric}</CardDescription>
            <CardTitle className="text-3xl flex items-center gap-1">
              {memberData.performanceMetrics.avgSatisfactionRating}
              <Star className="h-5 w-5 fill-yellow-400 text-yellow-400" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <TrendingUp className="h-3 w-3" />
              <span>{md.outOf}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>{md.avgFirstResponseMetric}</CardDescription>
            <CardTitle className="text-3xl">{memberData.performanceMetrics.avgFirstResponseTime}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>{md.responseTime}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription>{md.resolutionRateMetric}</CardDescription>
            <CardTitle className="text-3xl">{memberData.performanceMetrics.resolutionRate}%</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <TrendingUp className="h-3 w-3" />
              <span>{md.successRate}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="tickets" className="w-full">
        <TabsList>
          <TabsTrigger value="tickets">{md.recentTicketsTab}</TabsTrigger>
          <TabsTrigger value="reviews">{md.reviewsTab}</TabsTrigger>
          <TabsTrigger value="activity">{md.activityLogTab}</TabsTrigger>
        </TabsList>

        {/* Recent Tickets Tab */}
        <TabsContent value="tickets" className="mt-4">
          <EntityDataTable
            data={memberData.recentTickets}
            columns={ticketColumns}
            pagination={{ page: 1, totalPages: 1, totalCount: memberData.recentTickets.length, pageSize: 20, hasMore: false }}
            searchParams={{}}
            emptyMessage={t.helpdesk.teamsPage.noTicketsFound}
            emptyIcon="MessageSquare"
            onRowClick={(ticket) => router.push(`/welddesk/tickets/${ticket.id}`)}
          />
        </TabsContent>

        {/* Reviews Tab */}
        <TabsContent value="reviews" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground text-center py-8">
                {md.reviewsComingSoon}
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Activity Log Tab */}
        <TabsContent value="activity" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground text-center py-8">
                {md.activityComingSoon}
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
