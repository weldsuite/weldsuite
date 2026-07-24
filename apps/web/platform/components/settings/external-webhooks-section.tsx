
import * as React from "react"
import { useTranslations } from '@weldsuite/i18n/client'
import { toast } from "sonner"
import {
  Plus,
  Copy,
  Check,
  AlertCircle,
  Trash2,
  Pencil,
  RotateCw,
  Send,
  EllipsisVertical,
  ListChecks,
  Webhook as WebhookIcon,
} from "lucide-react"
import { Button } from "@weldsuite/ui/components/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@weldsuite/ui/components/table"
import { Badge } from "@weldsuite/ui/components/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@weldsuite/ui/components/dialog"
import { Input } from "@weldsuite/ui/components/input"
import { Label } from "@weldsuite/ui/components/label"
import { Textarea } from "@weldsuite/ui/components/textarea"
import { Alert, AlertDescription } from "@weldsuite/ui/components/alert"
import { Checkbox } from "@weldsuite/ui/components/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@weldsuite/ui/components/dropdown-menu"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/provider"
import { ExpandingSearchInput } from "@/components/settings/expanding-search-input"
import {
  useExternalWebhookEvents,
  useExternalWebhooks,
  useExternalWebhookDeliveries,
  useCreateExternalWebhook,
  useUpdateExternalWebhook,
  useDeleteExternalWebhook,
  useRotateExternalWebhookSecret,
  useSendTestWebhook,
  type ExternalWebhook,
  type ExternalWebhookWithSecret,
} from "@/hooks/queries/use-external-webhook-queries"

