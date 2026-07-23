
import { useState } from 'react';
import { MessageSquare, Ticket, UserPlus, Star, ChevronRight } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { ChartBarInteractive } from './components/chart-bar-interactive';
import { RecentActivityTable } from './components/recent-tickets-table';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';

// ── Component ──

export default function HelpdeskDashboard() {
  const { t } = useI18n();
  const [period, setPeriod] = useState('weekly');

  const actionItems = [
    {
      title: '0 open conversations',
      icon: MessageSquare,
      href: '/welddesk/conversations',
    },
    {
      title: '0 open tickets',
      icon: Ticket,
      href: '/welddesk/tickets?status=open',
    },
    {
      title: '0 new contacts this week',
      icon: UserPlus,
      href: '/welddesk/contacts',
    },
    {
      title: '0 average review rating',
      icon: Star,
      href: '/welddesk/reviews',
    },
  ];

  return (
    <div className="min-h-full bg-background">
      <div className="container mx-auto p-4 md:p-8 max-w-[1600px] space-y-4 md:space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              {t.helpdesk.dashboard.title}
            </h1>
          </div>

          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[140px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">{t.helpdesk.dashboardPeriod.today}</SelectItem>
              <SelectItem value="weekly">{t.helpdesk.dashboardPeriod.weekly}</SelectItem>
              <SelectItem value="monthly">{t.helpdesk.dashboardPeriod.monthly}</SelectItem>
              <SelectItem value="yearly">{t.helpdesk.dashboardPeriod.yearly}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Interactive Chart */}
        <ChartBarInteractive data={[]} />

        {/* CTA Buttons */}
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {actionItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.title} href={item.href}>
                <div className="group relative overflow-hidden rounded-lg border bg-card p-3 transition-all hover:bg-accent/50">
                  <div className="flex items-center gap-3">
                    <div className="rounded-md bg-muted p-1.5 flex-shrink-0">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-tight">{item.title}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {/* Recent Activity */}
        <RecentActivityTable activities={[]} />
      </div>
    </div>
  );
}
