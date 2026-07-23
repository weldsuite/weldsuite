import { useState, useCallback, useEffect, useRef } from "react";
import { useI18n } from "@/lib/i18n/provider";
import { Check, ChevronRight, ChevronsUpDown, Download, FileSpreadsheet, Loader2, AlertCircle, CheckCircle2, XCircle, UploadIcon } from "lucide-react";
import * as XLSX from "xlsx";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Badge } from "@weldsuite/ui/components/badge";
import { Button } from "@weldsuite/ui/components/button";
import { Progress } from "@weldsuite/ui/components/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@weldsuite/ui/components/dropdown-menu";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@weldsuite/ui/components/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@weldsuite/ui/components/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@weldsuite/ui/components/popover";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@weldsuite/ui/components/alert";
import { ScrollArea } from "@weldsuite/ui/components/scroll-area";
import { Dropzone } from "@weldsuite/ui/components/dropzone";
import { useAppApiClient } from "@/lib/api/use-app-api";

// Task fields that can be mapped to. `key` is the external id used to upsert
// existing tasks (matches tasks.key in the DB).
const TASK_FIELDS = [
  { header: "Key", accessorKey: "key", description: "External code for updating existing tasks" },
  { header: "Title", accessorKey: "title", description: "Task title (required)", required: true },
  { header: "Description", accessorKey: "description", description: "Task description" },
  { header: "Status", accessorKey: "status", description: "todo, in_progress, in_review, done, cancelled" },
  { header: "Stage", accessorKey: "stageName", description: "Pipeline stage name (matched case-insensitively)" },
  { header: "Priority", accessorKey: "priority", description: "critical, high, medium, low, none" },
  { header: "Type", accessorKey: "type", description: "task, bug, story, epic, feature, improvement, subtask" },
  { header: "Assignee Email", accessorKey: "assigneeEmail", description: "Email of a workspace member" },
  { header: "Start Date", accessorKey: "startDate", description: "ISO date (YYYY-MM-DD)" },
  { header: "Due Date", accessorKey: "dueDate", description: "ISO date (YYYY-MM-DD)" },
  { header: "Estimated Hours", accessorKey: "estimatedHours", description: "Decimal hours (e.g. 4.5)" },
  { header: "Tags", accessorKey: "tags", description: "Comma-separated tags" },
  { header: "Labels", accessorKey: "labels", description: "Comma-separated labels" },
];

interface Column {
  header: string;
  accessorKey: string;
  description?: string;
  required?: boolean;
}

