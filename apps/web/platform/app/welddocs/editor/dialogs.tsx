import { useState, useSyncExternalStore } from 'react';
import { A4, LETTER, isCollapsed } from '@weldsuite/docs-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';
import { MOD_LABEL } from './model/keyboard';
import { PALETTE } from './ui';

/** Whichever dialog the controller has open. */
export function DocDialogs({ controller }: { controller: DocController }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const close = () => controller.openDialog(null);
  switch (controller.dialog) {
    case 'pageSetup':
      return <PageSetupDialog controller={controller} onClose={close} />;
    case 'wordCount':
      return <WordCountDialog controller={controller} onClose={close} />;
    case 'link':
      return <LinkDialog controller={controller} onClose={close} />;
    case 'shortcuts':
      return <ShortcutsDialog onClose={close} />;
    default:
      return null;
  }
}

const CM = 72 / 2.54;
const PAPER: Record<string, { pageWidth: number; pageHeight: number }> = {
  a4: A4,
  letter: LETTER,
  legal: { pageWidth: 612, pageHeight: 1008 },
  a5: { pageWidth: 419.5, pageHeight: 595.3 },
  a3: { pageWidth: 841.9, pageHeight: 1190.6 },
};
const PAPER_LABELS: Record<string, string> = {
  a4: 'A4 (21 × 29.7 cm)',
  letter: 'Letter (8.5" × 11")',
  legal: 'Legal (8.5" × 14")',
  a5: 'A5 (14.8 × 21 cm)',
  a3: 'A3 (29.7 × 42 cm)',
};

