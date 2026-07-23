
import { useState, useEffect } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  Activity,
  Coins,
  MessageSquare,
  TrendingUp,
  Zap,
  Calendar,
  AlertCircle,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { Progress } from '@weldsuite/ui/components/progress';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { AVAILABLE_MODELS } from '@/lib/weldagent/tools/types';
import { useAppApiClient } from '@/lib/api/use-app-api';

interface CreditsInfo {
  quota: number;
  used: number;
  remaining: number;
  usagePercentage: number;
  isExhausted: boolean;
  tokensUsed: number;
  resetDate: string;
  status: 'success' | 'warning' | 'destructive';
}

interface UsageStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostCents: number;
  totalToolCalls: number;
  usageByModel: Record<string, { requests: number; tokens: number; cost: number }>;
  usageByModule: Record<string, { requests: number; tokens: number }>;
  recentUsage: Array<{
    date: string;
    requests: number;
    tokens: number;
    cost: number;
  }>;
}

interface UsageDashboardProps {
  workspaceId?: string;
  userId?: string;
}

export function UsageDashboard({ workspaceId, userId }: UsageDashboardProps) {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const [isLoading, setIsLoading] = useState(true);
  const [period, setPeriod] = useState<'7d' | '30d' | '90d'>('30d');
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [creditsInfo, setCreditsInfo] = useState<CreditsInfo | null>(null);
  const [creditsError, setCreditsError] = useState<string | null>(null);

  // Load credits info
  useEffect(() => {
    async function loadCredits() {
      try {
        const client = await getClient();
        const result = await client.get<{ data: any }>('/credits/balance');
        if (result.data) {
          setCreditsInfo({
            quota: result.data.monthlyAllocation || 0,
            used: (result.data.monthlyAllocation || 0) - (result.data.currentBalance || 0),
            remaining: result.data.currentBalance || 0,
            usagePercentage: result.data.usagePercentage || 0,
            isExhausted: result.data.isExhausted || false,
            tokensUsed: 0,
            resetDate: result.data.periodEnd || '',
            status: result.data.isExhausted ? 'destructive' : result.data.isLow ? 'warning' : 'success',
          });
        }
        setCreditsError(null);
      } catch (error) {
        console.error('[UsageDashboard] Failed to load credits:', error);
        setCreditsError(t('sweep.shared.failedToLoadCreditsInformation'));
      }
    }
    loadCredits();
  }, [getClient, t]);

  // Load usage stats
  useEffect(() => {
    async function loadStats() {
      setIsLoading(true);
      try {
        // For now, we'll use mock data since we don't have the API endpoint yet
        // In production, this would call: /api/weldagent/usage
        const mockStats: UsageStats = {
          totalRequests: 1247,
          totalInputTokens: 892450,
          totalOutputTokens: 456230,
          totalTokens: 1348680,
          totalCostCents: 4520, // $45.20
          totalToolCalls: 328,
          usageByModel: {
            'openai/gpt-4o': { requests: 523, tokens: 678900, cost: 2890 },
            'openai/gpt-4o-mini': { requests: 412, tokens: 345000, cost: 520 },
            'anthropic/claude-sonnet-4-20250514': { requests: 189, tokens: 234780, cost: 890 },
            'google/gemini-2.0-flash': { requests: 123, tokens: 90000, cost: 220 },
          },
          usageByModule: {
            tasks: { requests: 456, tokens: 534000 },
            crm: { requests: 234, tokens: 287000 },
            helpdesk: { requests: 312, tokens: 345000 },
            general: { requests: 100, tokens: 70000 },
          },
          recentUsage: [
            { date: '2026-01-05', requests: 42, tokens: 45230, cost: 156 },
            { date: '2026-01-04', requests: 56, tokens: 62100, cost: 203 },
            { date: '2026-01-03', requests: 38, tokens: 41000, cost: 134 },
            { date: '2026-01-02', requests: 61, tokens: 67890, cost: 221 },
            { date: '2026-01-01', requests: 45, tokens: 48000, cost: 158 },
          ],
        };

        setStats(mockStats);
      } catch (error) {
        console.error('[UsageDashboard] Failed to load stats:', error);
      } finally {
        setIsLoading(false);
      }
    }

    loadStats();
  }, [period, workspaceId, userId]);

  const formatCost = (cents: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(cents / 100);
  };

  const formatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t('sweep.shared.loadingEllipsis')}</span>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="text-center py-8 text-gray-500">
        {t('sweep.shared.noUsageDataAvailable')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-foreground">
            {t('sweep.shared.aiUsageDashboard')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-muted-foreground">
            {t('sweep.shared.trackWeldAgentUsage')}
          </p>
        </div>
        <Select value={period} onValueChange={(v) => setPeriod(v as '7d' | '30d' | '90d')}>
          <SelectTrigger className="w-32">
            <Calendar className="h-4 w-4 mr-2" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">{t('sweep.shared.lastNDays', { count: 7 })}</SelectItem>
            <SelectItem value="30d">{t('sweep.shared.lastNDays', { count: 30 })}</SelectItem>
            <SelectItem value="90d">{t('sweep.shared.lastNDays', { count: 90 })}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Monthly Credits Card */}
      {creditsInfo && (
        <Card className={creditsInfo.isExhausted ? 'border-destructive' : ''}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                <CardTitle className="text-base">{t('sweep.shared.monthlyAiCredits')}</CardTitle>
              </div>
              <Badge variant={creditsInfo.status === 'success' ? 'outline' : creditsInfo.status}>
                {creditsInfo.isExhausted ? t('sweep.shared.exhausted') : t('sweep.shared.creditsRemaining', { count: creditsInfo.remaining })}
              </Badge>
            </div>
            <CardDescription>
              {t('sweep.shared.resetsOnDate', { date: new Date(creditsInfo.resetDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {t('sweep.shared.creditsUsedOfQuota', { used: creditsInfo.used.toLocaleString(), quota: creditsInfo.quota.toLocaleString() })}
                </span>
                <span className="font-medium">{creditsInfo.usagePercentage}%</span>
              </div>
              <Progress
                value={creditsInfo.usagePercentage}
                className={creditsInfo.status === 'destructive' ? '[&>div]:bg-destructive' : creditsInfo.status === 'warning' ? '[&>div]:bg-yellow-500' : ''}
              />
            </div>

            {creditsInfo.isExhausted && (
              <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-lg text-destructive text-sm">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">{t('sweep.shared.creditsExhausted')}</p>
                  <p className="text-destructive/80">
                    {t('sweep.shared.creditsExhaustedDescription')}
                  </p>
                </div>
              </div>
            )}

            {!creditsInfo.isExhausted && creditsInfo.usagePercentage >= 90 && (
              <div className="flex items-start gap-2 p-3 bg-yellow-500/10 rounded-lg text-yellow-700 dark:text-yellow-400 text-sm">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">{t('sweep.shared.runningLowOnCredits')}</p>
                  <p className="opacity-80">
                    {t('sweep.shared.runningLowOnCreditsDescription', { percentage: creditsInfo.usagePercentage })}
                  </p>
                </div>
              </div>
            )}

            <div className="pt-2 border-t flex justify-between text-sm text-muted-foreground">
              <span>{t('sweep.shared.creditToTokenRatio')}</span>
              <span>{t('sweep.shared.tokensUsedCount', { count: formatNumber(creditsInfo.tokensUsed) })}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {creditsError && (
        <div className="flex items-center gap-2 p-3 bg-destructive/10 rounded-lg text-destructive text-sm">
          <AlertCircle className="h-4 w-4" />
          {creditsError}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('sweep.shared.totalRequests')}</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatNumber(stats.totalRequests)}</div>
            <p className="text-xs text-muted-foreground">
              {t('sweep.shared.toolCallsCount', { count: stats.totalToolCalls })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('sweep.shared.totalTokens')}</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatNumber(stats.totalTokens)}</div>
            <p className="text-xs text-muted-foreground">
              {t('sweep.shared.tokensInOut', { in: formatNumber(stats.totalInputTokens), out: formatNumber(stats.totalOutputTokens) })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('sweep.shared.estimatedCost')}</CardTitle>
            <Coins className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCost(stats.totalCostCents)}</div>
            <p className="text-xs text-muted-foreground">
              {t('sweep.shared.avgPerDay', { cost: formatCost(Math.round(stats.totalCostCents / 30)) })}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('sweep.shared.avgTokensPerRequest')}</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatNumber(Math.round(stats.totalTokens / stats.totalRequests))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('sweep.shared.costPerRequest', { cost: formatCost(Math.round(stats.totalCostCents / stats.totalRequests)) })}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Usage by Model */}
      <Card>
        <CardHeader>
          <CardTitle>{t('sweep.shared.usageByModel')}</CardTitle>
          <CardDescription>{t('sweep.shared.usageByModelDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {Object.entries(stats.usageByModel)
              .sort((a, b) => b[1].tokens - a[1].tokens)
              .map(([modelId, usage]) => {
                const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
                const percentage = Math.round((usage.tokens / stats.totalTokens) * 100);

                return (
                  <div key={modelId} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{model?.name || modelId}</span>
                        <span className="text-xs text-gray-500">
                          ({model?.provider || t('sweep.shared.unknown')})
                        </span>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-gray-500">{t('sweep.shared.requestsCount', { count: usage.requests })}</span>
                        <span className="text-gray-500">{t('sweep.shared.tokensCount', { count: formatNumber(usage.tokens) })}</span>
                        <span className="font-medium">{formatCost(usage.cost)}</span>
                      </div>
                    </div>
                    <div className="h-2 bg-gray-100 dark:bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gray-900 dark:bg-gray-100 rounded-full transition-all"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
          </div>
        </CardContent>
      </Card>

      {/* Usage by Module */}
      <Card>
        <CardHeader>
          <CardTitle>{t('sweep.shared.usageByModule')}</CardTitle>
          <CardDescription>{t('sweep.shared.usageByModuleDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {Object.entries(stats.usageByModule)
              .sort((a, b) => b[1].requests - a[1].requests)
              .map(([module, usage]) => (
                <div
                  key={module}
                  className="p-4 bg-gray-50 dark:bg-background rounded-lg text-center"
                >
                  <div className="text-xl font-bold">{usage.requests}</div>
                  <div className="text-sm text-gray-500 capitalize">{module}</div>
                  <div className="text-xs text-gray-400 mt-1">
                    {t('sweep.shared.tokensCount', { count: formatNumber(usage.tokens) })}
                  </div>
                </div>
              ))}
          </div>
        </CardContent>
      </Card>

      {/* Recent Usage */}
      <Card>
        <CardHeader>
          <CardTitle>{t('sweep.shared.recentActivity')}</CardTitle>
          <CardDescription>{t('sweep.shared.recentActivityDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {stats.recentUsage.map((day) => (
              <div key={day.date} className="flex items-center justify-between py-2 border-b last:border-0">
                <div className="text-sm font-medium">
                  {new Date(day.date).toLocaleDateString('en-US', {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  })}
                </div>
                <div className="flex items-center gap-6 text-sm text-gray-500">
                  <span>{t('sweep.shared.requestsCount', { count: day.requests })}</span>
                  <span>{t('sweep.shared.tokensCount', { count: formatNumber(day.tokens) })}</span>
                  <span className="font-medium text-gray-900 dark:text-foreground">
                    {formatCost(day.cost)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
