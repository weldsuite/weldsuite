'use client';

import * as React from 'react';
import { ArrowLeft, Box, Plus, Trash2, GripVertical } from 'lucide-react';
import { useParams, useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Switch } from '@weldsuite/ui/components/switch';
import { Badge } from '@weldsuite/ui/components/badge';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { FieldDefinitionDialog } from '@/app/settings/custom-fields/field-definition-dialog';
import { useCustomFields, type CustomFieldDefinition } from '@/hooks/use-custom-fields';
import {
  useCreateCustomField,
  useUpdateCustomField,
  useDeleteCustomField,
} from '@/hooks/queries/use-settings-queries';
import {
  useCustomObject,
  useUpdateCustomObject,
  useDeleteCustomObject,
  useCustomObjectDeleteImpact,
} from '@/hooks/queries/use-custom-objects-queries';
import { LinksSection } from './links-section';

/** Field types eligible to serve as a record's display name. */
const TITLE_ELIGIBLE = ['text', 'email', 'url', 'phone'];

/**
 * WeldObjects object builder.
 *
 * Three tabs: fields, relationships, settings. The FIELD editor is the existing
 * `FieldDefinitionDialog` from settings/custom-fields pointed at
 * `entityType = co_<slug>` — a custom object's fields are ordinary
 * `custom_field_definitions` rows, so there is nothing object-specific to build.
 */
