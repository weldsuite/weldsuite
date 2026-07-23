/**
 * Workspace name section.
 *
 * Inline edit for the workspace display name. Owner or admin only.
 * Updates `workspaces.name` in the master DB and the Clerk org name in sync
 * (rolls back on Clerk failure).
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useOrganization } from '@clerk/clerk-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useAppApi } from '@/lib/api/use-app-api';
import { useCurrentMember } from '@/hooks/use-current-member';
import { useI18n } from '@/lib/i18n/provider';

export function WorkspaceNameSection() {
  const { t } = useI18n();
  const ts = (t.settings.generalSettings as any).workspaceName as Record<string, string>;
  const { organization } = useOrganization();
  const { workspaceSettings } = useAppApi();
  const { data: member } = useCurrentMember();

  const canEdit = member?.role === 'OWNER' || member?.role === 'ADMIN';
  const currentName = organization?.name ?? '';

  const [value, setValue] = useState(currentName);
  const [saving, setSaving] = useState(false);

  // Keep the input synced when the workspace context refreshes.
  useEffect(() => {
    setValue(currentName);
  }, [currentName]);

  const trimmed = value.trim();
  const isDirty = trimmed.length > 0 && trimmed !== currentName;
  const canSave = isDirty && !saving && canEdit;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await workspaceSettings.updateName({ name: trimmed });
      await organization?.reload().catch(() => {});
      toast.success(ts.successToast);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : ts.errorToast);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h3 className="text-lg font-semibold mb-1">{ts.title}</h3>
      <p className="text-sm text-muted-foreground mb-4">{ts.description}</p>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1.5 min-w-0 flex-1">
          <Label htmlFor="workspace-name-input" className="text-xs text-muted-foreground">
            {ts.label}
          </Label>
          <Input
            id="workspace-name-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={ts.placeholder}
            disabled={!canEdit || saving}
            maxLength={255}
          />
        </div>
        <div className="flex flex-col items-stretch sm:items-end gap-1">
          <Button
            type="button"
            variant="outline"
            onClick={handleSave}
            disabled={!canSave}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {ts.saveButton}
          </Button>
          {!canEdit && (
            <p className="text-xs text-muted-foreground">{ts.adminOnlyHint}</p>
          )}
        </div>
      </div>
    </div>
  );
}
