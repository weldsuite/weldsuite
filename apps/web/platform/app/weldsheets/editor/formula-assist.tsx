import { Fragment, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { SquareFunction, Tag } from 'lucide-react';
import type { SheetFunctionHelp } from '@weldsuite/i18n/locales/en/weldsheets-functions';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { applySuggestion, callAt, formulaSuggestions, signatureTokens, type FormulaSuggestion } from './model/formula-edit';
import type { SheetController } from './model/sheet-controller';

type FunctionHelp = Record<string, SheetFunctionHelp>;
type HelpLanguage = 'en' | 'nl';

const helpLoads = new Map<HelpLanguage, Promise<FunctionHelp | null>>();

/** The function help is a few dozen kB per language: loaded once, the first time a formula is typed. */
function loadHelp(lang: HelpLanguage): Promise<FunctionHelp | null> {
  let load = helpLoads.get(lang);
  if (!load) {
    const chunk = lang === 'nl' ? import('@weldsuite/i18n/locales/nl/weldsheets-functions') : import('@weldsuite/i18n/locales/en/weldsheets-functions');
    load = chunk.then(
      (m) => m.weldsheetsFunctions as FunctionHelp,
      () => {
        helpLoads.delete(lang);
        return null;
      },
    );
    helpLoads.set(lang, load);
  }
  return load;
}

function useFunctionHelp(wanted: boolean): FunctionHelp | null {
  const { language } = useI18n();
  const lang: HelpLanguage = language === 'nl' ? 'nl' : 'en';
  const [loaded, setLoaded] = useState<{ lang: HelpLanguage; help: FunctionHelp } | null>(null);
  useEffect(() => {
    if (!wanted || loaded?.lang === lang) return;
    let live = true;
    void loadHelp(lang).then((help) => {
      if (live && help) setLoaded({ lang, help });
    });
    return () => {
      live = false;
    };
  }, [wanted, lang, loaded?.lang]);
  return loaded?.lang === lang ? loaded.help : null;
}

export interface FormulaAssist {
  /** The open suggestion list: where the name being replaced starts, and the highlighted item. */
  list: { start: number; items: FormulaSuggestion[]; index: number } | null;
  /** The argument hint for the call around the caret, while no list is open. */
  hint: { name: string; start: number; tokens: string[]; active: number } | null;
  help: FunctionHelp | null;
  /** Call on every change with the new text and caret: the list only opens while typing. */
  noteTyping(text: string, caret: number): void;
  /** Arrows move through the list, Tab and Enter take the highlighted item, Escape closes it. True when the key was used. */
  onKeyDown(e: KeyboardEvent): boolean;
  accept(item: FormulaSuggestion): void;
}

/**
 * Formula autocomplete for an edit: the functions and defined names that
 * match the name being typed, and the argument list of the function the caret
 * is in, as Excel shows them. `text` is null when nothing is being edited.
 * `onApply` puts a taken suggestion in the editor.
 */
export function useFormulaAssist(
  controller: SheetController,
  text: string | null,
  caret: number,
  onApply: (text: string, caret: number) => void,
): FormulaAssist {
  const isFormula = text !== null && text.startsWith('=');
  const help = useFunctionHelp(isFormula);
  const [typed, setTyped] = useState<{ text: string; caret: number } | null>(null);
  const [picked, setPicked] = useState({ key: '', index: 0 });
  const [closedKey, setClosedKey] = useState<string | null>(null);

  const typing = isFormula && typed?.text === text && typed.caret === caret;
  const match = typing ? formulaSuggestions(text, caret, definedNames(controller)) : null;
  const key = match ? `${match.start}:${match.prefix}` : '';
  const open = match && match.items.length > 0 && closedKey !== key ? match : null;
  const index = open && picked.key === key ? Math.min(picked.index, open.items.length - 1) : 0;

  const call = !open && isFormula && help ? callAt(text, caret, controller.options.formulaLocale) : null;
  const callHelp = call ? help?.[call.name] : undefined;

  const accept = (item: FormulaSuggestion) => {
    if (text === null || !match) return;
    const next = applySuggestion(text, match, item);
    setTyped(null);
    onApply(next.text, next.caret);
  };

  return {
    list: open ? { start: open.start, items: open.items, index } : null,
    hint: call && callHelp ? { name: call.name, start: call.start, ...signatureTokens(callHelp[0], call.argIndex) } : null,
    help,
    noteTyping: (nextText, nextCaret) => setTyped({ text: nextText, caret: nextCaret }),
    onKeyDown: (e) => {
      if (!open) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setPicked({ key, index: (index + step + open.items.length) % open.items.length });
      } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.altKey && !open.reference)) {
        accept(open.items[index]!);
      } else if (e.key === 'Escape') {
        setClosedKey(key);
      } else return false;
      e.preventDefault();
      return true;
    },
    accept,
  };
}

