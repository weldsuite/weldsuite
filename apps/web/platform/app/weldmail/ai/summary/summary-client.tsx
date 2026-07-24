
import { useState } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  FileSearch,
  RefreshCw,
  Download,
  Clock,
  TrendingUp,
  AlertCircle,
  CheckCircle,
  XCircle,
  Info,
  Mail,
  Calendar,
  Users
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { Progress } from '@weldsuite/ui/components/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';

interface EmailSummaryData {
  totalEmails: number;
  unread: number;
  important: number;
  requiresAction: number;
  categories: Array<{ name: string; count: number; color: string }>;
  topSenders: Array<{ name: string; email: string; count: number }>;
  keyTopics: Array<{ topic: string; count: number; priority: string }>;
  actionItems: Array<{ task: string; due: string; from: string; priority: string }>;
}

interface SummaryClientProps {
  initialSummary: EmailSummaryData;
}

export function SummaryClient({ initialSummary }: SummaryClientProps) {
  const { t } = useI18n();

  // Set breadcrumbs for AI Summary
  useBreadcrumbs([
    { label: t.mail.header.mail, href: '/weldmail' },
    { label: t.mail.header.ai, href: '/weldmail/ai' },
    { label: t.mail.header.summary }
  ]);

  const [timeRange, setTimeRange] = useState('today');
  const [isGenerating, setIsGenerating] = useState(false);
  const [summary] = useState(initialSummary);

  const handleGenerate = () => {
    setIsGenerating(true);
    setTimeout(() => {
      setIsGenerating(false);
      toast.success(t.mail.ai.summaryUpdated);
    }, 2000);
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'text-red-500 dark:text-red-400';
      case 'medium': return 'text-yellow-500 dark:text-yellow-400';
      case 'low': return 'text-green-500 dark:text-green-400';
      default: return 'text-gray-500 dark:text-muted-foreground';
    }
  };

  const getPriorityIcon = (priority: string) => {
    switch (priority) {
      case 'high': return <AlertCircle className="h-4 w-4" />;
      case 'medium': return <Info className="h-4 w-4" />;
      case 'low': return <CheckCircle className="h-4 w-4" />;
      default: return <XCircle className="h-4 w-4" />;
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <FileSearch className="h-6 w-6 text-primary" />
              {t.mail.ai.summaryTitle}
            </h1>
            <p className="text-muted-foreground mt-1">
              {t.mail.ai.summarySubtitle}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={timeRange} onValueChange={setTimeRange}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">{t.mail.ai.periodToday}</SelectItem>
                <SelectItem value="week">{t.mail.ai.periodWeek}</SelectItem>
                <SelectItem value="month">{t.mail.ai.periodMonth}</SelectItem>
                <SelectItem value="quarter">{t.mail.ai.periodQuarter}</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={handleGenerate} disabled={isGenerating}>
              {isGenerating ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-0.5 animate-spin" />
                  {t.mail.ai.generating}
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-0.5" />
                  {t.mail.ai.refresh}
                </>
              )}
            </Button>
            <Button variant="outline">
              <Download className="h-4 w-4 mr-0.5" />
              {t.mail.ai.export}
            </Button>
          </div>
        </div>

        {/* Overview Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{t.mail.ai.totalEmails}</p>
                  <p className="text-2xl font-bold">{summary.totalEmails}</p>
                  <p className="text-xs text-muted-foreground mt-1">+15% from yesterday</p>
                </div>
                <Mail className="h-8 w-8 text-primary opacity-20" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{t.mail.ai.unread}</p>
                  <p className="text-2xl font-bold">{summary.unread}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t.mail.ai.needsAttention}</p>
                </div>
                <AlertCircle className="h-8 w-8 text-yellow-500 dark:text-yellow-400 opacity-20" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{t.mail.ai.important}</p>
                  <p className="text-2xl font-bold">{summary.important}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t.mail.ai.highPriority}</p>
                </div>
                <AlertCircle className="h-8 w-8 text-red-500 dark:text-red-400 opacity-20" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{t.mail.ai.actionRequired}</p>
                  <p className="text-2xl font-bold">{summary.requiresAction}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t.mail.ai.pendingTasks}</p>
                </div>
                <Clock className="h-8 w-8 text-blue-500 dark:text-blue-400 opacity-20" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">{t.mail.ai.overview}</TabsTrigger>
          <TabsTrigger value="topics">{t.mail.ai.keyTopics}</TabsTrigger>
          <TabsTrigger value="actions">{t.mail.ai.actionItems}</TabsTrigger>
          <TabsTrigger value="insights">{t.mail.ai.insights}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Categories Distribution */}
            <Card>
              <CardHeader>
                <CardTitle>{t.mail.ai.emailCategories}</CardTitle>
                <CardDescription>{t.mail.ai.emailCategoriesDescription}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {summary.categories.map((category) => (
                    <div key={category.name}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">{category.name}</span>
                        <span className="text-sm text-muted-foreground">{category.count}</span>
                      </div>
                      <div className="w-full bg-gray-200 dark:bg-accent rounded-full h-2">
                        <div
                          className={cn("h-2 rounded-full", category.color)}
                          style={{ width: `${(category.count / summary.totalEmails) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Top Senders */}
            <Card>
              <CardHeader>
                <CardTitle>{t.mail.ai.topSenders}</CardTitle>
                <CardDescription>{t.mail.ai.topSendersDescription}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {summary.topSenders.map((sender, index) => (
                    <div key={sender.email} className="flex items-center gap-3">
                      <span className="text-lg font-bold text-muted-foreground w-6">
                        {index + 1}
                      </span>
                      <Avatar className="h-8 w-8">
                        <AvatarFallback>{sender.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1">
                        <p className="text-sm font-medium">{sender.name}</p>
                        <p className="text-xs text-muted-foreground">{sender.email}</p>
                      </div>
                      <Badge variant="secondary">{sender.count} emails</Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="topics" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t.mail.ai.keyTopics}</CardTitle>
              <CardDescription>{t.mail.ai.keyTopicsDescription}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {summary.keyTopics.map((topic) => (
                  <div key={topic.topic} className="flex items-center justify-between p-3 rounded-lg border">
                    <div className="flex items-center gap-3">
                      <div className={cn("flex items-center justify-center", getPriorityColor(topic.priority))}>
                        {getPriorityIcon(topic.priority)}
                      </div>
                      <div>
                        <p className="font-medium">{topic.topic}</p>
                        <p className="text-sm text-muted-foreground">{topic.count} mentions</p>
                      </div>
                    </div>
                    <Badge
                      variant={topic.priority === 'high' ? 'destructive' : topic.priority === 'medium' ? 'default' : 'secondary'}
                    >
                      {topic.priority}
                    </Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="actions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t.mail.ai.actionItems}</CardTitle>
              <CardDescription>{t.mail.ai.actionItemsDescription}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {summary.actionItems.map((item, index) => (
                  <div key={index} className="flex items-start gap-3 p-3 rounded-lg border">
                    <div className={cn("mt-1", getPriorityColor(item.priority))}>
                      {getPriorityIcon(item.priority)}
                    </div>
                    <div className="flex-1">
                      <p className="font-medium">{item.task}</p>
                      <div className="flex items-center gap-4 mt-1">
                        <span className="text-sm text-muted-foreground flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {t.mail.ai.due.replace('{due}', item.due)}
                        </span>
                        <span className="text-sm text-muted-foreground flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {t.mail.ai.fromSender.replace('{from}', item.from)}
                        </span>
                      </div>
                    </div>
                    <Button size="sm">{t.mail.ai.complete}</Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="insights" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>{t.mail.ai.communicationPatterns}</CardTitle>
                <CardDescription>{t.mail.ai.communicationPatternsDescription}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm">{t.mail.ai.responseTime}</span>
                    <span className="text-sm font-medium">2.5 hours avg</span>
                  </div>
                  <Progress value={75} className="h-2" />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm">{t.mail.ai.emailVolumeTrend}</span>
                    <span className="text-sm font-medium flex items-center gap-1">
                      <TrendingUp className="h-3 w-3 text-green-500 dark:text-green-400" />
                      +12%
                    </span>
                  </div>
                  <Progress value={62} className="h-2" />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm">{t.mail.ai.peakActivity}</span>
                    <span className="text-sm font-medium">9-11 AM</span>
                  </div>
                  <Progress value={90} className="h-2" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t.mail.ai.recommendations}</CardTitle>
                <CardDescription>{t.mail.ai.recommendationsDescription}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <CheckCircle className="h-5 w-5 text-green-500 dark:text-green-400 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium">{t.mail.ai.scheduleEmailTime}</p>
                      <p className="text-xs text-muted-foreground">{t.mail.ai.scheduleEmailTimeDescription}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Info className="h-5 w-5 text-blue-500 dark:text-blue-400 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium">{t.mail.ai.enableSmartFilters}</p>
                      <p className="text-xs text-muted-foreground">{t.mail.ai.enableSmartFiltersDescription}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-yellow-500 dark:text-yellow-400 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium">{t.mail.ai.clearOldEmails}</p>
                      <p className="text-xs text-muted-foreground">{t.mail.ai.clearOldEmailsDescription}</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
