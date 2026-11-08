import { Fragment, useState } from 'react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Textarea } from '@weldsuite/ui/components/textarea';
import Link from '@/components/link';
import { ActionDialog, Field } from '@/components/billing/action-dialog';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { clearFlag, setFlag } from '@/actions/flags';
import { formatDateTime } from '@/lib/billing-format';
import { parseFlagValue, type FlagType } from '@/lib/flags';
import { adminCopy, fill } from '@/lib/i18n';
import type { FlagRow, FlagsPageData } from './data';

type Dialog =
  | { kind: 'set'; flag: FlagRow; forWorkspace: boolean }
  | { kind: 'clear'; flag: FlagRow; workspace: { ref: string; label: string } | null }
  | null;

/** Feature flags on this install: the catalog, the value for everyone, and each workspace's own value. */
export function FlagsPage({ flags, canWrite }: Readonly<FlagsPageData>) {
  const t = adminCopy().flags;
  const [dialog, setDialog] = useState<Dialog>(null);

  return (
    <PageContent>
      <PageBody className="space-y-6">
        <PageHeading title={t.title} description={t.description} />
        {!canWrite && <p className="text-sm text-muted-foreground">{t.readOnly}</p>}

        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.columns.flag}</TableHead>
                <TableHead className="w-24">{t.columns.type}</TableHead>
                <TableHead className="w-32">{t.columns.default}</TableHead>
                <TableHead className="w-48">{t.columns.everyone}</TableHead>
                {canWrite && <TableHead className="w-72" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {flags.map((flag) => (
                <Fragment key={flag.key}>
                  <TableRow className="h-12">
                    <TableCell className="font-mono text-xs">{flag.key}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{flag.type}</Badge>
                    </TableCell>
                    <TableCell>
                      <FlagValue type={flag.type} value={flag.default} />
                    </TableCell>
                    <TableCell>
                      {flag.everyone ? (
                        <div>
                          <FlagValue type={flag.type} value={flag.everyone.value} />
                          <div className="text-[11px] text-muted-foreground">
                            {flag.everyone.updatedBy ?? '—'} · {formatDateTime(flag.everyone.updatedAt)}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t.usingDefault}</span>
                      )}
                    </TableCell>
                    {canWrite && (
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'set', flag, forWorkspace: false })}>
                            {t.setForEveryone}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'set', flag, forWorkspace: true })}>
                            {t.setForWorkspace}
                          </Button>
                          {flag.everyone && (
                            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'clear', flag, workspace: null })}>
                              {t.backToDefault}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                  {flag.workspaces.map((override) => {
                    const label = override.name ?? override.ref;
                    return (
                      <TableRow key={`${flag.key}:${override.ref}`} className="bg-muted/30 text-xs">
                        <TableCell className="pl-8" colSpan={3}>
                          {override.workspaceId ? (
                            <Link href={`/workspaces/${override.workspaceId}`} className="underline-offset-2 hover:underline">
                              {label}
                            </Link>
                          ) : (
                            <span className="font-mono">{label}</span>
                          )}
                          {override.slug && <span className="ml-1.5 font-mono text-muted-foreground">{override.slug}</span>}
                        </TableCell>
                        <TableCell>
                          <FlagValue type={flag.type} value={override.value} />
                          <div className="text-[11px] text-muted-foreground">
                            {override.updatedBy ?? '—'} · {formatDateTime(override.updatedAt)}
                          </div>
                        </TableCell>
                        {canWrite && (
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDialog({ kind: 'clear', flag, workspace: { ref: override.ref, label } })}
                            >
                              {t.remove}
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      </PageBody>

      {dialog?.kind === 'set' && (
        <SetFlagDialog flag={dialog.flag} forWorkspace={dialog.forWorkspace} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'clear' && (
        <ClearFlagDialog flag={dialog.flag} workspace={dialog.workspace} onClose={() => setDialog(null)} />
      )}
    </PageContent>
  );
}

function FlagValue({ type, value }: Readonly<{ type: FlagType; value: string }>) {
  const t = adminCopy().flags;
  if (type === 'boolean') {
    return <Badge variant={value === 'true' ? 'success' : 'secondary'}>{value === 'true' ? t.on : t.off}</Badge>;
  }
  return <span className="font-mono text-xs break-all">{value}</span>;
}

function ValueEditor({
  type,
  value,
  onChange,
}: Readonly<{ type: FlagType; value: string; onChange: (value: string) => void }>) {
  const t = adminCopy().flags;
  if (type === 'boolean') {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="flag-value" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">{t.on}</SelectItem>
          <SelectItem value="false">{t.off}</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (type === 'json') {
    return <Textarea id="flag-value" rows={4} className="font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <Input
      id="flag-value"
      inputMode={type === 'number' ? 'decimal' : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function SetFlagDialog({ flag, forWorkspace, onClose }: Readonly<{ flag: FlagRow; forWorkspace: boolean; onClose: () => void }>) {
  const t = adminCopy().flags;
  const [workspace, setWorkspace] = useState('');
  const [value, setValue] = useState(flag.everyone?.value ?? flag.default);
  const parsed = parseFlagValue(flag.type, value);
  let invalid: string | null = parsed.ok ? null : t.errors[parsed.error];
  if (!invalid && forWorkspace && workspace.trim() === '') invalid = t.errors.workspaceRequired;

  return (
    <ActionDialog
      title={fill(forWorkspace ? t.setWorkspaceTitle : t.setTitle, { flag: flag.key })}
      submitLabel={forWorkspace ? t.setForWorkspace : t.setForEveryone}
      invalidMessage={invalid}
      onClose={onClose}
      onSubmit={(reason) => setFlag({ flag: flag.key, workspace: forWorkspace ? workspace : null, value, reason })}
      successMessage={(data) => fill(t.saved, { flag: data.flag })}
    >
      {forWorkspace && (
        <Field label={t.workspace} htmlFor="flag-workspace" hint={t.workspaceHint}>
          <Input id="flag-workspace" value={workspace} onChange={(e) => setWorkspace(e.target.value)} autoFocus />
        </Field>
      )}
      <Field label={t.value} htmlFor="flag-value">
        <ValueEditor type={flag.type} value={value} onChange={setValue} />
      </Field>
    </ActionDialog>
  );
}

function ClearFlagDialog({
  flag,
  workspace,
  onClose,
}: Readonly<{ flag: FlagRow; workspace: { ref: string; label: string } | null; onClose: () => void }>) {
  const t = adminCopy().flags;

  return (
    <ActionDialog
      title={fill(t.clearTitle, { flag: flag.key })}
      description={workspace ? fill(t.clearWorkspace, { workspace: workspace.label }) : t.clearEveryone}
      submitLabel={workspace ? t.remove : t.backToDefault}
      destructive
      onClose={onClose}
      onSubmit={(reason) => clearFlag({ flag: flag.key, workspace: workspace?.ref ?? null, reason })}
      successMessage={(data) => fill(t.cleared, { flag: data.flag })}
    />
  );
}