function PageSetupDialog({ controller, onClose }: { controller: DocController; onClose: () => void }) {
  const { t } = useI18n();
  const tp = t.welddocs.pageSetup;
  const s = controller.section;
  const [pageless, setPageless] = useState(!!controller.doc.props.pageless);
  const landscapeNow = s.pageWidth > s.pageHeight;
  const [landscape, setLandscape] = useState(landscapeNow);
  const shortSide = Math.min(s.pageWidth, s.pageHeight);
  const longSide = Math.max(s.pageWidth, s.pageHeight);
  const [paper, setPaper] = useState(Object.entries(PAPER).find(([, p]) => Math.abs(p.pageWidth - shortSide) < 1 && Math.abs(p.pageHeight - longSide) < 1)?.[0] ?? 'a4');
  const [margins, setMargins] = useState({
    top: toCm(s.marginTop),
    bottom: toCm(s.marginBottom),
    left: toCm(s.marginLeft),
    right: toCm(s.marginRight),
  });
  const [background, setBackground] = useState(s.background ?? '#ffffff');
  const [columns, setColumns] = useState(s.columns ?? 1);
  const [titlePage, setTitlePage] = useState(!!s.titlePage);

  const save = () => {
    const size = PAPER[paper] ?? A4;
    const width = landscape ? size.pageHeight : size.pageWidth;
    const height = landscape ? size.pageWidth : size.pageHeight;
    const next = {
      pageWidth: width,
      pageHeight: height,
      marginTop: fromCm(margins.top),
      marginBottom: fromCm(margins.bottom),
      marginLeft: fromCm(margins.left),
      marginRight: fromCm(margins.right),
      columns: columns > 1 ? columns : undefined,
      background: background !== '#ffffff' ? background : undefined,
      titlePage: titlePage || undefined,
    };
    const merged = { ...controller.section, ...next };
    for (const k of Object.keys(merged) as (keyof typeof merged)[]) if (merged[k] === undefined) delete merged[k];
    controller.apply({ type: 'batch', ops: [{ type: 'setDocProps', patch: { section: merged, pageless: pageless || null } }] });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tp.title}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex gap-2">
            <Button variant={pageless ? 'outline' : 'default'} size="sm" onClick={() => setPageless(false)}>
              {tp.pages}
            </Button>
            <Button variant={pageless ? 'default' : 'outline'} size="sm" onClick={() => setPageless(true)}>
              {tp.pageless}
            </Button>
          </div>
          {pageless ? (
            <p className="text-muted-foreground">{tp.pagelessHint}</p>
          ) : (
            <>
              <fieldset className="flex items-center gap-4">
                <legend className="mb-1 text-xs font-medium text-muted-foreground">{tp.orientation}</legend>
                <label className="flex items-center gap-1">
                  <input type="radio" checked={!landscape} onChange={() => setLandscape(false)} />
                  {tp.portrait}
                </label>
                <label className="flex items-center gap-1">
                  <input type="radio" checked={landscape} onChange={() => setLandscape(true)} />
                  {tp.landscape}
                </label>
              </fieldset>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{tp.paperSize}</span>
                <select value={paper} onChange={(e) => setPaper(e.target.value)} className="h-8 rounded border bg-background px-2">
                  {Object.keys(PAPER).map((k) => (
                    <option key={k} value={k}>
                      {PAPER_LABELS[k]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{tp.margins}</span>
                <div className="grid grid-cols-2 gap-2">
                  {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
                    <label key={side} className="flex items-center justify-between gap-2">
                      {tp[side]}
                      <input
                        type="number"
                        min={0}
                        max={10}
                        step={0.1}
                        value={margins[side]}
                        onChange={(e) => setMargins({ ...margins, [side]: Number(e.target.value) })}
                        className="h-8 w-20 rounded border bg-background px-2"
                      />
                    </label>
                  ))}
                </div>
              </div>
              <label className="flex items-center justify-between gap-2">
                {tp.columns}
                <select value={columns} onChange={(e) => setColumns(Number(e.target.value))} className="h-8 rounded border bg-background px-2">
                  {[1, 2, 3].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={titlePage} onChange={(e) => setTitlePage(e.target.checked)} />
                {tp.differentFirstPage}
              </label>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{tp.pageColor}</span>
                <div className="grid grid-cols-10 gap-1">
                  {PALETTE.slice(20, 30).concat(['#ffffff']).map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={c}
                      onClick={() => setBackground(c)}
                      className={`h-5 w-5 rounded-sm border ${background === c ? 'ring-2 ring-primary ring-offset-1' : ''}`}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tp.cancel}
          </Button>
          <Button onClick={save}>{tp.ok}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toCm(pt: number): number {
  return Math.round((pt / CM) * 100) / 100;
}

function fromCm(cm: number): number {
  return Math.max(0, Math.min(10, Number.isFinite(cm) ? cm : 2.54)) * CM;
}

function WordCountDialog({ controller, onClose }: { controller: DocController; onClose: () => void }) {
  const { t, format } = useI18n();
  const tw = t.welddocs.wordCount;
  const selection = !isCollapsed(controller.selection);
  const stats = controller.stats(selection);
  const n = (v: number) => format('{v}', { v: v.toLocaleString() });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{tw.title}</DialogTitle>
        </DialogHeader>
        {selection && <p className="text-xs text-muted-foreground">{tw.selection}</p>}
        <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-sm">
          {!selection && (
            <>
              <dt>{tw.pages}</dt>
              <dd className="text-right tabular-nums">{n(controller.pages.length)}</dd>
            </>
          )}
          <dt>{tw.words}</dt>
          <dd className="text-right tabular-nums">{n(stats.words)}</dd>
          <dt>{tw.characters}</dt>
          <dd className="text-right tabular-nums">{n(stats.characters)}</dd>
          <dt>{tw.charactersNoSpaces}</dt>
          <dd className="text-right tabular-nums">{n(stats.charactersNoSpaces)}</dd>
          <dt>{tw.paragraphs}</dt>
          <dd className="text-right tabular-nums">{n(stats.paragraphs)}</dd>
        </dl>
        <DialogFooter>
          <Button onClick={onClose}>{tw.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A web address, email or phone number, made into a link target; null when it is none of those. */
export function normalizeLink(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (/^(https?:|mailto:|tel:)/i.test(v)) return v;
  if (v.startsWith('#')) return v;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  if (/^\+?[\d\s()-]{6,}$/.test(v)) return `tel:${v.replace(/\s/g, '')}`;
  if (/^[^\s]+\.[^\s]{2,}/.test(v)) return `https://${v}`;
  return null;
}

function LinkDialog({ controller, onClose }: { controller: DocController; onClose: () => void }) {
  const { t } = useI18n();
  const tl = t.welddocs.link;
  const existing = controller.link();
  const collapsed = isCollapsed(controller.selection);
  const [text, setText] = useState(existing?.text ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [error, setError] = useState(false);
  const apply = () => {
    const target = normalizeLink(url);
    if (!target) {
      setError(true);
      return;
    }
    controller.setLink(target, collapsed && !existing ? text || url : undefined);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tl.title}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          {collapsed && !existing && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">{tl.text}</span>
              <input value={text} onChange={(e) => setText(e.target.value)} className="h-8 rounded border bg-background px-2" />
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{tl.url}</span>
            <input
              autoFocus
              value={url}
              placeholder={tl.urlPlaceholder}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(false);
              }}
              className="h-8 rounded border bg-background px-2"
            />
          </label>
          {error && <p className="text-xs text-destructive">{tl.invalid}</p>}
          <DialogFooter>
            {existing && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  controller.removeLink();
                  onClose();
                }}
              >
                {t.welddocs.editor.removeLink}
              </Button>
            )}
            <Button type="submit">{tl.apply}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const ts = t.welddocs.shortcuts;
  const i = ts.items;
  const m = MOD_LABEL;
  const groups: [string, [string, string][]][] = [
    [
      ts.groups.text,
      [
        [i.bold, `${m}+B`],
        [i.italic, `${m}+I`],
        [i.underline, `${m}+U`],
        [i.strike, 'Alt+Shift+5'],
        [i.superscript, `${m}+.`],
        [i.subscript, `${m}+,`],
        [i.clear, `${m}+\\`],
        [i.link, `${m}+K`],
      ],
    ],
    [
      ts.groups.paragraph,
      [
        [i.normal, `${m}+Alt+0`],
        [i.heading, `${m}+Alt+1…6`],
        [i.numbered, `${m}+Shift+7`],
        [i.bulleted, `${m}+Shift+8`],
        [i.checklist, `${m}+Shift+9`],
        [i.alignLeft, `${m}+Shift+L`],
        [i.alignCenter, `${m}+Shift+E`],
        [i.alignRight, `${m}+Shift+R`],
        [i.justify, `${m}+Shift+J`],
        [i.indent, `${m}+] / ${m}+[`],
      ],
    ],
    [
      ts.groups.editing,
      [
        [i.undo, `${m}+Z`],
        [i.redo, `${m}+Y`],
        [i.find, `${m}+H`],
        [i.pageBreak, `${m}+Enter`],
        [i.lineBreak, 'Shift+Enter'],
        [i.pastePlain, `${m}+Shift+V`],
        [i.selectAll, `${m}+A`],
        [i.print, `${m}+P`],
      ],
    ],
    [
      ts.groups.navigation,
      [
        [i.wordJump, `${m}+← / →`],
        [i.docEdge, `${m}+Home / End`],
      ],
    ],
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{ts.title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {groups.map(([title, rows]) => (
            <section key={title}>
              <h3 className="mb-2 text-sm font-medium">{title}</h3>
              <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
                {rows.map(([label, keys]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="text-right font-mono text-xs">{keys}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{ts.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
