
import { useRef, useState, type InputHTMLAttributes } from 'react';
import { Loader2, FolderUp } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useUploadUserAppVersion, type UserApp } from '@/hooks/queries/use-user-apps-queries';

interface UploadVersionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: UserApp;
}

/** A `File` picked via a `webkitdirectory` input also carries this. */
interface FileWithRelativePath extends File {
  webkitRelativePath: string;
}

function bumpPatch(version: string): string {
  const parts = version.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) return '0.0.1';
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function buildManifestTemplate(app: UserApp): string {
  const lastManifest = (app.manifest ?? {}) as Record<string, unknown>;
  const lastVersion = typeof lastManifest.version === 'string' ? lastManifest.version : '0.0.0';
  const scopes = Array.isArray(lastManifest.scopes) ? lastManifest.scopes : app.requestedScopes;
  return JSON.stringify(
    {
      code: app.code,
      name: app.name,
      version: bumpPatch(lastVersion),
      scopes,
    },
    null,
    2,
  );
}

/** Strips the top-level picked folder from a `webkitRelativePath` (e.g. `my-app/dist/index.html` -> `dist/index.html`). */
function stripTopLevelFolder(relativePath: string): string {
  const segments = relativePath.split('/').filter(Boolean);
  return segments.length > 1 ? segments.slice(1).join('/') : segments.join('/');
}

// `webkitdirectory`/`directory` aren't in React's InputHTMLAttributes typings
// but are supported by every major browser for folder pickers. Widening the
// props object's type (rather than the JSX element's) avoids `any`/`@ts-ignore`
// — spread attributes aren't excess-property-checked, so this superset type
// spreads cleanly onto the intrinsic `<input>`.
type DirectoryInputProps = InputHTMLAttributes<HTMLInputElement> & {
  webkitdirectory?: string;
  directory?: string;
};

export function UploadVersionDialog({ open, onOpenChange, app }: UploadVersionDialogProps) {
  const { t, format } = useI18n();
  const wa = t.weldapps;
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [manifestText, setManifestText] = useState(() => buildManifestTemplate(app));
  const [changelog, setChangelog] = useState('');
  const [manifestFromFile, setManifestFromFile] = useState(false);
  const uploadMutation = useUploadUserAppVersion();

  const handleFilesPicked = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const picked = Array.from(fileList);
    setFiles(picked);

    // A picked folder nests everything one level deep, so a manifest at the
    // bundle root shows up as "<picked-folder>/weldapp.json".
    const manifestFile = picked.find((f) => {
      const rel = (f as FileWithRelativePath).webkitRelativePath || f.name;
      const segments = rel.split('/').filter(Boolean);
      return segments.length <= 2 && segments[segments.length - 1] === 'weldapp.json';
    });

    if (manifestFile) {
      try {
        const text = await manifestFile.text();
        JSON.parse(text); // validate before prefilling — fall through to the template on failure
        setManifestText(text);
        setManifestFromFile(true);
        return;
      } catch {
        // Not valid JSON — keep whatever manifest text is already there.
      }
    }
    setManifestFromFile(false);
  };

  const resetState = () => {
    setFiles([]);
    setChangelog('');
    setManifestFromFile(false);
    setManifestText(buildManifestTemplate(app));
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) resetState();
    onOpenChange(nextOpen);
  };

  const handleUpload = async () => {
    if (files.length === 0) {
      toast.error(wa.uploadDialog.noFilesError);
      return;
    }
    try {
      JSON.parse(manifestText);
    } catch {
      toast.error(wa.uploadDialog.invalidManifestError);
      return;
    }

    const formData = new FormData();
    formData.append('manifest', manifestText);
    if (changelog.trim()) formData.append('changelog', changelog.trim());
    for (const file of files) {
      const rel = (file as FileWithRelativePath).webkitRelativePath || file.name;
      const path = stripTopLevelFolder(rel) || file.name;
      formData.append('files', file, path);
    }

    try {
      await uploadMutation.mutateAsync({ id: app.id, formData });
      toast.success(wa.uploadDialog.uploadSuccess);
      handleClose(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : wa.uploadDialog.uploadError);
    }
  };

  const isSubmitting = uploadMutation.isPending;

  const directoryInputProps: DirectoryInputProps = {
    type: 'file',
    webkitdirectory: '',
    directory: '',
    multiple: true,
    className: 'hidden',
    onChange: (e) => {
      void handleFilesPicked(e.target.files);
    },
  };

  return (
    <Dialog open={open} onOpenChange={isSubmitting ? undefined : handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{wa.uploadDialog.title}</DialogTitle>
          <DialogDescription>{wa.uploadDialog.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <input ref={inputRef} {...directoryInputProps} />
            <Button type="button" variant="outline" onClick={() => inputRef.current?.click()} className="gap-2">
              <FolderUp className="h-4 w-4" />
              {wa.uploadDialog.selectFolder}
            </Button>
            {files.length > 0 && (
              <p className="text-xs text-muted-foreground mt-2">
                {format(wa.uploadDialog.filesSelected, { count: files.length })}
                {manifestFromFile ? ` · ${wa.uploadDialog.manifestFound}` : ''}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>{wa.uploadDialog.manifestLabel}</Label>
            <Textarea
              value={manifestText}
              onChange={(e) => setManifestText(e.target.value)}
              rows={8}
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label>{wa.uploadDialog.changelogLabel}</Label>
            <Textarea
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              placeholder={wa.uploadDialog.changelogPlaceholder}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleClose(false)} disabled={isSubmitting}>
            {wa.consent.cancel}
          </Button>
          <Button type="button" onClick={handleUpload} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {wa.uploadDialog.upload}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
