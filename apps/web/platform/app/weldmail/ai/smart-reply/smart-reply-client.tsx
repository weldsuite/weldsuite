
import { useState, useTransition } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  Zap,
  RefreshCw,
  Copy,
  Check,
  Brain,
  Clock,
  Target,
  Sparkles,
  MessageSquare,
  TrendingUp,
  Mail
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Progress } from '@weldsuite/ui/components/progress';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useSmartReplies } from '@/hooks/queries/use-mail-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useAiCreditsToast } from '@/hooks/use-ai-credits-toast';

interface Email {
  id: string;
  from: string;
  subject: string;
  preview: string;
  date: Date;
}

interface SuggestedReply {
  tone: string;
  text: string;
  confidence: number;
  intent: string;
}

interface Stats {
  repliesSent: number;
  timeSaved: string;
  responseRate: string;
  accuracy: string;
}

interface SmartReplyClientProps {
  emails: Email[];
  suggestedReplies: SuggestedReply[];
  stats: Stats;
}

export function SmartReplyClient({ emails, suggestedReplies: initialReplies, stats }: SmartReplyClientProps) {
  const { t } = useI18n();
  const smartRepliesMutation = useSmartReplies();
  const handleAiCreditsError = useAiCreditsToast();

  // Set breadcrumbs for AI Smart Reply
  useBreadcrumbs([
    { label: t.mail.header.mail, href: '/weldmail' },
    { label: t.mail.header.ai, href: '/weldmail/ai' },
    { label: t.mail.header.smartReply }
  ]);

  const [selectedEmail, setSelectedEmail] = useState(emails[0]);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [, startTransition] = useTransition();
  const [selectedTone, setSelectedTone] = useState('professional');
  const [suggestedReplies, setSuggestedReplies] = useState<SuggestedReply[]>(initialReplies);

  const isPending = smartRepliesMutation.isPending;

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    toast.success(t.mail.ai.replyCopied);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleSelectEmail = (email: Email) => {
    setSelectedEmail(email);
    // Generate replies for the selected email
    if (email.id !== 'sample-1') {
      handleGenerate(email.id);
    }
  };

  const handleGenerate = (messageId?: string) => {
    const id = messageId ?? selectedEmail?.id;
    if (!id || id === 'sample-1') {
      toast.error(t.mail.ai.selectValidEmail);
      return;
    }

    startTransition(() => {
      smartRepliesMutation.mutate(
        { messageId: id },
        {
          onSuccess: (result) => {
            if (result.success && result.data?.replies) {
              // The hook returns { success, data: { replies: string[] } }.
              // Map the plain strings into the SuggestedReply shape the UI expects.
              const tones = [t.mail.ai.professional, t.mail.ai.friendly, t.mail.ai.brief];
              const mapped: SuggestedReply[] = result.data.replies.slice(0, 3).map((text, i) => ({
                tone: tones[i] ?? tones[0],
                text,
                confidence: 85,
                intent: t.mail.ai.waiting,
              }));
              setSuggestedReplies(mapped);
              toast.success(t.mail.ai.repliesGenerated);
            } else {
              toast.error(t.mail.ai.failedToGenerate);
            }
          },
          onError: (err) => {
            if (!handleAiCreditsError(err)) toast.error(t.mail.ai.failedToGenerate);
          },
        },
      );
    });
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Zap className="h-6 w-6 text-primary" />
              {t.mail.ai.smartReply}
            </h1>
            <p className="text-muted-foreground mt-1">
              {t.mail.ai.smartReplySubtitle}
            </p>
          </div>
          <Button onClick={() => handleGenerate()} disabled={isPending}>
            {isPending ? (
              <>
                <RefreshCw className="h-4 w-4 mr-0.5 animate-spin" />
                {t.mail.ai.generating}
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4 mr-0.5" />
                {t.mail.ai.generateNew}
              </>
            )}
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{t.mail.ai.repliesSent}</p>
                  <p className="text-2xl font-bold">{stats.repliesSent}</p>
                </div>
                <MessageSquare className="h-8 w-8 text-primary opacity-20" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{t.mail.ai.timeSaved}</p>
                  <p className="text-2xl font-bold">{stats.timeSaved}</p>
                </div>
                <Clock className="h-8 w-8 text-primary opacity-20" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{t.mail.ai.responseRate}</p>
                  <p className="text-2xl font-bold">{stats.responseRate}</p>
                </div>
                <TrendingUp className="h-8 w-8 text-primary opacity-20" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{t.mail.ai.accuracy}</p>
                  <p className="text-2xl font-bold">{stats.accuracy}</p>
                </div>
                <Target className="h-8 w-8 text-primary opacity-20" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Email Selection */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle>{t.mail.ai.selectEmail}</CardTitle>
              <CardDescription>{t.mail.ai.chooseEmailToGenerate}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {emails.map((email) => (
                  <div
                    key={email.id}
                    className={cn(
                      "p-3 rounded-lg border cursor-pointer transition-colors",
                      selectedEmail?.id === email.id
                        ? "bg-primary/10 border-primary"
                        : "hover:bg-accent"
                    )}
                    onClick={() => handleSelectEmail(email)}
                  >
                    <div className="flex items-start gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback>{email.from[0]?.toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">{email.from}</span>
                          <span className="text-xs text-muted-foreground">
                            {new Date(email.date).toLocaleDateString()}
                          </span>
                        </div>
                        <p className="text-sm font-medium mt-1">{email.subject}</p>
                        <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                          {email.preview}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Original Email Preview */}
          {selectedEmail && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle className="text-base">{t.mail.ai.emailContent}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div>
                    <p className="text-sm text-muted-foreground">{t.mail.ai.from}</p>
                    <p className="text-sm">{selectedEmail.from}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t.mail.compose.subject}</p>
                    <p className="text-sm font-medium">{selectedEmail.subject}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">{t.mail.compose.message}</p>
                    <p className="text-sm mt-2">{selectedEmail.preview}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Smart Replies */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle>{t.mail.ai.suggestedReplies}</CardTitle>
              <CardDescription>{t.mail.ai.aiGeneratedResponses}</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs value={selectedTone} onValueChange={setSelectedTone}>
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="professional">{t.mail.ai.professional}</TabsTrigger>
                  <TabsTrigger value="friendly">{t.mail.ai.friendly}</TabsTrigger>
                  <TabsTrigger value="brief">{t.mail.ai.brief}</TabsTrigger>
                </TabsList>

                <div className="mt-4 space-y-4">
                  {suggestedReplies.map((reply, index) => (
                    <TabsContent
                      key={index}
                      value={reply.tone.toLowerCase()}
                      className="mt-0"
                    >
                      <Card>
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline">{reply.intent}</Badge>
                              <div className="flex items-center gap-1">
                                <Brain className="h-3 w-3 text-muted-foreground" />
                                <span className="text-xs text-muted-foreground">
                                  {reply.confidence}{t.mail.ai.confidence}
                                </span>
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleCopy(reply.text, index)}
                            >
                              {copiedIndex === index ? (
                                <Check className="h-4 w-4 text-green-500 dark:text-green-400" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                          <p className="text-sm leading-relaxed">{reply.text}</p>
                          <div className="flex items-center gap-2 mt-4">
                            <Button size="sm" className="flex-1">
                              <Mail className="h-4 w-4 mr-0.5" />
                              {t.mail.ai.useReply}
                            </Button>
                            <Button size="sm" variant="outline">
                              <Sparkles className="h-4 w-4 mr-0.5" />
                              {t.mail.ai.customize}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    </TabsContent>
                  ))}
                </div>
              </Tabs>

              {/* Learning Progress */}
              <div className="mt-6 p-4 bg-muted/50 dark:bg-muted/30 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">{t.mail.ai.aiLearningProgress}</span>
                  <span className="text-sm text-muted-foreground">87%</span>
                </div>
                <Progress value={87} className="h-2" />
                <p className="text-xs text-muted-foreground mt-2">
                  {t.mail.ai.aiLearningDescription}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
