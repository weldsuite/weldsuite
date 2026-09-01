/**
 * WeldDesk phone settings — per-number inbound routing.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Phone, Settings } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@weldsuite/ui/components/card';
import { toast } from 'sonner';
import { Link } from '@/lib/router';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { DeskVoiceAgent } from '@/app/welddesk/ai-agents/page';

interface VoipPhoneNumber {
  id: string;
  phoneNumber: string;
  displayName: string | null;
  status: string;
}

interface DeskPhoneRoute {
  id: string;
  voipPhoneNumberId: string;
  action: 'ai_agent' | 'forward' | 'hangup';
  voiceAgentId: string | null;
  forwardToE164: string | null;
}

export function PhoneSettingsClient() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<
    Record<string, { action: DeskPhoneRoute['action']; voiceAgentId: string; forwardToE164: string }>
  >({});

  const { data: numbers = [], isLoading: loadingNumbers } = useQuery({
    queryKey: ['phone-numbers', 'list'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: VoipPhoneNumber[] }>('/call-intelligence/phone-numbers');
      return res.data ?? [];
    },
  });

  const { data: agents = [] } = useQuery({
    queryKey: ['desk', 'phone', 'agents'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskVoiceAgent[] }>('/desk/phone/agents');
      return res.data ?? [];
    },
  });

  const { data: routes = [], isLoading: loadingRoutes } = useQuery({
    queryKey: ['desk', 'phone', 'routes'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskPhoneRoute[] }>('/desk/phone/routes');
      return res.data ?? [];
    },
  });

  const routeByNumber = useMemo(() => {
    const map = new Map<string, DeskPhoneRoute>();
    for (const r of routes) map.set(r.voipPhoneNumberId, r);
    return map;
  }, [routes]);

  const getDraft = (numberId: string) => {
    if (drafts[numberId]) return drafts[numberId];
    const route = routeByNumber.get(numberId);
    return {
      action: route?.action ?? ('hangup' as const),
      voiceAgentId: route?.voiceAgentId ?? '',
      forwardToE164: route?.forwardToE164 ?? '',
    };
  };

  const setDraft = (
    numberId: string,
    patch: Partial<{ action: DeskPhoneRoute['action']; voiceAgentId: string; forwardToE164: string }>,
  ) => {
    setDrafts((prev) => ({
      ...prev,
      [numberId]: { ...getDraft(numberId), ...patch },
    }));
  };

  const saveMutation = useMutation({
    mutationFn: async (numberId: string) => {
      const draft = getDraft(numberId);
      const client = await getClient();
      return client.put<{ data: DeskPhoneRoute }>('/desk/phone/routes', {
        voipPhoneNumberId: numberId,
        action: draft.action,
        voiceAgentId: draft.action === 'ai_agent' ? draft.voiceAgentId || null : null,
        forwardToE164: draft.action === 'forward' ? draft.forwardToE164 || null : null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['desk', 'phone', 'routes'] });
      toast.success('Route saved');
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to save route'),
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.post<{ data: { count: number } }>('/telephony/phone-numbers/sync', {});
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['phone-numbers', 'list'] });
      toast.success(`Synced ${res.data?.count ?? 0} number(s)`);
    },
    onError: (err: Error) => toast.error(err.message || 'Sync failed'),
  });

  return (
    <div className="h-full overflow-auto bg-background p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Phone</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Route inbound calls to an AI voice agent, forward to a number, or hang up.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link href="/welddesk/ai-agents">Voice agents</Link>
            </Button>
            <Button variant="outline" onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending}>
              {syncMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Sync numbers
            </Button>
          </div>
        </div>

        {loadingNumbers || loadingRoutes ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : numbers.length === 0 ? (
          <Card className="border-dashed">
            <CardHeader className="text-center">
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Phone className="h-6 w-6" />
              </div>
              <CardTitle>No phone numbers</CardTitle>
              <CardDescription>
                Provision numbers in{' '}
                <Link href="/settings/apps/phone-numbers" className="underline underline-offset-2">
                  Phone Numbers
                </Link>
                , then sync them here for inbound routing.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="space-y-4">
            {numbers.map((num) => {
              const draft = getDraft(num.id);
              return (
                <Card key={num.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-center gap-2">
                      <Settings className="h-4 w-4 text-muted-foreground" />
                      <CardTitle className="text-base">
                        {num.displayName || num.phoneNumber}
                      </CardTitle>
                    </div>
                    <CardDescription>{num.phoneNumber}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label>Inbound action</Label>
                      <Select
                        value={draft.action}
                        onValueChange={(v) =>
                          setDraft(num.id, { action: v as DeskPhoneRoute['action'] })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ai_agent">AI voice agent</SelectItem>
                          <SelectItem value="forward">Forward to number</SelectItem>
                          <SelectItem value="hangup">Hang up</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {draft.action === 'ai_agent' && (
                      <div className="space-y-2">
                        <Label>Voice agent</Label>
                        <Select
                          value={draft.voiceAgentId || undefined}
                          onValueChange={(v) => setDraft(num.id, { voiceAgentId: v })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select agent" />
                          </SelectTrigger>
                          <SelectContent>
                            {agents.map((a) => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {draft.action === 'forward' && (
                      <div className="space-y-2">
                        <Label>Forward to (E.164)</Label>
                        <Input
                          value={draft.forwardToE164}
                          onChange={(e) => setDraft(num.id, { forwardToE164: e.target.value })}
                          placeholder="+15551234567"
                        />
                      </div>
                    )}

                    <Button
                      size="sm"
                      onClick={() => saveMutation.mutate(num.id)}
                      disabled={saveMutation.isPending}
                    >
                      {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Save route
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PhoneSettingsPage() {
  return <PhoneSettingsClient />;
}
