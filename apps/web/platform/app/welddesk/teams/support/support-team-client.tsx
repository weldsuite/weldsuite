
import { Link, useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { format } from 'date-fns';
import { Card, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { MessageSquare, CheckCircle, Clock, User, MoreVertical, Eye } from 'lucide-react';
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

interface TeamMember {
  id: string;
  name: string;
  email: string;
  avatar: string;
  role: string;
  activeTickets: number;
  resolvedToday: number;
  avgResponseTime: string;
  status: 'online' | 'away' | 'offline';
}

interface RecentFeedback {
  id: string;
  subject: string;
  customerName: string;
  status: string;
  priority: string;
  assignedTo: string;
  createdAt: Date;
}

interface SupportTeamClientProps {
  teamData: {
    id: string;
    name: string;
    description: string;
    color: string;
    members: TeamMember[];
    recentFeedback: RecentFeedback[];
  };
}

export function SupportTeamClient({ teamData }: SupportTeamClientProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const tm = t.helpdesk.teams;
  const router = useRouter();

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: tm.title, href: '/welddesk/teams' },
    { label: tm.supportTeam },
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
      case 'high': return 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400';
      case 'medium': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400';
      case 'low': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400';
      default: return 'bg-gray-100 text-gray-800 dark:bg-background/20 dark:text-muted-foreground';
    }
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'new': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400';
      case 'in-review': return 'bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400';
      case 'planned': return 'bg-orange-100 text-orange-800 dark:bg-orange-900/20 dark:text-orange-400';
      case 'implemented': return 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400';
      case 'declined': return 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400';
      default: return 'bg-gray-100 text-gray-800 dark:bg-background/20 dark:text-muted-foreground';
    }
  };

  // Team Members Table Columns
  const memberColumns: ColumnDefinition<TeamMember>[] = [
    {
      key: 'member',
      label: tm.teamMembers,
      sortable: true,
      width: '300px',
      render: (member) => (
        <div className="flex items-center gap-3">
          <div className="relative">
            <Avatar className="h-10 w-10">
              <AvatarFallback className="bg-primary text-primary-foreground text-sm">
                {member.avatar}
              </AvatarFallback>
            </Avatar>
            <div className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-background ${getStatusColor(member.status)}`} />
          </div>
          <div>
            <div className="font-medium">{member.name}</div>
            <div className="text-sm text-muted-foreground">{member.email}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      label: tm.role,
      sortable: true,
      render: (member) => (
        <Badge variant="secondary" className="capitalize">
          {member.role}
        </Badge>
      ),
    },
    {
      key: 'status',
      label: tm.status,
      sortable: true,
      render: (member) => (
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${getStatusColor(member.status)}`} />
          <span className="capitalize font-medium">{member.status}</span>
        </div>
      ),
    },
    {
      key: 'activeTickets',
      label: tm.activeTickets,
      sortable: true,
      render: (member) => (
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-orange-500" />
          <span className="font-medium">{member.activeTickets}</span>
        </div>
      ),
    },
    {
      key: 'resolvedToday',
      label: tm.resolvedToday,
      sortable: true,
      render: (member) => (
        <div className="flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-green-500" />
          <span className="font-medium">{member.resolvedToday}</span>
        </div>
      ),
    },
    {
      key: 'avgResponseTime',
      label: tm.avgResponseTime,
      sortable: true,
      render: (member) => (
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-blue-500" />
          <span className="font-medium">{member.avgResponseTime}</span>
        </div>
      ),
    },
    {
      key: 'actions',
      label: '',
      width: '50px',
      render: () => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0 shadow-none hover:bg-muted">
              <span className="sr-only">{st('sweep.welddesk.supportTeam.openMenu')}</span>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>{tm.actions}</DropdownMenuLabel>
            <DropdownMenuItem>
              <Eye className="h-4 w-4 mr-0.5" />
              {tm.viewProfile}
            </DropdownMenuItem>
            <DropdownMenuItem>
              <MessageSquare className="h-4 w-4 mr-0.5" />
              {tm.viewTickets}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              {tm.editMember}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  // Recent Feedback Table Columns
  const feedbackColumns: ColumnDefinition<RecentFeedback>[] = [
    {
      key: 'subject',
      label: tm.subject,
      sortable: true,
      width: '300px',
      render: (feedback) => (
        <Link
          href={`/welddesk/feedback/${feedback.id}`}
          className="font-medium hover:underline"
        >
          {feedback.subject}
        </Link>
      ),
    },
    {
      key: 'customerName',
      label: tm.customer,
      sortable: true,
      render: (feedback) => (
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <span>{feedback.customerName}</span>
        </div>
      ),
    },
    {
      key: 'status',
      label: tm.status,
      sortable: true,
      render: (feedback) => (
        <Badge className={getStatusBadgeColor(feedback.status)}>
          {feedback.status.replace('-', ' ')}
        </Badge>
      ),
    },
    {
      key: 'priority',
      label: tm.priority,
      sortable: true,
      render: (feedback) => (
        <Badge className={getPriorityColor(feedback.priority)}>
          {feedback.priority}
        </Badge>
      ),
    },
    {
      key: 'assignedTo',
      label: tm.assignedTo,
      render: (feedback) => (
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm">{feedback.assignedTo}</span>
        </div>
      ),
    },
    {
      key: 'createdAt',
      label: tm.created,
      sortable: true,
      render: (feedback) => (
        <span className="text-sm text-muted-foreground">
          {format(feedback.createdAt, 'MMM d, yyyy')}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '',
      width: '50px',
      render: (feedback) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0 shadow-none hover:bg-muted">
              <span className="sr-only">{st('sweep.welddesk.supportTeam.openMenu')}</span>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>{tm.actions}</DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <Link href={`/welddesk/feedback/${feedback.id}`} className="flex items-center">
                <Eye className="h-4 w-4 mr-0.5" />
                {tm.viewDetails}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              {tm.changeStatus}
            </DropdownMenuItem>
            <DropdownMenuItem>
              {tm.reassign}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Team Overview Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className={`h-12 w-12 rounded-lg ${teamData.color} flex items-center justify-center`}>
              <User className="h-6 w-6 text-white" />
            </div>
            <div>
              <CardTitle>{teamData.name}</CardTitle>
              <CardDescription>{teamData.description}</CardDescription>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="members" className="w-full">
        <TabsList>
          <TabsTrigger value="members">{tm.teamMembers}</TabsTrigger>
          <TabsTrigger value="feedback">{tm.recentFeedback}</TabsTrigger>
        </TabsList>

        {/* Members Tab */}
        <TabsContent value="members" className="mt-4">
          <EntityDataTable
            data={teamData.members}
            columns={memberColumns}
            pagination={{ currentPage: 1, totalPages: 1, totalItems: teamData.members.length, pageSize: 20 }}
            searchParams={{}}
            emptyMessage={t.helpdesk.teamsPage.noTeamMembersFound}
            emptyIcon="Users"
            onRowClick={(member) => router.push(`/welddesk/teams/support/members/${member.id}`)}
          />
        </TabsContent>

        {/* Recent Feedback Tab */}
        <TabsContent value="feedback" className="mt-4">
          <EntityDataTable
            data={teamData.recentFeedback}
            columns={feedbackColumns}
            pagination={{ currentPage: 1, totalPages: 1, totalItems: teamData.recentFeedback.length, pageSize: 20 }}
            searchParams={{}}
            emptyMessage={t.helpdesk.teamsPage.noRecentFeedbackFound}
            emptyIcon="MessageSquare"
            onRowClick={(feedback) => router.push(`/welddesk/feedback/${feedback.id}`)}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