function normalizeString(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

const TEMPLATE_EXAMPLE_1: Record<string, string> = {
  key: "",
  title: "Set up project repository",
  description: "Create the GitHub repo and configure CI",
  status: "todo",
  stageName: "Backlog",
  priority: "high",
  type: "task",
  assigneeEmail: "alex@example.com",
  startDate: "2026-05-01",
  dueDate: "2026-05-05",
  estimatedHours: "4",
  tags: "infra,setup",
  labels: "phase-1",
};

const TEMPLATE_EXAMPLE_2: Record<string, string> = {
  key: "",
  title: "Design login screen",
  description: "Wireframes + final mocks in Figma",
  status: "in_progress",
  stageName: "In Progress",
  priority: "medium",
  type: "story",
  assigneeEmail: "sam@example.com",
  startDate: "",
  dueDate: "2026-05-10",
  estimatedHours: "8",
  tags: "design",
  labels: "ui",
};

function getTemplateRows(): { headers: string[]; rows: string[][] } {
  const headers = TASK_FIELDS.map((f) => f.header);
  const row1 = TASK_FIELDS.map((f) => TEMPLATE_EXAMPLE_1[f.accessorKey] ?? "");
  const row2 = TASK_FIELDS.map((f) => TEMPLATE_EXAMPLE_2[f.accessorKey] ?? "");
  return { headers, rows: [row1, row2] };
}

function buildTemplateCsv(): string {
  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const { headers, rows } = getTemplateRows();
  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}

function buildTemplateXlsx(): ArrayBuffer {
  const { headers, rows } = getTemplateRows();
  const aoa = [headers, ...rows];
  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Tasks");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}

function safeString(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  try {
    return String(value).trim();
  } catch {
    return "";
  }
}

interface FieldComboboxProps {
  columns: Column[];
  value: string;
  onValueChange: (value: string) => void;
  onFocus: () => void;
  usedFields: Set<string>;
}

const FieldCombobox = ({
  columns,
  value,
  onValueChange,
  onFocus,
  usedFields,
}: FieldComboboxProps) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedColumn = columns.find((col) => col.accessorKey === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild onClick={onFocus}>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between h-9"
        >
          <span className="truncate">
            {selectedColumn ? selectedColumn.header : t.projects.settings.skipThisColumn}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0 w-[250px]"
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        <Command className="[&_[cmdk-group]]:pr-0">
          <CommandInput
            placeholder={t.projects.settings.searchFields}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>{t.projects.settings.noFieldFound}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__skip__"
                onSelect={() => {
                  onValueChange("");
                  setOpen(false);
                }}
                className={cn(value === "" && "bg-accent text-accent-foreground")}
              >
                <span className="text-muted-foreground">{t.projects.settings.skipThisColumn}</span>
                <Check className={cn("size-4 ml-auto", value !== "" && "opacity-0")} />
              </CommandItem>
              {columns.map((column) => {
                const isUsed = usedFields.has(column.accessorKey) && value !== column.accessorKey;
                const isSelected = value === column.accessorKey;
                return (
                  <CommandItem
                    key={column.accessorKey}
                    value={column.accessorKey}
                    onSelect={(currentValue) => {
                      onValueChange(currentValue === value ? "" : currentValue);
                      setOpen(false);
                    }}
                    disabled={isUsed}
                    className={cn(
                      isUsed && "opacity-50",
                      isSelected && "bg-accent text-accent-foreground"
                    )}
                  >
                    <div className="flex flex-col">
                      <span className="flex items-center gap-1">
                        {column.header}
                        {column.required && <span className="text-red-500">*</span>}
                      </span>
                      {column.description && (
                        <span className="text-xs text-muted-foreground">{column.description}</span>
                      )}
                    </div>
                    {isUsed && <span className="ml-auto text-xs text-muted-foreground">{t.projects.settings.usedBadge}</span>}
                    <Check
                      className={cn(
                        "size-4",
                        !isUsed && "ml-auto",
                        value !== column.accessorKey && "opacity-0"
                      )}
                    />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

interface DataPreviewListProps {
  currentFocusedField: string | null;
  data: Record<string, any>[];
}

const DataPreviewList = ({ currentFocusedField, data }: DataPreviewListProps) => {
  const { t } = useI18n();
  if (!currentFocusedField || data.length === 0) return null;

  const previewData = data.slice(0, 5);

  return (
    <div className="space-y-2 border bg-background p-4 pb-1 rounded-md">
      <p className="text-sm font-semibold">
        {t.projects.settings.sampleValuesFor.replace('{field}', currentFocusedField)}
      </p>
      <ul>
        {previewData.map((item, index) => {
          const value = safeString(item[currentFocusedField]);
          return (
            <li
              key={index}
              className="border-b py-3 text-sm first:border-t last:border-b-0 truncate"
            >
              {value || <span className="text-muted-foreground italic">{t.projects.settings.emptyValue}</span>}
            </li>
          );
        })}
      </ul>
      {data.length > 5 && (
        <p className="text-xs text-muted-foreground">
          {t.projects.settings.andMoreRows.replace('{n}', String(data.length - 5))}
        </p>
      )}
    </div>
  );
};

interface ImportResult {
  imported: number;
  updated: number;
  failed: number;
  total: number;
  errors?: { row: number; title: string; error: string }[];
}

interface JobStatus {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  total: number;
  processed: number;
  imported: number;
  updated: number;
  failed: number;
  errors?: { row: number; title: string; error: string }[];
  errorMessage?: string | null;
}

interface ImportTasksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

export function ImportTasksDialog({ open, onOpenChange, projectId }: ImportTasksDialogProps) {
  const { t } = useI18n();
  const { getClient } = useAppApiClient();
  const [step, setStep] = useState<"upload" | "mapping" | "running" | "result">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [parsedData, setParsedData] = useState<Record<string, any>[]>([]);
  const [sourceColumns, setSourceColumns] = useState<string[]>([]);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [currentFocusedField, setCurrentFocusedField] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const triggerDownload = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleDownloadTemplateCsv = useCallback(() => {
    try {
      const csv = buildTemplateCsv();
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      triggerDownload(blob, "tasks_import_template.csv");
      toast.success(t.projects.settings.templateDownloaded);
    } catch (err) {
      console.error("[Import] CSV template error:", err);
      toast.error(t.projects.settings.failedToDownloadTemplate);
    }
  }, [triggerDownload, t]);

  const handleDownloadTemplateXlsx = useCallback(() => {
    try {
      const buffer = buildTemplateXlsx();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      triggerDownload(blob, "tasks_import_template.xlsx");
      toast.success(t.projects.settings.templateDownloaded);
    } catch (err) {
      console.error("[Import] XLSX template error:", err);
      toast.error(t.projects.settings.failedToDownloadTemplate);
    }
  }, [triggerDownload, t]);

  const usedFields = new Set(Object.values(mappings).filter(Boolean));

  const resetState = useCallback(() => {
    stopPolling();
    setStep("upload");
    setFile(null);
    setParsedData([]);
    setSourceColumns([]);
    setMappings({});
    setCurrentFocusedField(null);
    setParseError(null);
    setImportResult(null);
    setJobStatus(null);
  }, [stopPolling]);

  const parseFile = useCallback((file: File) => {
    setParseError(null);
    setFile(file);

    const reader = new FileReader();

    reader.onerror = () => {
      console.error("[Import] FileReader error:", reader.error);
      setParseError(t.projects.settings.fileReadError);
      setFile(null);
    };

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        if (!data) {
          throw new Error("No data read from file");
        }

        const workbook = XLSX.read(data, {
          type: "binary",
          cellDates: true,
          cellNF: false,
          cellText: false,
        });

        if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
          throw new Error("The file contains no sheets");
        }

        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        if (!worksheet) {
          throw new Error("Could not read the first sheet");
        }

        const jsonData = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet, {
          raw: false,
          defval: "",
          blankrows: false,
        });

        if (jsonData.length === 0) {
          setParseError(t.projects.settings.fileEmpty);
          setFile(null);
          return;
        }

        if (jsonData.length > 50000) {
          setParseError(t.projects.settings.fileTooManyRows);
          setFile(null);
          return;
        }

        const columns = Object.keys(jsonData[0]).filter((col) => col && col.trim());

        if (columns.length === 0) {
          setParseError(t.projects.settings.fileNoColumns);
          setFile(null);
          return;
        }

        setSourceColumns(columns);
        setParsedData(jsonData);

        const autoMappings: Record<string, string> = {};
        const usedAutoFields = new Set<string>();

        columns.forEach((col) => {
          const normalizedCol = normalizeString(col);

          const matchingField = TASK_FIELDS.find((field) => {
            if (usedAutoFields.has(field.accessorKey)) return false;
            const normalizedAccessor = normalizeString(field.accessorKey);
            const normalizedHeader = normalizeString(field.header);
            return (
              normalizedAccessor === normalizedCol ||
              normalizedHeader === normalizedCol ||
              normalizedAccessor.includes(normalizedCol) ||
              normalizedCol.includes(normalizedAccessor)
            );
          });

          if (matchingField) {
            autoMappings[col] = matchingField.accessorKey;
            usedAutoFields.add(matchingField.accessorKey);
          }
        });

        setMappings(autoMappings);
        setStep("mapping");
      } catch (error) {
        console.error("[Import] Parse error:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        setParseError(t.projects.settings.fileParseError.replace('{error}', errorMessage));
        setFile(null);
      }
    };

    reader.readAsBinaryString(file);
  }, [t]);

  const handleMappingChange = (sourceField: string, destField: string) => {
    setMappings((prev) => ({
      ...prev,
      [sourceField]: destField,
    }));
  };

  const handleImport = async () => {
    const titleMapping = Object.entries(mappings).find(([, dest]) => dest === "title");
    if (!titleMapping) {
      toast.error(t.projects.settings.titleFieldRequired);
      return;
    }

    const titleSourceField = titleMapping[0];

    const transformedData: Record<string, any>[] = [];
    const skippedRows: { row: number; reason: string }[] = [];

    parsedData.forEach((row, index) => {
      const rowNum = index + 2;

      try {
        const task: Record<string, any> = {};
        const title = safeString(row[titleSourceField]);

        if (!title) {
          skippedRows.push({ row: rowNum, reason: "Missing title" });
          return;
        }

        task.title = title;

        Object.entries(mappings).forEach(([sourceField, destField]) => {
          if (!destField || destField === "title") return;

          const value = safeString(row[sourceField]);
          if (!value) return;

          if (destField === "tags" || destField === "labels") {
            const arr = value.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
            if (arr.length > 0) task[destField] = arr;
          } else {
            task[destField] = value;
          }
        });

        transformedData.push(task);
      } catch (rowError) {
        console.error(`[Import] Error processing row ${rowNum}:`, rowError);
        skippedRows.push({ row: rowNum, reason: "Processing error" });
      }
    });

    if (transformedData.length === 0) {
      toast.error(t.projects.settings.noValidTasks);
      if (skippedRows.length > 0) {
        toast.error(t.projects.settings.rowsSkippedValidation.replace('{n}', String(skippedRows.length)));
      }
      return;
    }

    if (skippedRows.length > 0) {
      toast.warning(t.projects.settings.rowsSkippedWarning.replace('{n}', String(skippedRows.length)));
    }

    setIsImporting(true);

    try {
      // app-api envelope: `{ data: … }` (201) — no `success` flag. Non-2xx
      // throws an ApiError, which the surrounding catch handles.
      const client = await getClient();
      const result = await client.post<{
        data: { jobId: string; total: number; status: string };
      }>(`/projects/${projectId}/tasks/import-jobs`, {
        tasks: transformedData,
      });

      if (!result.data?.jobId) {
        toast.error(t.projects.settings.failedToStartImport);
        setIsImporting(false);
        return;
      }

      const { jobId, total } = result.data;

      setJobStatus({
        jobId,
        status: "queued",
        total,
        processed: 0,
        imported: 0,
        updated: 0,
        failed: 0,
        errors: [],
      });
      setStep("running");

      stopPolling();
      pollingRef.current = setInterval(async () => {
        try {
          // Re-resolve per tick: an import can outlive the current Clerk
          // token, and a captured client would keep sending the stale one.
          const pollClient = await getClient();
          const poll = await pollClient.get<{ data: JobStatus }>(
            `/projects/${projectId}/tasks/import-jobs/${jobId}`,
          );
          if (!poll.data) return;
          const job = poll.data;
          setJobStatus(job);

          if (job.status === "completed" || job.status === "failed") {
            stopPolling();
            const importData: ImportResult = {
              imported: job.imported,
              updated: job.updated,
              failed: job.failed,
              total: job.total,
              errors: job.errors,
            };
            setImportResult(importData);
            setStep("result");
            setIsImporting(false);

            if (job.status === "failed") {
              toast.error(job.errorMessage || t.projects.settings.failedToStartImport);
            } else {
              const successCount = job.imported + job.updated;
              if (job.failed === 0) {
                const parts: string[] = [];
                if (job.imported > 0) parts.push(`${job.imported} ${t.projects.settings.importedLabel.toLowerCase()}`);
                if (job.updated > 0) parts.push(`${job.updated} ${t.projects.settings.updatedLabel.toLowerCase()}`);
                toast.success(t.projects.settings.importSuccessAll.replace('{parts}', parts.join(", ") || t.projects.settings.processedLabel.toLowerCase()));
              } else if (successCount > 0) {
                toast.warning(
                  t.projects.settings.importSuccessPartial
                    .replace('{success}', String(successCount))
                    .replace('{total}', String(job.total))
                    .replace('{failed}', String(job.failed)),
                );
              } else {
                toast.error(t.projects.settings.importAllFailed.replace('{failed}', String(job.failed)));
              }
            }
          }
        } catch (pollErr: any) {
          console.error("[Import] Poll error:", pollErr);
        }
      }, 1500);
    } catch (error: any) {
      console.error("[Import] Import error:", error);
      toast.error(error.message || t.projects.settings.importFailedFallback);
      setIsImporting(false);
    }
  };

  const handleClose = () => {
    stopPolling();
    if (step === "running") {
      toast.info(t.projects.settings.importRunningBackground);
    }
    setIsImporting(false);
    onOpenChange(false);
    setTimeout(resetState, 200);
  };

  const mappedFieldsCount = Object.values(mappings).filter(Boolean).length;
  const hasTitleMapping = Object.values(mappings).includes("title");
  const validRowsCount = parsedData.filter((row) => {
    const titleField = Object.entries(mappings).find(([, dest]) => dest === "title")?.[0];
    if (!titleField) return false;
    return !!safeString(row[titleField]);
  }).length;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className={cn(
          "overflow-hidden p-0",
          step === "mapping"
            ? "md:!max-w-3xl lg:!max-w-5xl"
            : "md:!max-w-lg lg:!max-w-2xl"
        )}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t.projects.settings.importDialogTitle}</DialogTitle>
          <DialogDescription>
            {t.projects.settings.importDialogDesc}
          </DialogDescription>
        </DialogHeader>

        {step === "upload" && (
          <div className="px-6 pt-3.5 pb-6">
            <h3 className="text-lg font-semibold mb-4">{t.projects.settings.importTasksHeading}</h3>

            {parseError && (
              <Alert variant="destructive" className="mb-4">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>{t.projects.settings.errorTitle}</AlertTitle>
                <AlertDescription>{parseError}</AlertDescription>
              </Alert>
            )}

            <Dropzone
              accept={{
                "text/csv": [".csv"],
                "application/vnd.ms-excel": [".xls"],
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
              }}
              maxFiles={1}
              multiple={false}
              onDrop={(accepted, rejected) => {
                if (rejected.length > 0) {
                  setParseError(t.projects.settings.invalidFileType);
                  return;
                }
                if (accepted[0]) parseFile(accepted[0]);
              }}
              className="py-12"
            >
              <div className="flex flex-col items-center gap-3 text-center">
                <UploadIcon className="size-6 text-muted-foreground" />
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">{t.projects.settings.dropFileHere}</p>
                  <p className="text-muted-foreground text-xs">
                    {t.projects.settings.dropFileFormats}
                  </p>
                </div>
              </div>
            </Dropzone>

            <div className="mt-4 p-4 bg-muted rounded-lg">
              <h4 className="font-medium mb-2">{t.projects.settings.importTipsHeading}</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>{t.projects.settings.tip1}</li>
                <li>{t.projects.settings.tip2}</li>
                <li>{t.projects.settings.tip3}</li>
                <li>{t.projects.settings.tip4}</li>
                <li>{t.projects.settings.tip5}</li>
                <li>{t.projects.settings.tip6}</li>
              </ul>
            </div>

            <div className="mt-4">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full flex items-center gap-3 rounded-lg border border-border bg-background hover:bg-accent transition-colors px-4 py-3 text-left"
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted shrink-0">
                      <Download className="h-4 w-4 text-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground">
                        {t.projects.settings.downloadTemplate}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t.projects.settings.downloadTemplateDesc}
                      </div>
                    </div>
                    <ChevronsUpDown className="h-4 w-4 text-muted-foreground shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[--radix-dropdown-menu-trigger-width]">
                  <DropdownMenuItem onClick={handleDownloadTemplateXlsx}>
                    <FileSpreadsheet className="h-4 w-4 mr-0.5" />
                    Excel (.xlsx)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleDownloadTemplateCsv}>
                    <FileSpreadsheet className="h-4 w-4 mr-0.5" />
                    CSV (.csv)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}

        {step === "mapping" && (
          <div>
            <div className="border-b px-6 py-4">
              <h3 className="text-lg font-semibold">{t.projects.settings.configureMappingHeading}</h3>
            </div>

            <div className="grid md:grid-cols-9">
              {/* Left column — white. No horizontal padding on this wrapper so
                  the ScrollArea (and therefore the scrollbar) reaches the
                  exact right edge of the column. */}
              <div className="col-span-5 pt-6">
                {/* Header + alerts get their own px-6 wrapper */}
                <div className="px-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold">
                      {t.projects.settings.matchSourceColumns}
                    </p>
                    <Badge variant="outline" className="rounded font-mono text-[12px]">
                      {t.projects.settings.mappedOf.replace('{mapped}', String(mappedFieldsCount)).replace('{total}', String(sourceColumns.length))}
                    </Badge>
                  </div>

                  {!hasTitleMapping && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>{t.projects.settings.titleRequired}</AlertTitle>
                      <AlertDescription>
                        {t.projects.settings.titleRequiredDesc}
                      </AlertDescription>
                    </Alert>
                  )}

                  {hasTitleMapping && validRowsCount < parsedData.length && (
                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>{t.projects.settings.someRowsSkipped}</AlertTitle>
                      <AlertDescription>
                        {t.projects.settings.someRowsSkippedDesc.replace('{n}', String(parsedData.length - validRowsCount))}
                      </AlertDescription>
                    </Alert>
                  )}
                </div>

                {/* ScrollArea spans the full width of col-span-5. Inner content
                    has its own px-6 so rows aren't flush against either edge. */}
                <ScrollArea className="h-[400px] mt-4 [&_[data-slot=scroll-area-scrollbar]>div]:bg-border/60">
                  <div className="px-6 pb-6 space-y-4">
                    <div className="grid grid-cols-2 gap-4 text-xs font-semibold text-muted-foreground uppercase sticky top-0 bg-background py-2">
                      <p>{t.projects.settings.sourceColumns}</p>
                      <p>{t.projects.settings.taskFields}</p>
                    </div>

                    <ul className="space-y-3">
                      {sourceColumns.map((col) => (
                        <li key={col} className="grid grid-cols-2 gap-4 items-center">
                          <div className="flex items-center justify-between">
                            <Badge variant="outline" className="rounded font-mono text-[12px] max-w-[150px] truncate">
                              {col}
                            </Badge>
                            <ChevronRight className="size-4 text-muted-foreground flex-shrink-0" />
                          </div>
                          <FieldCombobox
                            columns={TASK_FIELDS}
                            value={mappings[col] || ""}
                            onValueChange={(value) => handleMappingChange(col, value)}
                            onFocus={() => setCurrentFocusedField(col)}
                            usedFields={usedFields}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                </ScrollArea>
              </div>

              {/* Right column — gray preview panel, sits flush against the
                  white column (no grid gap). */}
              <div className="col-span-4 hidden bg-muted p-6 md:block">
                <DataPreviewList
                  currentFocusedField={currentFocusedField}
                  data={parsedData}
                />
                {!currentFocusedField && (
                  <div className="text-sm text-muted-foreground text-center py-8">
                    {t.projects.settings.previewHint}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 border-t px-6 py-4">
              <p className="font-mono text-sm text-muted-foreground truncate min-w-0">
                {t.projects.settings.fileStats
                  .replace('{name}', file?.name ?? '')
                  .replace('{rows}', String(parsedData.length))
                  .replace('{valid}', String(validRowsCount))}
              </p>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button variant="outline" onClick={() => { resetState(); }}>
                  {t.projects.settings.backBtn}
                </Button>
                <Button
                  disabled={!hasTitleMapping || validRowsCount === 0 || isImporting}
                  onClick={handleImport}
                >
                  {isImporting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                      {t.projects.settings.importingBtn}
                    </>
                  ) : (
                    <>{t.projects.settings.importNTasksBtn.replace('{n}', String(validRowsCount))}</>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}

        {step === "running" && jobStatus && (
          <div className="p-6">
            <div className="mb-6">
              <h3 className="text-lg font-semibold">{t.projects.settings.importingTasksHeading}</h3>
            </div>

            <div className="space-y-6">
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                <div className="flex-1">
                  <p className="text-sm font-medium">
                    {jobStatus.status === "queued" && t.projects.settings.startingImport}
                    {jobStatus.status === "running" &&
                      t.projects.settings.importingProgress
                        .replace('{processed}', jobStatus.processed.toLocaleString())
                        .replace('{total}', jobStatus.total.toLocaleString())}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t.projects.settings.importContinuesBackground}
                  </p>
                </div>
              </div>

              <Progress
                value={
                  jobStatus.total > 0
                    ? Math.round((jobStatus.processed / jobStatus.total) * 100)
                    : 0
                }
              />

              <div className="grid grid-cols-4 gap-4 text-center">
                <div className="p-3 border rounded-md">
                  <p className="text-2xl font-bold text-green-600">{jobStatus.imported}</p>
                  <p className="text-xs text-muted-foreground">{t.projects.settings.importedLabel}</p>
                </div>
                <div className="p-3 border rounded-md">
                  <p className="text-2xl font-bold text-blue-600">{jobStatus.updated}</p>
                  <p className="text-xs text-muted-foreground">{t.projects.settings.updatedLabel}</p>
                </div>
                <div className="p-3 border rounded-md">
                  <p className="text-2xl font-bold text-red-600">{jobStatus.failed}</p>
                  <p className="text-xs text-muted-foreground">{t.projects.settings.failedLabel}</p>
                </div>
                <div className="p-3 border rounded-md">
                  <p className="text-2xl font-bold">{jobStatus.processed}</p>
                  <p className="text-xs text-muted-foreground">{t.projects.settings.processedLabel}</p>
                </div>
              </div>

              {jobStatus.errors && jobStatus.errors.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium mb-2">
                    {t.projects.settings.recentErrors.replace('{n}', String(jobStatus.errors.length))}
                  </h4>
                  <ScrollArea className="h-[160px] border rounded-md p-3">
                    <ul className="space-y-1.5 text-xs">
                      {jobStatus.errors.slice(0, 50).map((err, idx) => (
                        <li key={idx} className="flex items-start gap-2">
                          {err.row > 0 && (
                            <span className="text-muted-foreground">{t.projects.settings.rowPrefix.replace('{n}', String(err.row))}</span>
                          )}
                          <span className="text-red-600">
                            {err.title} — {err.error}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                </div>
              )}
            </div>
          </div>
        )}

        {step === "result" && importResult && (
          <div className="p-6">
            <div className="mb-6">
              <h3 className="text-lg font-semibold">{t.projects.settings.importCompleteHeading}</h3>
            </div>

            <div className="space-y-4">
              {(importResult.imported > 0 || importResult.updated > 0) && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <AlertTitle>{t.projects.settings.successfullyProcessed}</AlertTitle>
                  <AlertDescription>
                    {importResult.imported > 0 && t.projects.settings.tasksImported.replace('{n}', String(importResult.imported)) + ' '}
                    {importResult.updated > 0 && t.projects.settings.tasksUpdated.replace('{n}', String(importResult.updated))}
                  </AlertDescription>
                </Alert>
              )}

              {importResult.failed > 0 && (
                <Alert variant="destructive">
                  <XCircle className="h-4 w-4" />
                  <AlertTitle>{t.projects.settings.failedToProcess}</AlertTitle>
                  <AlertDescription>
                    {t.projects.settings.tasksCantProcess.replace('{n}', String(importResult.failed))}
                  </AlertDescription>
                </Alert>
              )}

              {importResult.errors && importResult.errors.length > 0 && (
                <div className="mt-4">
                  <h4 className="font-medium mb-2">{t.projects.settings.errorDetailsHeading}</h4>
                  <ScrollArea className="h-[200px] border rounded-md p-4">
                    <ul className="space-y-2 text-sm">
                      {importResult.errors.map((err, index) => (
                        <li key={index} className="flex items-start gap-2">
                          <span className="text-muted-foreground">{t.projects.settings.rowPrefix.replace('{n}', String(err.row))}</span>
                          <span className="text-red-600">{err.title} - {err.error}</span>
                        </li>
                      ))}
                    </ul>
                  </ScrollArea>
                </div>
              )}

              <div className="mt-3 grid grid-cols-4 gap-3">
                <div className="rounded-lg border bg-card p-4 text-center">
                  <p className="font-mono text-xl font-bold text-foreground">{importResult.imported}</p>
                  <p className="text-sm text-muted-foreground">{t.projects.settings.importedLabel}</p>
                </div>
                <div className="rounded-lg border bg-card p-4 text-center">
                  <p className="font-mono text-xl font-bold text-foreground">{importResult.updated || 0}</p>
                  <p className="text-sm text-muted-foreground">{t.projects.settings.updatedLabel}</p>
                </div>
                <div className="rounded-lg border bg-card p-4 text-center">
                  <p className="font-mono text-xl font-bold text-foreground">{importResult.failed}</p>
                  <p className="text-sm text-muted-foreground">{t.projects.settings.failedLabel}</p>
                </div>
                <div className="rounded-lg border bg-card p-4 text-center">
                  <p className="font-mono text-xl font-bold text-foreground">{importResult.total}</p>
                  <p className="text-sm text-muted-foreground">{t.projects.settings.totalLabel}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
