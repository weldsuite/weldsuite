'use client';

import { useEffect, useState } from 'react';
import { BookOpen, Clock, Brain, ShieldCheck, Share2, Monitor, GraduationCap } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Badge } from '@weldsuite/ui/components/badge';
import { useAppApi } from '@/lib/api/use-app-api';

interface AgentParityPanelsProps {
  agentId: string;
}

export function AgentParityPanels({ agentId }: AgentParityPanelsProps) {
  const { weldAgentParity } = useAppApi();
  const [skills, setSkills] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [routines, setRoutines] = useState<Array<{ id: string; name: string; enabled: boolean; nextRunAt: string | null }>>([]);
  const [memories, setMemories] = useState<Array<{ id: string; kind: string; content: string }>>([]);
  const [approvals, setApprovals] = useState<Array<{ id: string; toolName: string; status: string }>>([]);
  const [files, setFiles] = useState<unknown>(null);
  const [liveViewUrl, setLiveViewUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [skillName, setSkillName] = useState('');
  const [skillInstructions, setSkillInstructions] = useState('');
  const [routineName, setRoutineName] = useState('');
  const [routineInstructions, setRoutineInstructions] = useState('');
  const [memoryContent, setMemoryContent] = useState('');
  const [teachTitle, setTeachTitle] = useState('Taught browser workflow');
  const [shareToken, setShareToken] = useState<string | null>(null);

  const refresh = async () => {
    const [s, r, m, a, f] = await Promise.all([
      weldAgentParity.listAgentSkills(agentId),
      weldAgentParity.listRoutines(agentId),
      weldAgentParity.listMemories(agentId),
      weldAgentParity.listApprovals({ agentId, status: 'pending' }),
      weldAgentParity.listComputerFiles(agentId, '/workspace'),
    ]);
    setSkills((s.data as typeof skills) ?? []);
    setRoutines((r.data as typeof routines) ?? []);
    setMemories((m.data as typeof memories) ?? []);
    setApprovals((a.data as typeof approvals) ?? []);
    setFiles(f.data);
  };

  useEffect(() => {
    void refresh().catch((err) => setMessage(err instanceof Error ? err.message : 'Failed to load'));
  }, [agentId]);

  return (
    <div className="space-y-6">
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}

      <section className="space-y-3 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4" />
          <h3 className="text-sm font-medium">Skills</h3>
        </div>
        <div className="space-y-2">
          {skills.map((s) => (
            <div key={s.id} className="flex items-center justify-between text-sm">
              <span>{s.name}</span>
              <Badge variant="secondary">{s.status}</Badge>
            </div>
          ))}
        </div>
        <Input placeholder="Skill name" value={skillName} onChange={(e) => setSkillName(e.target.value)} />
        <Textarea
          placeholder="Instructions (steps, rules, approvals)"
          value={skillInstructions}
          onChange={(e) => setSkillInstructions(e.target.value)}
          rows={3}
        />
        <Button
          size="sm"
          onClick={async () => {
            const created = await weldAgentParity.createSkill({
              name: skillName,
              instructions: skillInstructions,
              status: 'active',
            });
            const id = (created.data as { id: string }).id;
            await weldAgentParity.enableSkill(agentId, id);
            setSkillName('');
            setSkillInstructions('');
            await refresh();
            setMessage('Skill saved and enabled');
          }}
        >
          Save skill
        </Button>
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <GraduationCap className="h-4 w-4" />
          <h3 className="text-sm font-medium">Teach by demonstration</h3>
        </div>
        <Input value={teachTitle} onChange={(e) => setTeachTitle(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const session = await weldAgentParity.startTeach(agentId, teachTitle);
              const id = (session.data as { id: string }).id;
              await weldAgentParity.appendTeachStep(id, { action: 'note', text: 'Recording started from Configure' });
              const stopped = await weldAgentParity.stopTeach(id, { createSkill: true, skillName: teachTitle });
              setMessage(`Teach session saved as skill ${(stopped.data as { skillId?: string }).skillId ?? ''}`);
              await refresh();
            }}
          >
            Capture draft skill
          </Button>
        </div>
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4" />
          <h3 className="text-sm font-medium">Routines</h3>
        </div>
        {routines.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
            <div>
              <div>{r.name}</div>
              <div className="text-xs text-muted-foreground">Next: {r.nextRunAt ?? '—'}</div>
            </div>
            <div className="flex gap-2">
              <Badge variant={r.enabled ? 'default' : 'secondary'}>{r.enabled ? 'on' : 'paused'}</Badge>
              <Button size="sm" variant="outline" onClick={() => void weldAgentParity.testRoutine(r.id).then(() => setMessage('Test run started'))}>
                Test
              </Button>
            </div>
          </div>
        ))}
        <Input placeholder="Routine name" value={routineName} onChange={(e) => setRoutineName(e.target.value)} />
        <Textarea
          placeholder="What should run every hour?"
          value={routineInstructions}
          onChange={(e) => setRoutineInstructions(e.target.value)}
          rows={3}
        />
        <Button
          size="sm"
          onClick={async () => {
            await weldAgentParity.createRoutine({
              agentId,
              name: routineName,
              instructions: routineInstructions,
              scheduleKind: 'cron',
              cronExpr: '0 * * * *',
              requireApproval: true,
            });
            setRoutineName('');
            setRoutineInstructions('');
            await refresh();
            setMessage('Hourly routine created');
          }}
        >
          Create hourly routine
        </Button>
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          <h3 className="text-sm font-medium">Approvals</h3>
        </div>
        {approvals.length === 0 ? (
          <p className="text-xs text-muted-foreground">No pending approvals</p>
        ) : (
          approvals.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 text-sm">
              <span>{a.toolName}</span>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void weldAgentParity.decideApproval(a.id, { decision: 'approved' }).then(refresh)}>
                  Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => void weldAgentParity.decideApproval(a.id, { decision: 'rejected' }).then(refresh)}>
                  Reject
                </Button>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4" />
          <h3 className="text-sm font-medium">Memory</h3>
        </div>
        {memories.map((m) => (
          <div key={m.id} className="text-sm">
            <Badge variant="outline" className="mr-2">{m.kind}</Badge>
            {m.content}
          </div>
        ))}
        <Textarea placeholder="Preference or fact" value={memoryContent} onChange={(e) => setMemoryContent(e.target.value)} rows={2} />
        <Button
          size="sm"
          onClick={async () => {
            await weldAgentParity.createMemory({ agentId, kind: 'preference', content: memoryContent });
            setMemoryContent('');
            await refresh();
          }}
        >
          Save memory
        </Button>
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Share2 className="h-4 w-4" />
          <h3 className="text-sm font-medium">Template / share</h3>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            const tpl = await weldAgentParity.exportTemplate({ agentId, isPublic: false });
            setShareToken((tpl.data as { shareToken?: string }).shareToken ?? null);
            setMessage('Template exported');
          }}
        >
          Export template
        </Button>
        {shareToken ? <p className="text-xs font-mono break-all">Share token: {shareToken}</p> : null}
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4" />
          <h3 className="text-sm font-medium">Cloud computer</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const res = await weldAgentParity.liveView(agentId);
              setLiveViewUrl((res.data as { liveViewUrl?: string }).liveViewUrl ?? null);
            }}
          >
            Open live view
          </Button>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Refresh files
          </Button>
        </div>
        {liveViewUrl ? (
          <iframe title="Agent live view" src={liveViewUrl} className="h-64 w-full rounded-lg border bg-black" />
        ) : null}
        <pre className="max-h-40 overflow-auto rounded-lg bg-muted/40 p-2 text-[11px]">
          {JSON.stringify(files, null, 2)}
        </pre>
      </section>
    </div>
  );
}
