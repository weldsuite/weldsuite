'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageUp, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { exportTrimmedPng, renderTypedSignature, renderUploadedSignature } from '@/lib/signature';
import type { AdoptedSignature } from '@/lib/signing-types';
import { BrandButton } from './brand-button';
import { usePortal } from './portal-context';
import { SignaturePad } from './signature-pad';

type Tab = 'draw' | 'type' | 'upload';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

interface SignatureDialogProps {
  open: boolean;
  /** `signature` or `initials`; initials adopt separately. */
  variant: 'signature' | 'initials';
  /** Text to prefill the Type tab with (full name, or initials). */
  suggestedText: string;
  onAdopt: (value: AdoptedSignature) => void;
  onClose: () => void;
}

export function SignatureDialog({ open, variant, suggestedText, onAdopt, onClose }: Readonly<SignatureDialogProps>) {
  const { t } = usePortal();
  const isInitials = variant === 'initials';
  const [tab, setTab] = useState<Tab>('draw');
  const [typed, setTyped] = useState(suggestedText);
  const [drawn, setDrawn] = useState<HTMLCanvasElement | null>(null);
  const [clearToken, setClearToken] = useState(0);
  const [uploaded, setUploaded] = useState<HTMLCanvasElement | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Start fresh whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTab('draw');
    setTyped(suggestedText);
    setDrawn(null);
    setUploaded(null);
    setUploadPreview(null);
    setError(null);
    setClearToken((n) => n + 1);
  }, [open, suggestedText]);

  const typedCanvas = useMemo(() => (typed.trim() ? renderTypedSignature(typed) : null), [typed]);
  const typedPreview = useMemo(() => (typedCanvas ? exportTrimmedPng(typedCanvas) : null), [typedCanvas]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t.adopt.uploadTooBig);
      return;
    }
    try {
      const canvas = await renderUploadedSignature(file);
      const result = exportTrimmedPng(canvas);
      if ('error' in result) {
        setError(result.error === 'empty' ? t.adopt.uploadInvalid : t.adopt.tooLarge);
        return;
      }
      setUploaded(canvas);
      setUploadPreview(result.image);
    } catch {
      setError(t.adopt.uploadInvalid);
    }
  }

  function adopt() {
    const source = tab === 'draw' ? drawn : tab === 'type' ? typedCanvas : uploaded;
    const emptyMessage = isInitials ? t.adopt.emptyInitials : t.adopt.empty;
    if (!source) {
      setError(emptyMessage);
      return;
    }
    const result = exportTrimmedPng(source);
    if ('error' in result) {
      setError(result.error === 'empty' ? emptyMessage : t.adopt.tooLarge);
      return;
    }
    onAdopt({ kind: tab === 'draw' ? 'drawn' : tab === 'type' ? 'typed' : 'uploaded', image: result.image });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent showCloseButton={false} className="max-h-[92dvh] overflow-y-auto">
        <button
          type="button"
          aria-label={t.adopt.close}
          onClick={onClose}
          className="absolute top-3 right-3 rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <X className="size-4" />
        </button>
        <DialogHeader>
          <DialogTitle>{isInitials ? t.adopt.initialsTitle : t.adopt.signatureTitle}</DialogTitle>
          <DialogDescription>{t.adopt.description}</DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as Tab);
            setError(null);
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="draw">{t.adopt.tabDraw}</TabsTrigger>
            <TabsTrigger value="type">{t.adopt.tabType}</TabsTrigger>
            <TabsTrigger value="upload">{t.adopt.tabUpload}</TabsTrigger>
          </TabsList>

          {/* Kept mounted so switching tabs does not wipe the drawing. */}
          <TabsContent value="draw" forceMount className="flex flex-col gap-2 data-[state=inactive]:hidden">
            <p className="text-xs text-muted-foreground">{t.adopt.drawLabel}</p>
            <SignaturePad label={t.adopt.drawArea} onChange={setDrawn} clearToken={clearToken} />
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setClearToken((n) => n + 1)} disabled={!drawn}>
                {t.adopt.clear}
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="type" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sign-typed">{isInitials ? t.adopt.typeLabelInitials : t.adopt.typeLabel}</Label>
              <Input id="sign-typed" value={typed} maxLength={isInitials ? 6 : 80} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
            </div>
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-input bg-white p-2" aria-label={t.adopt.typePreview}>
              {typedPreview && 'image' in typedPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={typedPreview.image} alt="" className="max-h-full max-w-full object-contain" />
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="upload" className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">{t.adopt.uploadHint}</p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-input bg-white p-2">
              {uploadPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={uploadPreview} alt="" className="max-h-full max-w-full object-contain" />
              ) : null}
            </div>
            <div>
              <Button type="button" variant="outline" onClick={() => fileRef.current?.click()}>
                <ImageUp />
                {uploadPreview ? t.adopt.uploadReplace : t.adopt.uploadChoose}
              </Button>
            </div>
          </TabsContent>
        </Tabs>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t.adopt.cancel}
          </Button>
          <BrandButton type="button" onClick={adopt}>
            {t.adopt.confirm}
          </BrandButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
