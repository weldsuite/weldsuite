import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import * as XLSX from 'xlsx-js-style';
import { fetchSheetContent, putSheetContent } from '@/app/weldflow/lib/api-client';
import { useTranslations } from '@weldsuite/i18n/client';

// ---------------------------------------------------------------------------
// Types — kept identical in shape to the previous DB-backed hook so the rest
// of the spreadsheet view (~900 lines) keeps working unchanged. `sheetId`,
// `colId`, `rowId` are now client-side synthetic IDs.
// ---------------------------------------------------------------------------

export interface SpreadsheetTable {
  id: string;
  projectId: string;
  name: string;
  position: number;
  settings: any;
  createdAt: string;
  updatedAt: string;
}

export interface SpreadsheetRow {
  id: string;
  sheetId: string;
  position: number;
  data: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface SpreadsheetColumn {
  id: string;
  sheetId: string;
  name: string;
  fieldType: string;
  position: number;
  width: number | null;
  options: any;
  config: any;
  createdAt: string;
  updatedAt: string;
}

export interface SpreadsheetSheet {
  id: string;
  projectId: string;
  tableId: string | null;
  name: string;
  position: number;
  settings: any;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// In-memory workbook model. The xlsx file in R2 is the source of truth — it
// carries one hidden `_weldsuite` worksheet whose A1 cell holds a JSON blob
// of this exact shape. Other worksheets are human-readable representations of
// each sheet (so the file opens cleanly in Excel) but are not read back into
// WeldFlow — round-trips go through the JSON.
// ---------------------------------------------------------------------------

interface WorkbookModel {
  sheets: SpreadsheetSheet[];
  columnsBySheet: Record<string, SpreadsheetColumn[]>;
  rowsBySheet: Record<string, SpreadsheetRow[]>;
}

const META_SHEET = '_weldsuite';
const META_VERSION = 1;
const DEBOUNCE_MS = 1500;

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyModel(projectId: string): WorkbookModel {
  const now = nowIso();
  const sheetId = uid('sht');
  const colId = uid('scol');
  return {
    sheets: [
      {
        id: sheetId,
        projectId,
        tableId: null,
        name: 'Sheet 1',
        position: 0,
        settings: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    columnsBySheet: {
      [sheetId]: [
        {
          id: colId,
          sheetId,
          name: 'Column 1',
          fieldType: 'text',
          position: 0,
          width: 100,
          options: null,
          config: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    rowsBySheet: { [sheetId]: [] },
  };
}

// Decode the `_weldsuite` meta sheet back into a WorkbookModel.
function readWorkbook(buf: ArrayBuffer, projectId: string): WorkbookModel {
  try {
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    console.log('[useSpreadsheet] read xlsx:', {
      byteLength: buf.byteLength,
      sheetNames: wb.SheetNames,
      hasMetaSheet: !!wb.Sheets[META_SHEET],
    });
    const meta = wb.Sheets[META_SHEET];
    if (!meta) {
      console.warn('[useSpreadsheet] no meta sheet — starting empty');
      return emptyModel(projectId);
    }
    const cell = meta['A1'];
    if (!cell || typeof cell.v !== 'string') {
      console.warn('[useSpreadsheet] meta A1 missing or non-string', cell);
      return emptyModel(projectId);
    }
    const parsed = JSON.parse(cell.v) as { v?: number; model?: WorkbookModel };
    if (!parsed?.model) {
      console.warn('[useSpreadsheet] meta JSON missing model field', parsed);
      return emptyModel(projectId);
    }
    return parsed.model;
  } catch (err) {
    console.error('[useSpreadsheet] Failed to parse workbook, starting empty:', err);
    return emptyModel(projectId);
  }
}

// Serialize a WorkbookModel into xlsx bytes. One hidden meta sheet carries
// the JSON; the other sheets carry a readable copy so Excel can open it.
function writeWorkbook(model: WorkbookModel): ArrayBuffer {
  const wb = XLSX.utils.book_new();

  // Render user-visible sheets first so they appear before the meta sheet.
  const sortedSheets = [...model.sheets].sort((a, b) => a.position - b.position);
  for (const s of sortedSheets) {
    const cols = (model.columnsBySheet[s.id] ?? []).slice().sort((a, b) => a.position - b.position);
    const rows = (model.rowsBySheet[s.id] ?? []).slice().sort((a, b) => a.position - b.position);
    const aoa: any[][] = [cols.map((c) => c.name)];
    for (const r of rows) {
      aoa.push(cols.map((c) => r.data?.[c.id] ?? ''));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (cols.length > 0) {
      ws['!cols'] = cols.map((c) => ({ wpx: c.width ?? 100 }));
    }
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31) || 'Sheet');
  }

  // Hidden meta sheet with the full JSON model. Hidden so Excel users don't
  // see it; WeldFlow reads it back on load.
  const metaWs = XLSX.utils.aoa_to_sheet([[JSON.stringify({ v: META_VERSION, model })]]);
  XLSX.utils.book_append_sheet(wb, metaWs, META_SHEET);
  const idx = wb.SheetNames.indexOf(META_SHEET);
  if (idx >= 0) {
    if (!wb.Workbook) wb.Workbook = { Sheets: [] };
    if (!wb.Workbook.Sheets) wb.Workbook.Sheets = [];
    wb.Workbook.Sheets[idx] = { Hidden: 1 };
  }

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  if (out instanceof ArrayBuffer) return out;
  const u8 = out as Uint8Array;
  // Copy into a fresh ArrayBuffer to satisfy the strict ArrayBuffer return
  // type (Uint8Array.buffer is `ArrayBufferLike`).
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

// ---------------------------------------------------------------------------
// Mutation shim — the editor calls `m.mutate(args)` / `m.mutateAsync(args)`,
// exactly like a `useMutation` result. We back those with synchronous in-
// memory updates so the UI feels instant; persistence is debounced.
// ---------------------------------------------------------------------------

interface MutationLike<TArgs = void, TResult = void> {
  mutate: (args: TArgs) => void;
  mutateAsync: (args: TArgs) => Promise<TResult>;
}

function makeMutation<TArgs, TResult = void>(
  fn: (args: TArgs) => TResult,
): MutationLike<TArgs, TResult> {
  return {
    mutate: (args) => {
      try {
        fn(args);
      } catch (err) {
        console.error('[useSpreadsheet] mutation failed:', err);
      }
    },
    mutateAsync: async (args) => fn(args),
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSpreadsheet(projectId: string, fileId: string) {
  const queryClient = useQueryClient();
  const st = useTranslations();

  // Load the xlsx from R2 once. 404 (no R2 object yet) → empty workbook.
  //
  // `meta.persist: false` opts this query out of the platform's
  // `PersistQueryClientProvider` (apps/web/platform/providers/query-provider.tsx),
  // which would otherwise dehydrate the parsed workbook to localStorage and
  // hand it back on refresh — short-circuiting the GET /content fetch and
  // making freshly saved data look like it disappeared.
  const loadQuery = useQuery({
    queryKey: ['workbook', fileId],
    queryFn: async () => {
      if (!fileId) return null;
      const buf = await fetchSheetContent(fileId);
      return buf ? readWorkbook(buf, projectId) : emptyModel(projectId);
    },
    enabled: !!fileId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    meta: { persist: false },
  });

  const [model, setModel] = useState<WorkbookModel | null>(null);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // `modelRef` mirrors `model` so the auto-save closure always reads the
  // latest state. Without this the debounced setTimeout would fire with a
  // stale model captured at the moment the timer was scheduled, losing the
  // most recent edits — which is the bug that caused refresh-after-edit to
  // show empty cells.
  const modelRef = useRef<WorkbookModel | null>(null);
  const fileIdRef = useRef(fileId);
  const dirtyRef = useRef(false);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  useEffect(() => {
    fileIdRef.current = fileId;
  }, [fileId]);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Seed the in-memory model when the initial load completes.
  useEffect(() => {
    if (loadQuery.data && !model) {
      setModel(loadQuery.data);
      setActiveSheetId(loadQuery.data.sheets[0]?.id ?? null);
    }
  }, [loadQuery.data, model]);

  // Debounced auto-save. Last-write-wins: no conflict resolution for v1.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);

  // `flush` and `scheduleSave` are stable — they read fresh state from refs
  // instead of capturing it from React closures, so mutations don't churn the
  // mutation objects or risk firing a stale timer.
  const flush = useCallback(async () => {
    const current = modelRef.current;
    const currentFileId = fileIdRef.current;
    if (!current || !currentFileId) return;
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    // Mirror the in-memory model into the React Query cache *before* the
    // network round-trip. This makes a quick "navigate away → navigate back"
    // (e.g. clicking another project tab and returning) re-seed the editor
    // from the latest edits instead of the original snapshot we loaded.
    // Without this, the seed effect runs on remount and pulls stale data.
    queryClient.setQueryData(['workbook', currentFileId], current);
    try {
      const bytes = writeWorkbook(current);
      await putSheetContent(currentFileId, bytes);
      setDirty(false);
    } catch (err) {
      console.error('[useSpreadsheet] save failed:', err);
      toast.error(st('sweep.weldflow.spreadsheet.saveFailed'));
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        scheduleSave();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      flush();
    }, DEBOUNCE_MS);
  }, [flush]);

  const mutate = useCallback(
    (updater: (m: WorkbookModel) => WorkbookModel) => {
      setModel((prev) => (prev ? updater(prev) : prev));
      setDirty(true);
      scheduleSave();
    },
    [scheduleSave],
  );

  // Flush any pending save on unmount / file switch.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (dirtyRef.current) {
        flush();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  // ---------- Derived selectors -----------------------------------------
  const sheets = useMemo<SpreadsheetSheet[]>(
    () => (model ? [...model.sheets].sort((a, b) => a.position - b.position) : []),
    [model],
  );

  const effectiveSheetId =
    activeSheetId && sheets.some((s) => s.id === activeSheetId)
      ? activeSheetId
      : sheets[0]?.id ?? null;

  const columns = useMemo<SpreadsheetColumn[]>(() => {
    if (!model || !effectiveSheetId) return [];
    return [...(model.columnsBySheet[effectiveSheetId] ?? [])].sort(
      (a, b) => a.position - b.position,
    );
  }, [model, effectiveSheetId]);

  const rows = useMemo<SpreadsheetRow[]>(() => {
    if (!model || !effectiveSheetId) return [];
    return [...(model.rowsBySheet[effectiveSheetId] ?? [])].sort(
      (a, b) => a.position - b.position,
    );
  }, [model, effectiveSheetId]);

  // ---------- Sheet mutations -------------------------------------------
  const createSheet = useMemo(
    () =>
      makeMutation<string, SpreadsheetSheet | null>((name) => {
        let created: SpreadsheetSheet | null = null;
        mutate((m) => {
          const id = uid('sht');
          const now = nowIso();
          const sheet: SpreadsheetSheet = {
            id,
            projectId,
            tableId: null,
            name: name || `Sheet ${m.sheets.length + 1}`,
            position: m.sheets.length,
            settings: null,
            createdAt: now,
            updatedAt: now,
          };
          created = sheet;
          const colId = uid('scol');
          return {
            ...m,
            sheets: [...m.sheets, sheet],
            columnsBySheet: {
              ...m.columnsBySheet,
              [id]: [
                {
                  id: colId,
                  sheetId: id,
                  name: 'Column 1',
                  fieldType: 'text',
                  position: 0,
                  width: 100,
                  options: null,
                  config: null,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            },
            rowsBySheet: { ...m.rowsBySheet, [id]: [] },
          };
        });
        if (created) setActiveSheetId((created as SpreadsheetSheet).id);
        return created;
      }),
    [mutate, projectId],
  );

  const updateSheet = useMemo(
    () =>
      makeMutation<{ sheetId: string; data: { name?: string; position?: number; settings?: any } }>(
        ({ sheetId, data }) => {
          mutate((m) => ({
            ...m,
            sheets: m.sheets.map((s) =>
              s.id === sheetId ? { ...s, ...data, updatedAt: nowIso() } : s,
            ),
          }));
        },
      ),
    [mutate],
  );

  const deleteSheet = useMemo(
    () =>
      makeMutation<string>((sheetId) => {
        mutate((m) => {
          if (m.sheets.length <= 1) return m;
          const { [sheetId]: _c, ...restCols } = m.columnsBySheet;
          const { [sheetId]: _r, ...restRows } = m.rowsBySheet;
          return {
            ...m,
            sheets: m.sheets.filter((s) => s.id !== sheetId),
            columnsBySheet: restCols,
            rowsBySheet: restRows,
          };
        });
        if (activeSheetId === sheetId) setActiveSheetId(null);
      }),
    [mutate, activeSheetId],
  );

  const reorderSheets = useMemo(
    () =>
      makeMutation<string[]>((sheetIds) => {
        mutate((m) => ({
          ...m,
          sheets: m.sheets.map((s) => {
            const idx = sheetIds.indexOf(s.id);
            return idx >= 0 ? { ...s, position: idx } : s;
          }),
        }));
      }),
    [mutate],
  );

  const duplicateSheet = useMemo(
    () =>
      makeMutation<{ sheetId: string; name: string }, SpreadsheetSheet | null>(({ sheetId, name }) => {
        let created: SpreadsheetSheet | null = null;
        mutate((m) => {
          const src = m.sheets.find((s) => s.id === sheetId);
          if (!src) return m;
          const newId = uid('sht');
          const now = nowIso();
          const sheet: SpreadsheetSheet = {
            ...src,
            id: newId,
            name: name || `${src.name} (copy)`,
            position: m.sheets.length,
            createdAt: now,
            updatedAt: now,
          };
          created = sheet;
          const cols = (m.columnsBySheet[sheetId] ?? []).map((c) => ({
            ...c,
            id: uid('scol'),
            sheetId: newId,
          }));
          const colIdMap = new Map<string, string>();
          (m.columnsBySheet[sheetId] ?? []).forEach((c, i) => colIdMap.set(c.id, cols[i].id));
          const rows = (m.rowsBySheet[sheetId] ?? []).map((r) => {
            const newData: Record<string, any> = {};
            for (const [k, v] of Object.entries(r.data ?? {})) {
              const mapped = colIdMap.get(k);
              newData[mapped ?? k] = v;
            }
            return {
              ...r,
              id: uid('srow'),
              sheetId: newId,
              data: newData,
            };
          });
          return {
            ...m,
            sheets: [...m.sheets, sheet],
            columnsBySheet: { ...m.columnsBySheet, [newId]: cols },
            rowsBySheet: { ...m.rowsBySheet, [newId]: rows },
          };
        });
        if (created) setActiveSheetId((created as SpreadsheetSheet).id);
        return created;
      }),
    [mutate],
  );

  // ---------- Column mutations ------------------------------------------
  const createColumn = useMemo(
    () =>
      makeMutation<{ name: string; fieldType: string; width?: number; options?: any }>((data) => {
        if (!effectiveSheetId) return;
        mutate((m) => {
          const cols = m.columnsBySheet[effectiveSheetId] ?? [];
          const col: SpreadsheetColumn = {
            id: uid('scol'),
            sheetId: effectiveSheetId,
            name: data.name,
            fieldType: data.fieldType,
            position: cols.length,
            width: data.width ?? 100,
            options: data.options ?? null,
            config: null,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          return {
            ...m,
            columnsBySheet: { ...m.columnsBySheet, [effectiveSheetId]: [...cols, col] },
          };
        });
      }),
    [mutate, effectiveSheetId],
  );

  const updateColumn = useMemo(
    () =>
      makeMutation<{
        colId: string;
        data: { name?: string; fieldType?: string; width?: number; options?: any };
      }>(({ colId, data }) => {
        if (!effectiveSheetId) return;
        mutate((m) => ({
          ...m,
          columnsBySheet: {
            ...m.columnsBySheet,
            [effectiveSheetId]: (m.columnsBySheet[effectiveSheetId] ?? []).map((c) =>
              c.id === colId ? { ...c, ...data, updatedAt: nowIso() } : c,
            ),
          },
        }));
      }),
    [mutate, effectiveSheetId],
  );

  const deleteColumn = useMemo(
    () =>
      makeMutation<string>((colId) => {
        if (!effectiveSheetId) return;
        mutate((m) => ({
          ...m,
          columnsBySheet: {
            ...m.columnsBySheet,
            [effectiveSheetId]: (m.columnsBySheet[effectiveSheetId] ?? []).filter(
              (c) => c.id !== colId,
            ),
          },
        }));
      }),
    [mutate, effectiveSheetId],
  );

  const reorderColumns = useMemo(
    () =>
      makeMutation<string[]>((columnIds) => {
        if (!effectiveSheetId) return;
        mutate((m) => ({
          ...m,
          columnsBySheet: {
            ...m.columnsBySheet,
            [effectiveSheetId]: (m.columnsBySheet[effectiveSheetId] ?? []).map((c) => {
              const idx = columnIds.indexOf(c.id);
              return idx >= 0 ? { ...c, position: idx } : c;
            }),
          },
        }));
      }),
    [mutate, effectiveSheetId],
  );

  // ---------- Row mutations ---------------------------------------------
  const createRow = useMemo(
    () =>
      makeMutation<{ data?: Record<string, any>; position?: number } | undefined, SpreadsheetRow | null>(
        (args) => {
          let created: SpreadsheetRow | null = null;
          if (!effectiveSheetId) return null;
          mutate((m) => {
            const rows = m.rowsBySheet[effectiveSheetId] ?? [];
            // Upsert by position: when a row already occupies the requested
            // position, merge into it rather than pushing a duplicate. Several
            // callers (paste-format, convert-to-table, multi-cell toolbar
            // format) create cells column-by-column for the same new row; without
            // this they'd spawn N ghost rows at one position that collide in the
            // position→row map and corrupt the saved workbook.
            if (args?.position !== undefined) {
              const existing = rows.find((r) => r.position === args.position);
              if (existing) {
                created = existing;
                return {
                  ...m,
                  rowsBySheet: {
                    ...m.rowsBySheet,
                    [effectiveSheetId]: rows.map((r) =>
                      r.position === args.position
                        ? { ...r, data: { ...r.data, ...(args.data ?? {}) }, updatedAt: nowIso() }
                        : r,
                    ),
                  },
                };
              }
            }
            const maxPos = rows.reduce((acc, r) => Math.max(acc, r.position), -1);
            const row: SpreadsheetRow = {
              id: uid('srow'),
              sheetId: effectiveSheetId,
              position: args?.position ?? maxPos + 1,
              data: args?.data ?? {},
              createdAt: nowIso(),
              updatedAt: nowIso(),
            };
            created = row;
            return {
              ...m,
              rowsBySheet: { ...m.rowsBySheet, [effectiveSheetId]: [...rows, row] },
            };
          });
          return created;
        },
      ),
    [mutate, effectiveSheetId],
  );

  const updateRow = useMemo(
    () =>
      makeMutation<{ rowId: string; data: { data?: Record<string, any>; position?: number } }>(
        ({ rowId, data }) => {
          if (!effectiveSheetId) return;
          mutate((m) => ({
            ...m,
            rowsBySheet: {
              ...m.rowsBySheet,
              [effectiveSheetId]: (m.rowsBySheet[effectiveSheetId] ?? []).map((r) =>
                r.id === rowId
                  ? {
                      ...r,
                      ...(data.position !== undefined ? { position: data.position } : {}),
                      ...(data.data !== undefined
                        ? { data: { ...r.data, ...data.data } }
                        : {}),
                      updatedAt: nowIso(),
                    }
                  : r,
              ),
            },
          }));
        },
      ),
    [mutate, effectiveSheetId],
  );

  const deleteRow = useMemo(
    () =>
      makeMutation<string>((rowId) => {
        if (!effectiveSheetId) return;
        mutate((m) => ({
          ...m,
          rowsBySheet: {
            ...m.rowsBySheet,
            [effectiveSheetId]: (m.rowsBySheet[effectiveSheetId] ?? []).filter(
              (r) => r.id !== rowId,
            ),
          },
        }));
      }),
    [mutate, effectiveSheetId],
  );

  const bulkDeleteRows = useMemo(
    () =>
      makeMutation<string[]>((ids) => {
        if (!effectiveSheetId) return;
        const idSet = new Set(ids);
        mutate((m) => ({
          ...m,
          rowsBySheet: {
            ...m.rowsBySheet,
            [effectiveSheetId]: (m.rowsBySheet[effectiveSheetId] ?? []).filter(
              (r) => !idSet.has(r.id),
            ),
          },
        }));
      }),
    [mutate, effectiveSheetId],
  );

  const reorderRows = useMemo(
    () =>
      makeMutation<string[]>((rowIds) => {
        if (!effectiveSheetId) return;
        mutate((m) => ({
          ...m,
          rowsBySheet: {
            ...m.rowsBySheet,
            [effectiveSheetId]: (m.rowsBySheet[effectiveSheetId] ?? []).map((r) => {
              const idx = rowIds.indexOf(r.id);
              return idx >= 0 ? { ...r, position: idx } : r;
            }),
          },
        }));
      }),
    [mutate, effectiveSheetId],
  );

  // ---------- Structural mutations (position-aware) ----------------------
  // These power the right-click "Insert / Delete row|column|cells" actions.
  // They shift the `position` field so the grid (which renders by position /
  // sorted index) pulls rows up / pushes columns over like a real sheet.

  // Insert a blank row at `position`: everything at or below shifts down one.
  const insertRowAt = useMemo(
    () =>
      makeMutation<{ position: number }>(({ position }) => {
        if (!effectiveSheetId) return;
        mutate((m) => ({
          ...m,
          rowsBySheet: {
            ...m.rowsBySheet,
            [effectiveSheetId]: (m.rowsBySheet[effectiveSheetId] ?? []).map((r) =>
              r.position >= position ? { ...r, position: r.position + 1 } : r,
            ),
          },
        }));
      }),
    [mutate, effectiveSheetId],
  );

  // Delete the row at `position`: everything below pulls up one.
  const deleteRowAt = useMemo(
    () =>
      makeMutation<{ position: number }>(({ position }) => {
        if (!effectiveSheetId) return;
        mutate((m) => ({
          ...m,
          rowsBySheet: {
            ...m.rowsBySheet,
            [effectiveSheetId]: (m.rowsBySheet[effectiveSheetId] ?? [])
              .filter((r) => r.position !== position)
              .map((r) => (r.position > position ? { ...r, position: r.position - 1 } : r)),
          },
        }));
      }),
    [mutate, effectiveSheetId],
  );

  // Insert a new column at sorted-array index `index` (i.e. to the left of the
  // column currently occupying that slot). Columns at or after it shift right.
  const insertColumnAt = useMemo(
    () =>
      makeMutation<{ index: number; name?: string; fieldType?: string }>(({ index, name, fieldType }) => {
        if (!effectiveSheetId) return;
        mutate((m) => {
          const cols = [...(m.columnsBySheet[effectiveSheetId] ?? [])].sort(
            (a, b) => a.position - b.position,
          );
          const insertPos = index >= 0 && index < cols.length ? cols[index].position : cols.length;
          const now = nowIso();
          const newCol: SpreadsheetColumn = {
            id: uid('scol'),
            sheetId: effectiveSheetId,
            name: name || `Column ${cols.length + 1}`,
            fieldType: fieldType || 'text',
            position: insertPos,
            width: 100,
            options: null,
            config: null,
            createdAt: now,
            updatedAt: now,
          };
          const shifted = (m.columnsBySheet[effectiveSheetId] ?? []).map((c) =>
            c.position >= insertPos ? { ...c, position: c.position + 1 } : c,
          );
          return {
            ...m,
            columnsBySheet: {
              ...m.columnsBySheet,
              [effectiveSheetId]: [...shifted, newCol],
            },
          };
        });
      }),
    [mutate, effectiveSheetId],
  );

  // Delete the column at sorted-array index `index`. Columns after it shift left.
  const deleteColumnAt = useMemo(
    () =>
      makeMutation<{ index: number }>(({ index }) => {
        if (!effectiveSheetId) return;
        mutate((m) => {
          const cols = [...(m.columnsBySheet[effectiveSheetId] ?? [])].sort(
            (a, b) => a.position - b.position,
          );
          const target = cols[index];
          if (!target) return m;
          return {
            ...m,
            columnsBySheet: {
              ...m.columnsBySheet,
              [effectiveSheetId]: (m.columnsBySheet[effectiveSheetId] ?? [])
                .filter((c) => c.id !== target.id)
                .map((c) => (c.position > target.position ? { ...c, position: c.position - 1 } : c)),
            },
          };
        });
      }),
    [mutate, effectiveSheetId],
  );

  // Insert/delete cells within `colIds`, shifting the affected columns'
  // values vertically. `anchorPos` is the first row of the selection,
  // `count` its height. Other columns are untouched (Google-Sheets semantics).
  // Note: only the plain cell value moves; per-cell format/rich-text keys stay
  // with their row position (acceptable for v1).
  const shiftCellsVertical = useMemo(
    () =>
      makeMutation<{ colIds: string[]; anchorPos: number; count: number; mode: 'insert' | 'delete' }>(
        ({ colIds, anchorPos, count, mode }) => {
          if (!effectiveSheetId || colIds.length === 0 || count <= 0) return;
          mutate((m) => {
            const sid = effectiveSheetId;
            const rowsArr = m.rowsBySheet[sid] ?? [];
            const maxPos = rowsArr.reduce((a, r) => Math.max(a, r.position), -1);
            const snap = new Map<string, any>();
            for (const r of rowsArr) {
              for (const cid of colIds) {
                if (r.data && cid in r.data) snap.set(`${r.position}|${cid}`, r.data[cid]);
              }
            }
            const srcVal = (pos: number, cid: string) => {
              if (mode === 'insert') {
                if (pos < anchorPos) return snap.get(`${pos}|${cid}`);
                if (pos < anchorPos + count) return undefined;
                return snap.get(`${pos - count}|${cid}`);
              }
              if (pos < anchorPos) return snap.get(`${pos}|${cid}`);
              return snap.get(`${pos + count}|${cid}`);
            };
            const limit = mode === 'insert' ? maxPos + count : maxPos;
            const rowMap = new Map(rowsArr.map((r) => [r.position, { ...r, data: { ...r.data } }]));
            for (let pos = anchorPos; pos <= limit; pos++) {
              for (const cid of colIds) {
                const v = srcVal(pos, cid);
                let row = rowMap.get(pos);
                if (v === undefined || v === null || v === '') {
                  if (row) delete row.data[cid];
                  continue;
                }
                if (!row) {
                  const now = nowIso();
                  row = { id: uid('srow'), sheetId: sid, position: pos, data: {}, createdAt: now, updatedAt: now };
                  rowMap.set(pos, row);
                }
                row.data[cid] = v;
              }
            }
            return { ...m, rowsBySheet: { ...m.rowsBySheet, [sid]: Array.from(rowMap.values()) } };
          });
        },
      ),
    [mutate, effectiveSheetId],
  );

  // Insert/delete cells shifting horizontally within rows [minRow..maxRow].
  // `orderedColIds` is every column id sorted by position; `anchorIndex` is the
  // selection's left edge, `count` its width. Values pushed past the last
  // column are dropped.
  const shiftCellsHorizontal = useMemo(
    () =>
      makeMutation<{
        orderedColIds: string[];
        anchorIndex: number;
        count: number;
        minRow: number;
        maxRow: number;
        mode: 'insert' | 'delete';
      }>(({ orderedColIds, anchorIndex, count, minRow, maxRow, mode }) => {
        if (!effectiveSheetId || orderedColIds.length === 0 || count <= 0) return;
        mutate((m) => {
          const sid = effectiveSheetId;
          const len = orderedColIds.length;
          return {
            ...m,
            rowsBySheet: {
              ...m.rowsBySheet,
              [sid]: (m.rowsBySheet[sid] ?? []).map((r) => {
                if (r.position < minRow || r.position > maxRow) return r;
                const data = { ...r.data };
                const before: Record<string, any> = {};
                for (const cid of orderedColIds) before[cid] = data[cid];
                for (let i = anchorIndex; i < len; i++) {
                  const cid = orderedColIds[i];
                  let srcIdx: number;
                  if (mode === 'insert') srcIdx = i - count;
                  else srcIdx = i + count;
                  const srcVal = srcIdx >= anchorIndex && srcIdx < len ? before[orderedColIds[srcIdx]] : undefined;
                  if (srcVal === undefined || srcVal === null || srcVal === '') delete data[cid];
                  else data[cid] = srcVal;
                }
                return { ...r, data, updatedAt: nowIso() };
              }),
            },
          };
        });
      }),
    [mutate, effectiveSheetId],
  );

  // Merge a partial settings object onto a sheet (used by Convert-to-table and
  // the column filter, which persist their state in sheet.settings).
  const updateSheetSettings = useMemo(
    () =>
      makeMutation<{ sheetId: string; settings: Record<string, any> }>(({ sheetId, settings }) => {
        mutate((m) => ({
          ...m,
          sheets: m.sheets.map((s) =>
            s.id === sheetId
              ? { ...s, settings: { ...(s.settings ?? {}), ...settings }, updatedAt: nowIso() }
              : s,
          ),
        }));
      }),
    [mutate],
  );

  return {
    // Data
    sheets,
    columns,
    rows,
    activeSheetId: effectiveSheetId,
    setActiveSheetId,

    // Loading
    isLoadingSheets: loadQuery.isLoading,
    isLoadingColumns: loadQuery.isLoading,
    isLoadingRows: loadQuery.isLoading,

    // Save state
    isDirty: dirty,

    // Sheet mutations
    createSheet,
    updateSheet,
    deleteSheet,
    reorderSheets,
    duplicateSheet,

    // Column mutations
    createColumn,
    updateColumn,
    deleteColumn,
    reorderColumns,

    // Row mutations
    createRow,
    updateRow,
    deleteRow,
    bulkDeleteRows,
    reorderRows,

    // Structural mutations
    insertRowAt,
    deleteRowAt,
    insertColumnAt,
    deleteColumnAt,
    shiftCellsVertical,
    shiftCellsHorizontal,

    // Sheet settings (tables + filters live here)
    updateSheetSettings,
    activeSheetSettings: (sheets.find((s) => s.id === effectiveSheetId)?.settings ?? null) as
      | SheetSettings
      | null,
  };
}

// Persisted-in-settings descriptors for the in-sheet table + column filter.
export interface TableDescriptor {
  headerRow: number;
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

export interface FilterDescriptor {
  active: boolean;
  headerRow: number;
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
  /** colId -> the list of allowed display values; a column absent here = unfiltered */
  criteria: Record<string, string[]>;
}

export interface MergeRange {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

export interface SheetSettings {
  table?: TableDescriptor;
  filter?: FilterDescriptor;
  merges?: MergeRange[];
  [key: string]: any;
}