export default function CustomObjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { t: i18n } = useI18n();
  const t = i18n.weldobjects;

  const objectId = (params?.objectId as string) ?? '';
  const { data: object, isLoading } = useCustomObject(objectId);
  const { data: fields } = useCustomFields(object?.entityKey, !!object);

  const updateObject = useUpdateCustomObject();
  const deleteObject = useDeleteCustomObject();
  const createField = useCreateCustomField();
  const updateField = useUpdateCustomField();
  const deleteField = useDeleteCustomField();

  const [fieldDialogOpen, setFieldDialogOpen] = React.useState(false);
  const [editingField, setEditingField] = React.useState<CustomFieldDefinition | null>(null);
  const [pendingFieldDelete, setPendingFieldDelete] = React.useState<CustomFieldDefinition | null>(
    null,
  );
  const [confirmDeleteObject, setConfirmDeleteObject] = React.useState(false);

  const { data: impact } = useCustomObjectDeleteImpact(objectId, confirmDeleteObject);

  const [labelSingular, setLabelSingular] = React.useState('');
  const [labelPlural, setLabelPlural] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [icon, setIcon] = React.useState('');

  React.useEffect(() => {
    if (!object) return;
    setLabelSingular(object.labelSingular);
    setLabelPlural(object.labelPlural);
    setDescription(object.description ?? '');
    setIcon(object.icon);
  }, [object]);

  if (isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!object) {
    return (
      <div className="flex flex-col items-center gap-3 p-12 text-center">
        <Box className="h-10 w-10 text-muted-foreground" />
        <h2 className="font-semibold">{t.settings.notFound}</h2>
        <Button variant="outline" onClick={() => router.push('/settings/custom-objects')}>
          {t.settings.backToObjects}
        </Button>
      </div>
    );
  }

  async function patch(values: Record<string, unknown>) {
    try {
      await updateObject.mutateAsync({ id: objectId, ...values });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.errors.saveFailed);
    }
  }

  const titleCandidates = (fields ?? []).filter((f) => TITLE_ELIGIBLE.includes(f.fieldType));
  const canActivate = (fields?.length ?? 0) > 0;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/settings/custom-objects')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">{object.labelPlural}</h1>
              <Badge variant={object.status === 'active' ? 'default' : 'secondary'}>
                {t.settings.status[object.status]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">/objects/{object.slug}</p>
          </div>
        </div>

        {object.status !== 'active' ? (
          <Button
            disabled={!canActivate}
            title={canActivate ? undefined : t.settings.activateNeedsFields}
            onClick={() => patch({ status: 'active' })}
          >
            {t.settings.activate}
          </Button>
        ) : (
          <Button variant="outline" onClick={() => patch({ status: 'disabled' })}>
            {t.settings.disable}
          </Button>
        )}
      </div>

      <Tabs defaultValue="fields">
        <TabsList>
          <TabsTrigger value="fields">
            {t.settings.fields} ({fields?.length ?? 0})
          </TabsTrigger>
          <TabsTrigger value="relationships">{t.settings.relationships}</TabsTrigger>
          <TabsTrigger value="settings">{t.settings.settingsTab}</TabsTrigger>
        </TabsList>

        {/* ── Fields ─────────────────────────────────────────────────────── */}
        <TabsContent value="fields" className="space-y-4 pt-4">
          <div className="flex justify-end">
            <Button
              onClick={() => {
                setEditingField(null);
                setFieldDialogOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t.settings.addField}
            </Button>
          </div>

          {(fields?.length ?? 0) === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
                <p className="font-medium">{t.settings.noFieldsTitle}</p>
                <p className="text-sm text-muted-foreground">{t.settings.noFieldsBody}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {fields!.map((field) => (
                <Card key={field.id}>
                  <CardContent className="flex items-center gap-3 py-3">
                    <GripVertical className="h-4 w-4 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{field.name}</span>
                        {field.required ? (
                          <Badge variant="outline">{t.settings.required}</Badge>
                        ) : null}
                        {object.titleFieldId === field.id ? (
                          <Badge>{t.settings.titleField}</Badge>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {field.slug} · {field.fieldType}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingField(field);
                        setFieldDialogOpen(true);
                      }}
                    >
                      {t.settings.editField}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setPendingFieldDelete(field)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Relationships ──────────────────────────────────────────────── */}
        <TabsContent value="relationships" className="pt-4">
          <LinksSection object={object} />
        </TabsContent>

        {/* ── Settings ───────────────────────────────────────────────────── */}
        <TabsContent value="settings" className="space-y-4 pt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t.settings.general}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t.create.singularLabel}</Label>
                  <Input
                    value={labelSingular}
                    onChange={(e) => setLabelSingular(e.target.value)}
                    onBlur={() => patch({ labelSingular })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t.create.pluralLabel}</Label>
                  <Input
                    value={labelPlural}
                    onChange={(e) => setLabelPlural(e.target.value)}
                    onBlur={() => patch({ labelPlural })}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>{t.create.descriptionLabel}</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onBlur={() => patch({ description: description || null })}
                  rows={2}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t.settings.icon}</Label>
                  <Input
                    value={icon}
                    onChange={(e) => setIcon(e.target.value)}
                    onBlur={() => patch({ icon })}
                    placeholder="Box"
                  />
                  <p className="text-xs text-muted-foreground">{t.settings.iconHelp}</p>
                </div>

                <div className="space-y-1.5">
                  <Label>{t.settings.titleField}</Label>
                  <Select
                    value={object.titleFieldId ?? ''}
                    onValueChange={(value) => patch({ titleFieldId: value || null })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t.settings.titleFieldAuto} />
                    </SelectTrigger>
                    <SelectContent>
                      {titleCandidates.map((field) => (
                        <SelectItem key={field.id} value={field.id}>
                          {field.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t.settings.titleFieldHelp}</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>{t.create.slugLabel}</Label>
                <Input value={object.slug} disabled />
                {/* Immutability is a data-integrity constraint, not a UI
                    limitation — a rename would orphan stored values, saved grid
                    layouts, search rows and granted permissions. */}
                <p className="text-xs text-muted-foreground">{t.settings.slugImmutable}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t.settings.integrations}</CardTitle>
              <CardDescription>{t.settings.integrationsHelp}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {(
                [
                  ['enableEvents', t.settings.integrationEvents, t.settings.integrationEventsHelp],
                  ['enableSearch', t.settings.integrationSearch, t.settings.integrationSearchHelp],
                  [
                    'enableAgentTools',
                    t.settings.integrationAgent,
                    t.settings.integrationAgentHelp,
                  ],
                  [
                    'enableExternalApi',
                    t.settings.integrationApi,
                    t.settings.integrationApiHelp,
                  ],
                ] as const
              ).map(([key, label, help]) => (
                <div key={key} className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium">{label}</p>
                    <p className="text-xs text-muted-foreground">{help}</p>
                  </div>
                  <Switch
                    checked={object[key]}
                    onCheckedChange={(checked) => patch({ [key]: checked })}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-base text-destructive">
                {t.settings.dangerZone}
              </CardTitle>
              <CardDescription>{t.settings.dangerHelp}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" onClick={() => setConfirmDeleteObject(true)}>
                <Trash2 className="mr-2 h-4 w-4" />
                {t.settings.deleteObject.replace('{object}', object.labelPlural)}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* The field editor is the existing settings/custom-fields dialog, aimed
          at this object's entity key. No fork, no per-object variant. */}
      <FieldDefinitionDialog
        open={fieldDialogOpen}
        onOpenChange={setFieldDialogOpen}
        entityType={object.entityKey}
        field={editingField}
        isPending={createField.isPending || updateField.isPending}
        onSubmit={async (data) => {
          try {
            if (editingField) {
              await updateField.mutateAsync({ id: editingField.id, data });
            } else {
              await createField.mutateAsync({ ...data, entityType: object.entityKey } as never);
            }
            setFieldDialogOpen(false);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t.errors.saveFailed);
          }
        }}
      />

      <ConfirmDialog
        open={!!pendingFieldDelete}
        onOpenChange={(open) => !open && setPendingFieldDelete(null)}
        title={t.settings.deleteFieldTitle}
        description={t.settings.deleteFieldBody.replace(
          '{field}',
          pendingFieldDelete?.name ?? '',
        )}
        confirmLabel={t.detail.delete}
        variant="destructive"
        onConfirm={async () => {
          if (!pendingFieldDelete) return;
          try {
            await deleteField.mutateAsync(pendingFieldDelete.id);
            setPendingFieldDelete(null);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t.errors.deleteFailed);
          }
        }}
      />

      <ConfirmDialog
        open={confirmDeleteObject}
        onOpenChange={setConfirmDeleteObject}
        title={t.settings.deleteObjectTitle.replace('{object}', object.labelPlural)}
        // Row counts, not a vague warning: the user is about to destroy real
        // data and deserves to know how much before confirming.
        description={t.settings.deleteObjectBody
          .replace('{records}', String(impact?.recordCount ?? 0))
          .replace('{fields}', String(impact?.fieldCount ?? 0))
          .replace('{relations}', String(impact?.relationCount ?? 0))}
        confirmLabel={t.settings.deleteObjectConfirm}
        variant="destructive"
        onConfirm={async () => {
          try {
            await deleteObject.mutateAsync({ id: objectId, slug: object.slug });
            toast.success(t.settings.objectDeleted);
            router.push('/settings/custom-objects');
          } catch (err) {
            toast.error(err instanceof Error ? err.message : t.errors.deleteFailed);
          }
        }}
      />
    </div>
  );
}
