/**
 * Create / edit one team in a side sheet: name, description, members,
 * manager, active, order and the escalation rules the SLA sweep runs.
 */

import { useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { MultiSelect } from '@weldsuite/ui/components/multi-select';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { getTranslations } from '@/lib/i18n';
import {
  useCreateDeskTeam,
  useUpdateDeskTeam,
  type DeskEscalationCondition,
  type DeskEscalationTarget,
  type DeskTeam,
  type DeskTeamMember,
} from '@/hooks/queries/use-desk-routing-queries';
import {
  ESCALATION_CONDITIONS,
  ESCALATION_TARGETS,
  emptyTeamValues,
  newEscalationRule,
  teamToValues,
  validateTeamValues,
  valuesToTeamInput,
  type EscalationRuleValues,
  type TeamFormError,
  type TeamFormValues,
} from './team-form';

type Strings = ReturnType<typeof getTranslations<'helpdesk'>>['teamsSettings'];
type EscalationStrings = ReturnType<typeof getTranslations<'helpdesk'>>['escalation'];

export interface TeamEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The team to edit; null creates one. */
  team: DeskTeam | null;
  /** Every team, to suggest the next order. */
  teams: DeskTeam[];
  members: DeskTeamMember[];
}

export function TeamEditor({ open, onOpenChange, team, teams, members }: Readonly<TeamEditorProps>) {
  const i18n = getTranslations('helpdesk');
  const t = i18n.teamsSettings;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" data-testid="team-editor">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>{team ? t.editor.editTitle : t.editor.createTitle}</SheetTitle>
          <SheetDescription>{t.editor.description}</SheetDescription>
        </SheetHeader>
        {open && (
          <TeamForm
            key={team?.id ?? 'new'}
            team={team}
            teams={teams}
            members={members}
            onClose={() => onOpenChange(false)}
            t={t}
            te={i18n.escalation}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

const NONE = '__none__';

function TeamForm({
  team,
  teams,
  members,
  onClose,
  t,
  te,
}: Readonly<{
  team: DeskTeam | null;
  teams: DeskTeam[];
  members: DeskTeamMember[];
  onClose: () => void;
  t: Strings;
  te: EscalationStrings;
}>) {
  const createTeam = useCreateDeskTeam();
  const updateTeam = useUpdateDeskTeam();
  const [values, setValues] = useState<TeamFormValues>(() =>
    team ? teamToValues(team, members) : emptyTeamValues(Math.max(0, ...teams.map((x) => x.sortOrder)) + 1),
  );
  const [error, setError] = useState<TeamFormError | null>(null);
  const set = <K extends keyof TeamFormValues>(key: K, value: TeamFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const setRule = (index: number, patch: Partial<EscalationRuleValues>) =>
    set(
      'escalationRules',
      values.escalationRules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    );

  const memberOptions = members.map((m) => ({ value: m.userId, label: m.name }));
  const saving = createTeam.isPending || updateTeam.isPending;

  const submit = async () => {
    const problem = validateTeamValues(values);
    setError(problem);
    if (problem) return;
    const payload = valuesToTeamInput(values, members);
    try {
      if (team) {
        await updateTeam.mutateAsync({ id: team.id, ...payload });
        toast.success(t.toast.updated);
      } else {
        await createTeam.mutateAsync(payload);
        toast.success(t.toast.created);
      }
      onClose();
    } catch {
      toast.error(t.toast.saveFailed);
    }
  };

  const ruleError = (index: number, field: 'afterMinutes' | 'escalateToId') =>
    error?.field === field && 'index' in error && error.index === index;

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      data-testid="team-form"
    >
      <div className="flex-1 space-y-8 overflow-y-auto px-6 py-6">
        <section className="space-y-4">
          <Field label={t.editor.name} htmlFor="team-name">
            <Input
              id="team-name"
              value={values.name}
              maxLength={255}
              placeholder={t.editor.namePlaceholder}
              onChange={(e) => set('name', e.target.value)}
              aria-invalid={error?.field === 'name'}
            />
            {error?.field === 'name' && <p className="text-sm text-destructive">{t.editor.nameRequired}</p>}
          </Field>
          <Field label={t.editor.descriptionLabel} htmlFor="team-description">
            <Textarea
              id="team-description"
              rows={2}
              value={values.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>
          <Field label={t.editor.members} hint={t.editor.membersHint}>
            <MultiSelect
              aria-label={t.editor.members}
              options={memberOptions}
              value={values.agentIds}
              onChange={(v) => set('agentIds', v)}
              placeholder={t.editor.membersPlaceholder}
              modal
            />
          </Field>
          <Field label={t.editor.manager} hint={t.editor.managerHint}>
            <Select
              value={values.managerMemberId ?? NONE}
              onValueChange={(v) => set('managerMemberId', v === NONE ? null : v)}
            >
              <SelectTrigger aria-label={t.editor.manager}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t.editor.managerNone}</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.memberId} value={m.memberId}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="team-active">{t.editor.active}</Label>
              <p className="text-sm text-muted-foreground">{t.editor.activeHint}</p>
            </div>
            <Switch id="team-active" checked={values.isActive} onCheckedChange={(on) => set('isActive', on)} />
          </div>
          <Field label={t.editor.sortOrder} hint={t.editor.sortOrderHint} htmlFor="team-order">
            <Input
              id="team-order"
              inputMode="numeric"
              className="w-28"
              value={values.sortOrder}
              onChange={(e) => set('sortOrder', e.target.value)}
              aria-invalid={error?.field === 'sortOrder'}
            />
            {error?.field === 'sortOrder' && <p className="text-sm text-destructive">{t.editor.sortOrderInvalid}</p>}
          </Field>
        </section>

        <section className="space-y-4" data-testid="team-escalation-rules">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="font-medium">{te.title}</h3>
              <p className="text-sm text-muted-foreground">{te.hint}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => set('escalationRules', [...values.escalationRules, newEscalationRule()])}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {te.add}
            </Button>
          </div>
          {values.escalationRules.length === 0 && <p className="text-sm text-muted-foreground">{te.empty}</p>}
          {values.escalationRules.map((rule, index) => (
            // Rules have no id of their own; their place in the list is what the timeline records.
            <div key={index} className="space-y-3 rounded-lg border p-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <Field label={te.condition}>
                  <Select value={rule.condition} onValueChange={(v) => setRule(index, { condition: v as DeskEscalationCondition })}>
                    <SelectTrigger aria-label={te.condition}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ESCALATION_CONDITIONS.map((condition) => (
                        <SelectItem key={condition} value={condition}>
                          {te.conditions[condition]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={te.after}>
                  <div className="flex items-center gap-2">
                    <NumberInput
                      aria-label={te.after}
                      className="w-24"
                      min={0}
                      value={rule.afterMinutes === '' ? undefined : Number(rule.afterMinutes)}
                      onValueChange={(n) => setRule(index, { afterMinutes: n === undefined ? '' : String(n) })}
                    />
                    <span className="text-sm text-muted-foreground">{te.minutes}</span>
                  </div>
                </Field>
              </div>
              {ruleError(index, 'afterMinutes') && <p className="text-sm text-destructive">{te.afterInvalid}</p>}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={te.escalateTo}>
                  <Select value={rule.escalateTo} onValueChange={(v) => setRule(index, { escalateTo: v as DeskEscalationTarget })}>
                    <SelectTrigger aria-label={te.escalateTo}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ESCALATION_TARGETS.map((target) => (
                        <SelectItem key={target} value={target}>
                          {te.targets[target]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {rule.escalateTo === 'specific_agent' && (
                  <Field label={te.agent}>
                    <Select value={rule.escalateToId ?? undefined} onValueChange={(v) => setRule(index, { escalateToId: v })}>
                      <SelectTrigger aria-label={te.agent}>
                        <SelectValue placeholder={te.agentPlaceholder} />
                      </SelectTrigger>
                      <SelectContent>
                        {members.map((m) => (
                          <SelectItem key={m.userId} value={m.userId}>
                            {m.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {ruleError(index, 'escalateToId') && <p className="text-sm text-destructive">{te.agentRequired}</p>}
                  </Field>
                )}
              </div>
              {rule.escalateTo === 'manager' && !values.managerMemberId && (
                <p className="text-sm text-amber-600 dark:text-amber-400">{te.managerMissing}</p>
              )}
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`team-rule-notify-${index}`}
                    checked={rule.notifyCustomer}
                    onCheckedChange={(on) => setRule(index, { notifyCustomer: on === true })}
                  />
                  <Label htmlFor={`team-rule-notify-${index}`}>{te.notifyCustomer}</Label>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={te.remove}
                  onClick={() => set('escalationRules', values.escalationRules.filter((_, i) => i !== index))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </section>
      </div>
      <SheetFooter className="border-t px-6 py-4">
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          {t.editor.cancel}
        </Button>
        <Button type="submit" disabled={saving} data-testid="team-save">
          {t.editor.save}
        </Button>
      </SheetFooter>
    </form>
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: Readonly<{ label: string; hint?: string; htmlFor?: string; children: ReactNode }>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}