/** Names a formula on the active sheet can use: workbook names and the sheet's own, not Excel's hidden _xlnm ones. */
function definedNames(controller: SheetController): string[] {
  const names = new Set<string>();
  for (const n of controller.engine.workbook.names) {
    if (n.name.startsWith('_xlnm.')) continue;
    if (n.sheetId === undefined || n.sheetId === controller.activeSheetId) names.add(n.name);
  }
  return [...names];
}

/**
 * The suggestion list, with the highlighted function's arguments and
 * description underneath, or the argument hint with the argument being typed
 * in bold. Positioned by the editor it belongs to.
 */
export function FormulaAssistPopup({ assist, controller, style }: { assist: FormulaAssist; controller: SheetController; style: CSSProperties }) {
  const { t } = useI18n();
  const listRef = useRef<HTMLUListElement>(null);
  const separator = controller.options.formulaLocale.decimal === ',' ? ';' : ',';
  const { list, hint, help } = assist;
  const highlighted = list?.index;

  useEffect(() => {
    if (highlighted === undefined) return;
    listRef.current?.children[highlighted]?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  if (list) {
    const selected = list.items[list.index]!;
    const selectedHelp = selected.kind === 'function' ? help?.[selected.name] : undefined;
    const refersTo = selected.kind === 'name' ? controller.engine.definedName(selected.name, controller.activeSheetId) : undefined;
    return (
      <div
        className="absolute z-30 w-[340px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border bg-popover text-sm text-popover-foreground shadow-md"
        style={style}
        data-testid="formula-suggestions"
      >
        <ul ref={listRef} role="listbox" aria-label={t.weldsheets.editor.suggestions} className="max-h-56 overflow-y-auto py-1">
          {list.items.map((item, i) => (
            <li
              key={`${item.kind}:${item.name}`}
              role="option"
              aria-selected={i === list.index}
              className={cn('flex cursor-pointer items-center gap-2 px-2 py-1', i === list.index && 'bg-accent text-accent-foreground')}
              onPointerDown={(e) => {
                e.preventDefault();
                assist.accept(item);
              }}
            >
              {item.kind === 'function' ? (
                <SquareFunction className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <Tag className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="truncate font-mono text-[13px]">{item.name}</span>
            </li>
          ))}
        </ul>
        {selectedHelp && (
          <div className="border-t px-3 py-2">
            <Signature name={selected.name} tokens={signatureTokens(selectedHelp[0], -1).tokens} active={-1} separator={separator} />
            <p className="mt-1 text-xs text-muted-foreground">{selectedHelp[1]}</p>
          </div>
        )}
        {refersTo !== undefined && (
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            {t.weldsheets.editor.namedRange}: <span className="font-mono text-foreground">={refersTo}</span>
          </div>
        )}
      </div>
    );
  }

  if (!hint) return null;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-30 max-w-[min(560px,calc(100vw-2rem))] rounded-md border bg-popover px-2 py-1 text-popover-foreground shadow-md"
      style={style}
      data-testid="formula-hint"
    >
      <Signature name={hint.name} tokens={hint.tokens} active={hint.active} separator={separator} />
    </div>
  );
}

function Signature({ name, tokens, active, separator }: { name: string; tokens: string[]; active: number; separator: string }) {
  return (
    <div className="font-mono text-xs leading-5">
      <span className="font-semibold">{name}</span>(
      {tokens.map((token, i) => (
        <Fragment key={i}>
          {i > 0 && `${separator} `}
          <span className={tokenClass(i, active)}>{token}</span>
        </Fragment>
      ))}
      )
    </div>
  );
}

/** The argument being typed stands out; with one being typed, the others step back. */
function tokenClass(i: number, active: number): string | undefined {
  if (i === active) return 'font-bold text-foreground';
  return active >= 0 ? 'text-muted-foreground' : undefined;
}
