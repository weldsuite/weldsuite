import { Loader2, BarChart2, RefreshCw } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  useSocialAnalyticsOverview,
  useSocialPosts,
  useSyncSocialPostMetrics,
} from '@/hooks/queries/use-social-queries';
import type { SocialPost } from '@weldsuite/app-api-client/domains/social';

export function AnalyticsClient() {
  const { t } = useI18n();
  const st = useTranslations();
  const { data: overviewData, isLoading: overviewLoading } = useSocialAnalyticsOverview();
  const { data: postsData, isLoading: postsLoading } = useSocialPosts({ limit: 20 });
  const syncMetrics = useSyncSocialPostMetrics();

  const overview = overviewData?.data;
  const posts = postsData?.data || [];
  const platformStats = overview?.platformStats || [];

  if (overviewLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{t.social.analytics.title}</h1>

      {/* Overview cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[
          { label: t.social.analytics.impressions, value: overview?.totalImpressions ?? 0 },
          { label: t.social.analytics.reach, value: overview?.totalReach ?? 0 },
          { label: t.social.analytics.engagement, value: overview?.totalEngagement ?? 0 },
          { label: t.social.analytics.clicks, value: overview?.totalClicks ?? 0 },
          { label: t.social.analytics.engagementRate, value: overview?.engagementRate != null ? `${overview.engagementRate}%` : '0%' },
        ].map(({ label, value }) => (
          <Card key={label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Platform stats */}
      {platformStats.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t.social.analytics.platformComparison}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{st('sweep.miscA.socialAnalytics.platform')}</TableHead>
                  <TableHead>{t.social.analytics.followers}</TableHead>
                  <TableHead>{st('sweep.miscA.socialAnalytics.posts')}</TableHead>
                  <TableHead>{t.social.analytics.engagement}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {platformStats.map((row: { platform: string; followers: number; posts: number; engagement: number }) => (
                  <TableRow key={row.platform}>
                    <TableCell className="capitalize">{row.platform}</TableCell>
                    <TableCell>{row.followers ?? 0}</TableCell>
                    <TableCell>{row.posts ?? 0}</TableCell>
                    <TableCell>{row.engagement ?? 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Posts with sync */}
      <Card>
        <CardHeader>
          <CardTitle>{t.social.analytics.topPosts}</CardTitle>
        </CardHeader>
        <CardContent>
          {postsLoading ? (
            <div className="flex items-center justify-center h-24">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : posts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-24 text-muted-foreground gap-2">
              <BarChart2 className="h-6 w-6 opacity-20" />
              <p className="text-sm">{t.social.posts.noPosts}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {posts.map((post: SocialPost) => (
                <div key={post.id} className="flex items-center justify-between gap-3 py-2 border-b last:border-0">
                  <p className="text-sm line-clamp-1 flex-1">{post.content || '—'}</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => syncMetrics.mutate(post.id)}
                    disabled={syncMetrics.isPending}
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-1" />
                    {t.social.analytics.overview}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
