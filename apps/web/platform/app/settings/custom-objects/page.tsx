'use client';

import * as React from 'react';
import { Box, Plus, Settings2 } from 'lucide-react';
import { useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { LucideDynamicIcon } from '@/components/lucide-dynamic-icon';
import { useI18n } from '@/lib/i18n/provider';
import { useCustomObjects } from '@/hooks/queries/use-custom-objects-queries';
import { CreateObjectDialog } from './create-object-dialog';

/**
 * WeldObjects — the object list in Settings.
 *
 * The BUILDER lives in Settings because defining an object changes the tenant's
 * schema; the objects themselves appear as their own top-level sidebar entries
 * once they're `active`, so users reach "Machines" directly rather than through
 * a WeldObjects module.
 */
export default function CustomObjectsSettingsPage() {
  const router = useRouter();
  const { t: i18n } = useI18n();
  const t = i18n.weldobjects;
  const { data: objects, isLoading } = useCustomObjects();
  const [createOpen, setCreateOpen] = React.useState(false);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{t.settings.title}</h1>
          <p className="text-sm text-muted-foreground">{t.settings.subtitle}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t.settings.newObject}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (objects?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Box className="h-10 w-10 text-muted-foreground" />
            <div>
              <h2 className="font-semibold">{t.settings.emptyTitle}</h2>
              <p className="text-sm text-muted-foreground">{t.settings.emptyBody}</p>
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              {t.settings.newObject}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {objects!.map((object) => (
            <Card
              key={object.id}
              className="cursor-pointer transition-colors hover:bg-muted/40"
              onClick={() => router.push(`/settings/custom-objects/${object.id}`)}
            >
              <CardContent className="flex items-center gap-4 py-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-md border">
                  <LucideDynamicIcon
                    name={object.icon}
                    className="h-5 w-5"
                    fallback={() => <Box className="h-5 w-5" />}
                  />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{object.labelPlural}</span>
                    <Badge variant={object.status === 'active' ? 'default' : 'secondary'}>
                      {t.settings.status[object.status]}
                    </Badge>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {object.description || `/objects/${object.slug}`}
                  </p>
                </div>

                <div className="flex items-center gap-6 text-sm text-muted-foreground">
                  <div className="text-right">
                    <div className="font-medium text-foreground">{object.fieldCount ?? 0}</div>
                    <div className="text-xs">{t.settings.fields}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium text-foreground">{object.recordCount ?? 0}</div>
                    <div className="text-xs">{t.settings.records}</div>
                  </div>
                  <Settings2 className="h-4 w-4" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateObjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