function formatDate(dateString: string | null) {
  if (!dateString) return null
  const date = new Date(dateString)
  const isCurrentYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleString("en-US", {
    ...(isCurrentYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const classes =
    status === "active"
      ? "border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
      : status === "paused"
        ? "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
        : "border-transparent bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
  return <Badge className={classes}>{label}</Badge>
}

interface EventPickerProps {
  events: { event: string; entity: string; action: string }[]
  selected: string[]
  onToggle: (event: string) => void
}

function EventPicker({ events, selected, onToggle }: EventPickerProps) {
  const groups = React.useMemo(() => {
    const byEntity = new Map<string, typeof events>()
    for (const e of events) {
      const list = byEntity.get(e.entity) ?? []
      list.push(e)
      byEntity.set(e.entity, list)
    }
    return Array.from(byEntity.entries())
  }, [events])

  return (
    <div className="max-h-64 overflow-y-auto space-y-3 border rounded-md p-3">
      {groups.map(([entity, entityEvents]) => (
        <div key={entity}>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
            {entity}
          </div>
          <div className="grid grid-cols-2 gap-1">
            {entityEvents.map((e) => (
              <label key={e.event} className="flex items-center gap-2 text-sm py-0.5 cursor-pointer">
                <Checkbox checked={selected.includes(e.event)} onCheckedChange={() => onToggle(e.event)} />
                <span className="font-mono text-xs">{e.event}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ExternalWebhooksSection() {
  const { t } = useI18n()
  const st = useTranslations()
  const ts = t.settings.webhooks

  const [searchQuery, setSearchQuery] = React.useState("")
  const { data: eventsData } = useExternalWebhookEvents()
  const { data: webhooksData, isLoading } = useExternalWebhooks()
  const createMutation = useCreateExternalWebhook()
  const updateMutation = useUpdateExternalWebhook()
  const deleteMutation = useDeleteExternalWebhook()
  const rotateMutation = useRotateExternalWebhookSecret()
  const testMutation = useSendTestWebhook()

  const catalogEvents = eventsData?.data ?? []

  const filteredWebhooks = React.useMemo(() => {
    const webhooks = webhooksData?.data ?? []
    const q = searchQuery.trim().toLowerCase()
    if (!q) return webhooks
    return webhooks.filter((w) => [w.name, w.description, w.url].filter(Boolean).join(" ").toLowerCase().includes(q))
  }, [webhooksData, searchQuery])

  // Create dialog state
  const [createOpen, setCreateOpen] = React.useState(false)
  const [createName, setCreateName] = React.useState("")
  const [createDescription, setCreateDescription] = React.useState("")
  const [createUrl, setCreateUrl] = React.useState("")
  const [createEvents, setCreateEvents] = React.useState<string[]>([])

  // Edit dialog state
  const [editingWebhook, setEditingWebhook] = React.useState<ExternalWebhook | null>(null)
  const [editName, setEditName] = React.useState("")
  const [editDescription, setEditDescription] = React.useState("")
  const [editUrl, setEditUrl] = React.useState("")
  const [editEvents, setEditEvents] = React.useState<string[]>([])

  // Secret reveal dialog (shown once after create/rotate)
  const [revealedSecret, setRevealedSecret] = React.useState<{ webhook: ExternalWebhookWithSecret } | null>(null)
  const [copied, setCopied] = React.useState(false)

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = React.useState<ExternalWebhook | null>(null)

  // Deliveries dialog
  const [deliveriesTarget, setDeliveriesTarget] = React.useState<ExternalWebhook | null>(null)
  const { data: deliveriesData } = useExternalWebhookDeliveries(deliveriesTarget?.id ?? "")

  const resetCreateForm = () => {
    setCreateName("")
    setCreateDescription("")
    setCreateUrl("")
    setCreateEvents([])
  }

  const handleCreate = async () => {
    if (!createName.trim()) {
      toast.error(ts.messages.nameRequired)
      return
    }
    if (!createUrl.trim().startsWith("https://")) {
      toast.error(ts.messages.urlRequired)
      return
    }
    if (createEvents.length === 0) {
      toast.error(ts.messages.eventsRequired)
      return
    }
    try {
      const result = await createMutation.mutateAsync({
        name: createName.trim(),
        description: createDescription.trim() || undefined,
        url: createUrl.trim(),
        events: createEvents,
      })
      toast.success(ts.messages.created)
      setCreateOpen(false)
      resetCreateForm()
      setRevealedSecret({ webhook: result.data })
    } catch {
      toast.error(ts.messages.createFailed)
    }
  }

  const openEditDialog = (webhook: ExternalWebhook) => {
    setEditingWebhook(webhook)
    setEditName(webhook.name)
    setEditDescription(webhook.description ?? "")
    setEditUrl(webhook.url)
    setEditEvents(webhook.events)
  }

  const handleUpdate = async () => {
    if (!editingWebhook) return
    if (!editName.trim()) {
      toast.error(ts.messages.nameRequired)
      return
    }
    if (editEvents.length === 0) {
      toast.error(ts.messages.eventsRequired)
      return
    }
    try {
      await updateMutation.mutateAsync({
        id: editingWebhook.id,
        data: {
          name: editName.trim(),
          description: editDescription.trim() || undefined,
          url: editUrl.trim(),
          events: editEvents,
        },
      })
      toast.success(ts.messages.updated)
      setEditingWebhook(null)
    } catch {
      toast.error(ts.messages.updateFailed)
    }
  }

  const handleToggleStatus = async (webhook: ExternalWebhook) => {
    const nextStatus = webhook.status === "active" ? "paused" : "active"
    try {
      await updateMutation.mutateAsync({ id: webhook.id, data: { status: nextStatus } })
      toast.success(ts.messages.updated)
    } catch {
      toast.error(ts.messages.updateFailed)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await deleteMutation.mutateAsync(deleteTarget.id)
      toast.success(ts.messages.deleted)
      setDeleteTarget(null)
    } catch {
      toast.error(ts.messages.deleteFailed)
    }
  }

  const handleRotate = async (webhook: ExternalWebhook) => {
    try {
      const result = await rotateMutation.mutateAsync(webhook.id)
      toast.success(ts.messages.secretRotated)
      setRevealedSecret({ webhook: result.data })
    } catch {
      toast.error(ts.messages.secretRotateFailed)
    }
  }

  const handleTest = async (webhook: ExternalWebhook) => {
    try {
      const result = await testMutation.mutateAsync(webhook.id)
      if (result.data.delivered) {
        toast.success(ts.messages.testSent)
      } else {
        toast.error(`${ts.messages.testFailed}${result.data.errorMessage ? `: ${result.data.errorMessage}` : ""}`)
      }
    } catch {
      toast.error(ts.messages.testFailed)
    }
  }

  const copySecret = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable — no-op
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">{ts.subtitle}</p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <ExpandingSearchInput value={searchQuery} onChange={setSearchQuery} placeholder={ts.searchPlaceholder} />

          <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) resetCreateForm() }}>
            <DialogTrigger asChild>
              <Button size="sm" className="h-8">
                <Plus className="h-4 w-4 mr-0.5" />
                {ts.create}
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{ts.createDialog.title}</DialogTitle>
                <DialogDescription>{ts.createDialog.description}</DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 py-4">
                <div className="grid gap-2">
                  <Label htmlFor="webhook-name">{ts.createDialog.nameLabel} *</Label>
                  <Input
                    id="webhook-name"
                    placeholder={ts.createDialog.namePlaceholder}
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="webhook-description">{ts.createDialog.descriptionLabel}</Label>
                  <Textarea
                    id="webhook-description"
                    placeholder={ts.createDialog.descriptionPlaceholder}
                    value={createDescription}
                    onChange={(e) => setCreateDescription(e.target.value)}
                    rows={2}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="webhook-url">{ts.createDialog.urlLabel} *</Label>
                  <Input
                    id="webhook-url"
                    placeholder={ts.createDialog.urlPlaceholder}
                    value={createUrl}
                    onChange={(e) => setCreateUrl(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{ts.createDialog.urlHelp}</p>
                </div>
                <div className="grid gap-2">
                  <div className="flex items-center gap-1.5">
                    <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
                    <Label>{ts.createDialog.eventsLabel} *</Label>
                  </div>
                  <p className="text-xs text-muted-foreground">{ts.createDialog.eventsHelp}</p>
                  <EventPicker
                    events={catalogEvents}
                    selected={createEvents}
                    onToggle={(event) =>
                      setCreateEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]))
                    }
                  />
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  {ts.createDialog.cancel}
                </Button>
                <Button onClick={handleCreate} disabled={createMutation.isPending}>
                  {createMutation.isPending ? ts.createDialog.creating : ts.createDialog.create}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {isLoading ? (
          <div className="border rounded-lg p-8 text-center text-muted-foreground">…</div>
        ) : filteredWebhooks.length === 0 ? (
          <div className="border rounded-lg p-8 text-center text-muted-foreground">
            <WebhookIcon className="h-6 w-6 mx-auto mb-2 opacity-50" />
            <p>{ts.empty}</p>
            <p className="text-sm mt-1">{ts.emptyDescription}</p>
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[13.5px]">{ts.columns.name}</TableHead>
                  <TableHead className="text-[13.5px]">{ts.columns.url}</TableHead>
                  <TableHead className="text-[13.5px]">{ts.columns.events}</TableHead>
                  <TableHead className="text-[13.5px]">{ts.columns.status}</TableHead>
                  <TableHead className="text-[13.5px]">{ts.columns.lastDelivery}</TableHead>
                  <TableHead className="text-right text-[13.5px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredWebhooks.map((webhook) => (
                  <TableRow key={webhook.id} className="group">
                    <TableCell>
                      <div className="font-medium">{webhook.name}</div>
                      {webhook.description && (
                        <div className="text-sm text-muted-foreground">{webhook.description}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-2 py-1 rounded break-all">{webhook.url}</code>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">
                        {webhook.events.length === 1 ? ts.eventCount : ts.eventCountPlural.replace("{count}", String(webhook.events.length))}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={webhook.status} label={ts.status[webhook.status]} />
                    </TableCell>
                    <TableCell className="text-[13.5px] font-mono text-muted-foreground">
                      {formatDate(webhook.lastDeliveredAt) ?? ts.never}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                            >
                              <span className="sr-only">{st('sweep.settings.webhooksExtra.openMenu')}</span>
                              <EllipsisVertical className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEditDialog(webhook)}>
                              <Pencil className="h-4 w-4 mr-0.5" />
                              {ts.actions.edit}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setDeliveriesTarget(webhook)}>
                              <ListChecks className="h-4 w-4 mr-0.5" />
                              {ts.actions.viewDeliveries}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleTest(webhook)}>
                              <Send className="h-4 w-4 mr-0.5" />
                              {ts.actions.sendTest}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleRotate(webhook)}>
                              <RotateCw className="h-4 w-4 mr-0.5" />
                              {ts.actions.rotateSecret}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleToggleStatus(webhook)}>
                              {webhook.status === "active" ? ts.actions.pause : ts.actions.resume}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setDeleteTarget(webhook)}
                              className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
                            >
                              <Trash2 className="h-4 w-4 mr-0.5 text-red-500" />
                              {ts.actions.delete}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Edit dialog */}
      <Dialog open={!!editingWebhook} onOpenChange={(open) => !open && setEditingWebhook(null)}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{ts.editDialog.title}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-webhook-name">{ts.createDialog.nameLabel} *</Label>
              <Input id="edit-webhook-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-webhook-description">{ts.createDialog.descriptionLabel}</Label>
              <Textarea
                id="edit-webhook-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={2}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-webhook-url">{ts.createDialog.urlLabel} *</Label>
              <Input id="edit-webhook-url" value={editUrl} onChange={(e) => setEditUrl(e.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>{ts.createDialog.eventsLabel} *</Label>
              <EventPicker
                events={catalogEvents}
                selected={editEvents}
                onToggle={(event) =>
                  setEditEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]))
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingWebhook(null)}>
              {ts.editDialog.cancel}
            </Button>
            <Button onClick={handleUpdate} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? ts.editDialog.saving : ts.editDialog.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Secret reveal dialog */}
      <Dialog open={!!revealedSecret} onOpenChange={(open) => !open && setRevealedSecret(null)}>
        <DialogContent className="sm:max-w-[650px]">
          <DialogHeader>
            <DialogTitle>{ts.secretDialog.title}</DialogTitle>
            <DialogDescription>{ts.secretDialog.description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{ts.secretDialog.description}</AlertDescription>
            </Alert>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-sm bg-muted px-3 py-2 rounded border font-mono break-all select-all">
                {revealedSecret?.webhook.secret}
              </code>
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                onClick={() => revealedSecret && copySecret(revealedSecret.webhook.secret)}
              >
                {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setRevealedSecret(null)}>{ts.secretDialog.done}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ts.deleteDialog.title}</DialogTitle>
            <DialogDescription>{ts.deleteDialog.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {ts.deleteDialog.cancel}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {ts.deleteDialog.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deliveries dialog */}
      <Dialog open={!!deliveriesTarget} onOpenChange={(open) => !open && setDeliveriesTarget(null)}>
        <DialogContent className="sm:max-w-[700px] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{ts.deliveries.title}</DialogTitle>
            <DialogDescription>{deliveriesTarget?.name}</DialogDescription>
          </DialogHeader>
          {(deliveriesData?.data ?? []).length === 0 ? (
            <div className="border rounded-lg p-8 text-center text-muted-foreground">{ts.deliveries.empty}</div>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[13px]">{ts.deliveries.columns.event}</TableHead>
                    <TableHead className="text-[13px]">{ts.deliveries.columns.status}</TableHead>
                    <TableHead className="text-[13px]">{ts.deliveries.columns.responseStatus}</TableHead>
                    <TableHead className="text-[13px]">{ts.deliveries.columns.duration}</TableHead>
                    <TableHead className="text-[13px]">{ts.deliveries.columns.attempt}</TableHead>
                    <TableHead className="text-[13px]">{ts.deliveries.columns.time}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(deliveriesData?.data ?? []).map((delivery) => (
                    <TableRow key={delivery.id}>
                      <TableCell className="font-mono text-xs">{delivery.eventType}</TableCell>
                      <TableCell>
                        <Badge
                          className={cn(
                            "border-transparent",
                            delivery.status === "delivered"
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                              : delivery.status === "failed"
                                ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                                : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
                          )}
                        >
                          {ts.deliveries.status[delivery.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{delivery.responseStatus ?? "—"}</TableCell>
                      <TableCell className="text-xs">{delivery.responseTimeMs ? `${delivery.responseTimeMs}ms` : "—"}</TableCell>
                      <TableCell className="text-xs">{delivery.attemptNumber}</TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">{formatDate(delivery.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
