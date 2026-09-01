/**
 * WeldDesk voice agents — Telnyx AI Assistants for inbound phone.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Plus, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { Link } from '@/lib/router';

export interface DeskVoiceAgent {
  id: string;
  name: string;
  systemPrompt: string;
  greeting: string | null;
  telnyxAssistantId: string | null;
  enabled: boolean;
  forwardToE164: string | null;
  model: string | null;
  voice: string | null;
}

const emptyForm = {
  name: '',
  systemPrompt:
    'You are a helpful phone support agent. Be concise and professional. If the caller needs a human, transfer them.',
  greeting: 'Hi, thanks for calling. How can I help you today?',
  enabled: true,
  forwardToE164: '',
};

export default function VoiceAgentsPage() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<DeskVoiceAgent | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data: agents = [], isLoading } = useQuery({
    queryKey: ['desk', 'phone', 'agents'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: DeskVoiceAgent[] }>('/desk/phone/agents');
      return res.data ?? [];
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const client = await getClient();
      const payload = {
        name: form.name.trim(),
        systemPrompt: form.systemPrompt.trim(),
        greeting: form.greeting.trim() || null,
        enabled: form.enabled,
        forwardToE164: form.forwardToE164.trim() || null,
      };
      if (editing) {
        return client.patch<{ data: DeskVoiceAgent }>(`/desk/phone/agents/${editing.id}`, payload);
      }
      return client.post<{ data: DeskVoiceAgent }>('/desk/phone/agents', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['desk', 'phone', 'agents'] });
      setOpen(false);
      setEditing(null);
      setForm(emptyForm);
      toast.success(editing ? 'Voice agent updated' : 'Voice agent created');
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to save voice agent'),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete(`/desk/phone/agents/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['desk', 'phone', 'agents'] });
      toast.success('Voice agent deleted');
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete'),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setOpen(true);
  };

  const openEdit = (agent: DeskVoiceAgent) => {
    setEditing(agent);
    setForm({
      name: agent.name,
      systemPrompt: agent.systemPrompt,
      greeting: agent.greeting ?? '',
      enabled: agent.enabled,
      forwardToE164: agent.forwardToE164 ?? '',
    });
    setOpen(true);
  };

  return (
    <div className="h-full overflow-auto bg-background p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Voice agents</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Telnyx AI assistants that answer inbound WeldDesk phone calls. Configure transfer
              numbers so callers can reach a human.
            </p>
          </div>
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            New agent
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">
          Assign agents to numbers under{' '}
          <Link href="/welddesk/settings/phone" className="underline underline-offset-2">
            Phone settings
          </Link>
          .
        </p>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : agents.length === 0 ? (
          <Card className="border-dashed">
            <CardHeader className="text-center">
              <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Phone className="h-6 w-6" />
              </div>
              <CardTitle>No voice agents yet</CardTitle>
              <CardDescription>
                Create an AI agent, then route a phone number to it for inbound calls.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="space-y-3">
            {agents.map((agent) => (
              <Card key={agent.id}>
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                  <div>
                    <CardTitle className="text-base">{agent.name}</CardTitle>
                    <CardDescription className="mt-1">
                      {agent.enabled ? 'Enabled' : 'Disabled'}
                      {agent.forwardToE164 ? ` · Transfer to ${agent.forwardToE164}` : ''}
                      {agent.telnyxAssistantId ? ' · Synced to Telnyx' : ' · Not synced'}
                    </CardDescription>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => openEdit(agent)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteMutation.mutate(agent.id)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="line-clamp-2 text-sm text-muted-foreground">{agent.systemPrompt}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit voice agent' : 'New voice agent'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="va-name">Name</Label>
              <Input
                id="va-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Support AI"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="va-greeting">Greeting</Label>
              <Input
                id="va-greeting"
                value={form.greeting}
                onChange={(e) => setForm((f) => ({ ...f, greeting: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="va-prompt">System prompt</Label>
              <Textarea
                id="va-prompt"
                rows={5}
                value={form.systemPrompt}
                onChange={(e) => setForm((f) => ({ ...f, systemPrompt: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="va-forward">Transfer to (E.164)</Label>
              <Input
                id="va-forward"
                value={form.forwardToE164}
                onChange={(e) => setForm((f) => ({ ...f, forwardToE164: e.target.value }))}
                placeholder="+15551234567"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="va-enabled">Enabled</Label>
              <Switch
                id="va-enabled"
                checked={form.enabled}
                onCheckedChange={(enabled) => setForm((f) => ({ ...f, enabled }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!form.name.trim() || !form.systemPrompt.trim() || saveMutation.isPending}
            >
              {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
