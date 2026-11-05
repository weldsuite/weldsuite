import { useEffect, useMemo, useState } from 'react';
import { useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { useAllTeamMembers } from '@/hooks/queries/use-team-queries';
import { CrmPersonSelect } from '@/components/objects/person/crm-person-select';
import {
  useCommunicationPlan,
  useCreateStakeholder,
  useDeleteStakeholder,
  useInviteToPortal,
  usePutCommunicationPlan,
  usePutRaci,
  useRaci,
  useRevokePortalAccess,
  useStakeholders,
  useUpdateStakeholder,
} from '@/hooks/queries/use-project-reporting-queries';
import type { CommunicationPlanEntry, RaciLetter, RaciSubject, Stakeholder } from '@weldsuite/app-api-client/domains/project-reporting';

const BTN = 'inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50';
const PRIMARY = 'inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50';
const INPUT = 'h-8 rounded-md border bg-background px-2 text-sm';
const CARD = 'rounded-lg border bg-card p-4';
const LETTERS: Array<RaciLetter | ''> = ['', 'R', 'A', 'C', 'I'];

function initials(name: string | null): string {
  return (name ?? '?').split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
}

/** Governance > Stakeholders: register, power/interest grid, RACI, communication plan and portal access. */
export default function StakeholdersPage() {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders;
  const projectId = useParams().projectId as string;
  const { canWrite, isAdmin } = useProjectPermissions();
  const query = useStakeholders(projectId);
  const [side, setSide] = useState<'all' | 'internal' | 'client'>('all');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Stakeholder | null>(null);
  const all = useMemo(() => query.data ?? [], [query.data]);
  const visible = all.filter((row) => (side === 'all' || (side === 'internal') === (row.kind === 'member')) && (row.name ?? '').toLowerCase().includes(search.toLowerCase()));

  if (query.isError) return <p className="py-8 text-center text-sm text-destructive">{copy.error}</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <input type="search" aria-label={copy.search} placeholder={copy.search} className={`${INPUT} min-w-60`} value={search} onChange={(event) => setSearch(event.target.value)} />
        <div role="group" className="inline-flex rounded-md bg-muted p-0.5">
          {(['all', 'internal', 'client'] as const).map((value) => (
            <button key={value} type="button" aria-pressed={side === value} onClick={() => setSide(value)} className={`rounded px-3 py-1 text-xs ${side === value ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground'}`}>
              {copy[value]}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {canWrite ? (
          <button type="button" className={PRIMARY} onClick={() => setAdding(true)}>
            {copy.add}
          </button>
        ) : null}
      </div>

      {adding ? <AddForm projectId={projectId} existing={all} onDone={() => setAdding(false)} /> : null}
      {editing ? <EditForm key={editing.id} row={editing} canManage={canWrite && isAdmin} canWrite={canWrite} onDone={() => setEditing(null)} /> : null}

      <section className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b p-3">
          <h2 className="text-sm font-semibold">{copy.title}</h2>
          <p className="text-xs text-muted-foreground">{copy.subtitle}</p>
        </div>
        {query.isLoading ? <p className="p-4 text-sm text-muted-foreground">...</p> : null}
        {!query.isLoading && visible.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{copy.empty}</p> : null}
        {visible.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  {Object.values(copy.columns).map((label) => (
                    <th key={label} className="p-3 font-medium">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.id} className="cursor-pointer border-t hover:bg-muted/50" onClick={() => setEditing(row)}>
                    <td className="p-3 font-medium">{row.name ?? '?'}</td>
                    <td className="p-3">{row.role ?? ''}<div className="text-xs text-muted-foreground">{row.organisation ?? ''}</div></td>
                    <td className="p-3">{row.influence}/5</td>
                    <td className="p-3">{row.interest}/5</td>
                    <td className="p-3">{copy.attitudes[row.attitude]}</td>
                    <td className="p-3">{copy.engagements[row.engagement]}</td>
                    <td className="p-3 text-muted-foreground">{row.lastContactAt ? new Date(row.lastContactAt).toLocaleDateString() : '-'}</td>
                    <td className="p-3">{portalLabel(row, copy.portalStates)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(380px,1fr))]">
        <PowerGrid rows={all} onPick={setEditing} />
        <CommunicationPlan projectId={projectId} manage={canWrite && isAdmin} />
      </div>

      <RaciMatrix projectId={projectId} stakeholders={all} canWrite={canWrite} />
    </div>
  );
}

function portalLabel(row: Stakeholder, states: { team: string; yes: string; none: string }): string {
  if (row.kind === 'member') return states.team;
  return row.portalAccess ? states.yes : states.none;
}

function AddForm({ projectId, existing, onDone }: Readonly<{ projectId: string; existing: Stakeholder[]; onDone: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders;
  const members = useAllTeamMembers({ status: 'ACTIVE' });
  const create = useCreateStakeholder();
  const [kind, setKind] = useState<'member' | 'contact'>('member');
  const [memberId, setMemberId] = useState('');
  const [contactId, setContactId] = useState('');
  const [organisation, setOrganisation] = useState('');
  const [role, setRole] = useState('');
  const taken = new Set(existing.flatMap((row) => (row.memberId ? [row.memberId] : [])));
  const takenContacts = useMemo(() => new Set(existing.flatMap((row) => (row.crmContactId ? [row.crmContactId] : []))), [existing]);
  const submit = () =>
    create.mutate(
      { projectId, ...(kind === 'member' ? { memberId } : { crmContactId: contactId }), organisation: organisation || null, role: role || null },
      { onSuccess: onDone },
    );
  return (
    <section className={`${CARD} flex flex-wrap items-end gap-3`}>
      <label className="flex flex-col gap-1 text-xs">
        {copy.add}
        <select className={INPUT} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="member">{copy.form.member}</option>
          <option value="contact">{copy.form.contact}</option>
        </select>
      </label>
      {kind === 'member' ? (
        <label className="flex flex-col gap-1 text-xs">
          {copy.form.member}
          <select className={INPUT} value={memberId} onChange={(event) => setMemberId(event.target.value)}>
            <option value="">{copy.form.choose}</option>
            {(members.data ?? []).filter((member) => !taken.has(member.userId)).map((member) => (
              <option key={member.userId} value={member.userId}>{member.name ?? member.userId}</option>
            ))}
          </select>
        </label>
      ) : (
        <div className="flex flex-col gap-1 text-xs">
          <label htmlFor="stakeholder-contact">{copy.form.contact}</label>
          <CrmPersonSelect
            id="stakeholder-contact"
            value={contactId}
            placeholder={copy.form.choosePerson}
            searchPlaceholder={copy.form.searchPeople}
            excludeIds={takenContacts}
            onChange={(personId, person) => {
              setContactId(personId);
              // Take the job title as the role unless one was typed already.
              if (person?.title && !role.trim()) setRole(person.title);
            }}
          />
        </div>
      )}
      <label className="flex flex-col gap-1 text-xs">
        {copy.form.organisation}
        <input className={INPUT} value={organisation} onChange={(event) => setOrganisation(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        {copy.form.role}
        <input className={INPUT} value={role} onChange={(event) => setRole(event.target.value)} />
      </label>
      <button type="button" className={PRIMARY} disabled={create.isPending || (kind === 'member' ? !memberId : !contactId)} onClick={submit}>
        {copy.form.save}
      </button>
      <button type="button" className={BTN} onClick={onDone}>{copy.form.cancel}</button>
      {create.isError ? <p role="alert" className="w-full text-xs text-destructive">{copy.saveFailed}</p> : null}
    </section>
  );
}

function EditForm({ row, canWrite, canManage, onDone }: Readonly<{ row: Stakeholder; canWrite: boolean; canManage: boolean; onDone: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders;
  const update = useUpdateStakeholder();
  const remove = useDeleteStakeholder();
  const invite = useInviteToPortal();
  const revoke = useRevokePortalAccess();
  const [influence, setInfluence] = useState(row.influence);
  const [interest, setInterest] = useState(row.interest);
  const [attitude, setAttitude] = useState(row.attitude);
  const [engagement, setEngagement] = useState(row.engagement);
  const [organisation, setOrganisation] = useState(row.organisation ?? '');
  const [role, setRole] = useState(row.role ?? '');
  const [notes, setNotes] = useState(row.notes ?? '');
  const scale = [1, 2, 3, 4, 5];
  return (
    <section className={`${CARD} flex flex-col gap-3`} aria-label={row.name ?? ''}>
      <h3 className="text-sm font-semibold">{row.name}</h3>
      <div className="flex flex-wrap gap-3">
        {[[copy.columns.influence, influence, setInfluence], [copy.columns.interest, interest, setInterest]].map(([label, value, set]) => (
          <label key={label as string} className="flex flex-col gap-1 text-xs">
            {label as string}
            <select className={INPUT} disabled={!canWrite} value={value as number} onChange={(event) => (set as (n: number) => void)(Number(event.target.value))}>
              {scale.map((n) => <option key={n} value={n}>{n}/5</option>)}
            </select>
          </label>
        ))}
        <label className="flex flex-col gap-1 text-xs">
          {copy.columns.attitude}
          <select className={INPUT} disabled={!canWrite} value={attitude} onChange={(event) => setAttitude(event.target.value as typeof attitude)}>
            {(Object.keys(copy.attitudes) as Array<keyof typeof copy.attitudes>).map((key) => <option key={key} value={key}>{copy.attitudes[key]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {copy.columns.engagement}
          <select className={INPUT} disabled={!canWrite} value={engagement} onChange={(event) => setEngagement(event.target.value as typeof engagement)}>
            {(Object.keys(copy.engagements) as Array<keyof typeof copy.engagements>).map((key) => <option key={key} value={key}>{copy.engagements[key]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {copy.form.organisation}
          <input className={INPUT} disabled={!canWrite} value={organisation} onChange={(event) => setOrganisation(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {copy.form.role}
          <input className={INPUT} disabled={!canWrite} value={role} onChange={(event) => setRole(event.target.value)} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs">
        {copy.form.notes}
        <textarea rows={2} className="rounded-md border bg-background p-2 text-sm" disabled={!canWrite} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {canWrite ? (
          <button type="button" className={PRIMARY} disabled={update.isPending} onClick={() => update.mutate({ id: row.id, input: { influence, interest, attitude, engagement, organisation: organisation || null, role: role || null, notes: notes || null } }, { onSuccess: onDone })}>
            {copy.form.save}
          </button>
        ) : null}
        {canManage && row.kind === 'contact' ? (
          <>
            <button type="button" className={BTN} disabled={invite.isPending} onClick={() => invite.mutate(row.id, { onSuccess: onDone })}>
              {row.portalAccess ? copy.portal.reinvite : copy.portal.invite}
            </button>
            {row.portalAccess ? (
              <button type="button" className={BTN} disabled={revoke.isPending} onClick={() => revoke.mutate(row.id, { onSuccess: onDone })}>
                {copy.portal.revoke}
              </button>
            ) : null}
          </>
        ) : null}
        {canManage && row.kind === 'member' ? <span className="text-xs text-muted-foreground">{copy.portal.onlyContacts}</span> : null}
        {canWrite ? (
          <button type="button" className={`${BTN} ml-auto`} onClick={() => window.confirm(copy.form.removeConfirm) && remove.mutate(row.id, { onSuccess: onDone })}>
            {copy.form.remove}
          </button>
        ) : null}
        <button type="button" className={BTN} onClick={onDone}>{copy.form.cancel}</button>
      </div>
      {update.isError || invite.isError || revoke.isError || remove.isError ? <p role="alert" className="text-xs text-destructive">{copy.saveFailed}</p> : null}
    </section>
  );
}

function PowerGrid({ rows, onPick }: Readonly<{ rows: Stakeholder[]; onPick: (row: Stakeholder) => void }>) {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders.grid;
  const quadrants = [
    { label: copy.keepSatisfied, high: true, interestHigh: false },
    { label: copy.manageClosely, high: true, interestHigh: true },
    { label: copy.monitor, high: false, interestHigh: false },
    { label: copy.keepInformed, high: false, interestHigh: true },
  ];
  return (
    <section className={CARD}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{copy.title}</h2>
        <span className="text-xs text-muted-foreground">{copy.hint}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {quadrants.map((quadrant) => (
          <div key={quadrant.label} className="flex min-h-36 flex-col gap-2 rounded-md bg-muted/40 p-3">
            <span className="text-xs font-semibold">{quadrant.label}</span>
            <div className="mt-auto flex flex-wrap gap-1.5">
              {rows.filter((row) => row.influence >= 4 === quadrant.high && row.interest >= 4 === quadrant.interestHigh).map((row) => (
                <button key={row.id} type="button" title={row.name ?? ''} onClick={() => onPick(row)} className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-background bg-secondary text-[11px] font-semibold">
                  {initials(row.name)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">{copy.interest} / {copy.influence}</p>
    </section>
  );
}

function CommunicationPlan({ projectId, manage }: Readonly<{ projectId: string; manage: boolean }>) {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders.plan;
  const query = useCommunicationPlan(projectId);
  const save = usePutCommunicationPlan();
  const [rows, setRows] = useState<CommunicationPlanEntry[]>([]);
  useEffect(() => setRows(query.data?.communicationPlan ?? []), [query.data]);
  const set = (index: number, key: keyof CommunicationPlanEntry, value: string) => setRows(rows.map((row, at) => (at === index ? { ...row, [key]: value } : row)));
  const complete = rows.every((row) => row.what.trim() && row.audience.trim() && row.cadence.trim() && row.channel.trim());
  return (
    <section className={`${CARD} flex flex-col gap-2`}>
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">{copy.title}</h2>
        {manage ? <button type="button" className="text-sm text-primary" onClick={() => setRows([...rows, { what: '', audience: '', cadence: '', channel: '' }])}>{copy.add}</button> : null}
      </div>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{copy.empty}</p> : null}
      {rows.map((row, index) => (
        <div key={index} className="grid gap-1.5 rounded-md border p-2 [grid-template-columns:repeat(auto-fit,minmax(140px,1fr))]">
          {(['what', 'audience', 'cadence', 'channel'] as const).map((key) => (
            <input key={key} aria-label={copy[key]} placeholder={copy[key]} className={INPUT} disabled={!manage} value={row[key]} onChange={(event) => set(index, key, event.target.value)} />
          ))}
          {manage ? <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => setRows(rows.filter((_, at) => at !== index))}>{copy.remove}</button> : null}
        </div>
      ))}
      {manage ? (
        <button type="button" className={`${PRIMARY} self-start`} disabled={save.isPending || !complete} onClick={() => save.mutate({ projectId, input: { communicationPlan: rows.map((row) => ({ what: row.what.trim(), audience: row.audience.trim(), cadence: row.cadence.trim(), channel: row.channel.trim() })) } })}>
          {t.flowReporting.stakeholders.form.save}
        </button>
      ) : null}
      {save.isError ? <p role="alert" className="text-xs text-destructive">{t.flowReporting.stakeholders.saveFailed}</p> : null}
    </section>
  );
}

function RaciMatrix({ projectId, stakeholders, canWrite }: Readonly<{ projectId: string; stakeholders: Stakeholder[]; canWrite: boolean }>) {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders.raci;
  const query = useRaci(projectId);
  const put = usePutRaci();
  const [message, setMessage] = useState<string | null>(null);

  const title = (subject: RaciSubject) => {
    if (subject.subjectType === 'deliverable') return `${subject.code ?? ''} ${subject.title ?? ''}`;
    return subject.subjectType === 'change_requests' ? copy.changeRequests : copy.goLive;
  };

  // One letter per cell; the API takes the whole row of a subject.
  const setCell = (subject: RaciSubject, stakeholderId: string, letter: RaciLetter | '') => {
    const others = subject.assignments.filter((assignment) => assignment.stakeholderId !== stakeholderId);
    const assignments = letter ? [...others.filter((a) => !(letter === 'A' && a.letter === 'A')), { stakeholderId, letter }] : others;
    put.mutate(
      { projectId, input: { subjectType: subject.subjectType, subjectId: subject.subjectId, assignments } },
      { onSuccess: () => setMessage(letter === 'A' ? copy.oneA : copy.saved), onError: () => setMessage(t.flowReporting.stakeholders.saveFailed) },
    );
  };

  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-baseline gap-3 border-b p-3">
        <h2 className="text-sm font-semibold">{copy.title}</h2>
        <span className="text-xs text-muted-foreground">{copy.legend}</span>
        {message ? <span role="status" className="text-xs text-muted-foreground">{message}</span> : null}
      </div>
      {stakeholders.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{copy.empty}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="p-3 text-left font-medium">{copy.subject}</th>
                {stakeholders.map((row) => <th key={row.id} className="p-2 text-center font-medium" title={row.name ?? ''}>{(row.name ?? '?').split(' ')[0]}</th>)}
              </tr>
            </thead>
            <tbody>
              {(query.data?.subjects ?? []).map((subject) => (
                <tr key={`${subject.subjectType}-${subject.subjectId ?? ''}`} className="border-t">
                  <th scope="row" className="p-3 text-left font-medium">{title(subject)}</th>
                  {stakeholders.map((row) => {
                    const letter = subject.assignments.find((assignment) => assignment.stakeholderId === row.id)?.letter ?? '';
                    return (
                      <td key={row.id} className="p-1.5 text-center">
                        <select aria-label={`${title(subject)} ${row.name ?? ''}`} className="h-7 w-12 rounded border bg-background text-center text-xs font-semibold" disabled={!canWrite || put.isPending} value={letter} onChange={(event) => setCell(subject, row.id, event.target.value as RaciLetter | '')}>
                          {LETTERS.map((value) => <option key={value} value={value}>{value}</option>)}
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
