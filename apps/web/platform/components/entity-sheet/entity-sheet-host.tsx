import { Suspense, useEffect, useRef } from 'react';
import { useRouter } from '@/lib/router';
import { useEntitySheet } from './use-entity-sheet';
import { DEFAULT_ENTITY_SHEET_REGISTRY, pageHrefForEntity } from './registry';
import type { EntitySheetRegistry } from './types';

interface EntitySheetHostProps {
  registry?: EntitySheetRegistry;
}

/**
 * Global mount point for the entity sheet. Reads the `?entity=type:id` URL param,
 * looks up a renderer in the registry, and mounts it. If no renderer is registered
 * for the requested type, falls back to navigating to the entity's full page.
 *
 * Mount once near the root of the tree (after the router).
 */
export function EntitySheetHost({
  registry = DEFAULT_ENTITY_SHEET_REGISTRY,
}: EntitySheetHostProps) {
  const { target, view, close, toggleView } = useEntitySheet();
  const router = useRouter();
  const fallbackNavigatedRef = useRef<string | null>(null);

  const Renderer = target ? registry[target.type] : undefined;
  const targetKey = target ? `${target.type}:${target.id}` : null;

  useEffect(() => {
    if (!target) {
      fallbackNavigatedRef.current = null;
      return;
    }
    if (Renderer) return;
    // No renderer registered → fallback to full-page navigation.
    if (fallbackNavigatedRef.current === targetKey) return;
    fallbackNavigatedRef.current = targetKey;
    const href = pageHrefForEntity(target.type, target.id);
    close();
    // Entities without a full page (e.g. lead, opportunity) only ever render
    // through a registered sheet; if there's no renderer AND no page, there's
    // nothing to navigate to — just close.
    if (href) router.push(href);
  }, [target, targetKey, Renderer, router, close]);

  if (!target || !Renderer) return null;

  return (
    <Suspense fallback={null}>
      <Renderer
        key={targetKey ?? undefined}
        entityType={target.type}
        entityId={target.id}
        view={view}
        onClose={close}
        onToggleView={toggleView}
        openHref={pageHrefForEntity(target.type, target.id) ?? undefined}
      />
    </Suspense>
  );
}
