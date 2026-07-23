import { Loader2, CalendarDays, Clock, CheckCircle, Link2 } from 'lucide-react';
import { format as formatDate } from 'date-fns';
import { useI18n } from '@/lib/i18n/provider';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { useSocialDashboardStats, useSocialPosts } from '@/hooks/queries/use-social-queries';

const statusColors: Record<string, string> = {
  draft: 'secondary',
  scheduled: 'default',
  published: 'default',
  failed: 'destructive',
  pending_approval: 'outline',
};

export function DashboardClient() {
  const { t, format } = useI18n();
  const { data: statsData, isLoading: statsLoading } = useSocialDashboardStats();
  const { data: postsData, isLoading: postsLoading } = useSocialPosts({ limit: 5 });

  const stats = (statsData as any)?.data;
  const posts = postsData?.data || [];

  if (statsLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{t.social.dashboard.socialDashboard}</h1>

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t.social.posts.scheduled}
            </CardTitle>
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.scheduledPosts ?? 0}</div>
            <p className="text-xs text-muted-foreground">
              {format(t.social.dashboard.scheduledPosts, { count: stats?.scheduledPosts ?? 0 })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t.social.queue.pendingApprovals}
            </CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.pendingApproval ?? 0}</div>
            <p className="text-xs text-muted-foreground">
              {format(t.social.dashboard.pendingApproval, { count: stats?.pendingApproval ?? 0 })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t.social.posts.published}
            </CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.publishedThisWeek ?? 0}</div>
            <p className="text-xs text-muted-foreground">
              {format(t.social.dashboard.publishedThisWeek, { count: stats?.publishedThisWeek ?? 0 })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t.social.accounts.connectedAccounts}
            </CardTitle>
            <Link2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.connectedAccounts ?? 0}</div>
            <p className="text-xs text-muted-foreground">{t.social.dashboard.connectedAccounts}</p>
          </CardContent>
        </Card>
      </div>

      {/* Recent posts */}
      <Card>
        <CardHeader>
          <CardTitle>{t.social.dashboard.recentActivity}</CardTitle>
        </CardHeader>
        <CardContent>
          {postsLoading ? (
            <div className="flex items-center justify-center h-24">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : posts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">{t.social.posts.noPosts}</p>
          ) : (
            <div className="space-y-3">
              {posts.map((post: any) => (
                <div key={post.id} className="flex items-start justify-between gap-3 py-2 border-b last:border-0">
                  <p className="text-sm line-clamp-2 flex-1">
                    {post.content || '—'}
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={(statusColors[post.status] || 'secondary') as any}>
                      {t.social.posts.statuses[post.status as keyof typeof t.social.posts.statuses] || post.status}
                    </Badge>
                    {post.scheduledAt && (
                      <span className="text-xs text-muted-foreground">
                        {formatDate(new Date(post.scheduledAt), 'MMM d')}
                      </span>
                    )}
                    {post.publishedAt && (
                      <span className="text-xs text-muted-foreground">
                        {formatDate(new Date(post.publishedAt), 'MMM d')}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
