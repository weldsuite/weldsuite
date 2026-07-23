import { useCallback, useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  ENTITY_SHEET_PARAM,
  ENTITY_SHEET_VIEW_PARAM,
  decodeEntitySheetParam,
  decodeEntitySheetView,
  encodeEntitySheetTarget,
} from './url-param';
import type { EntitySheetTarget, EntitySheetType, EntitySheetView } from './types';

interface UseEntitySheetReturn {
  target: EntitySheetTarget | null;
  view: EntitySheetView;
  isOpen: boolean;
  open: (type: EntitySheetType, id: string) => void;
  openExpanded: (type: EntitySheetType, id: string) => void;
  toggleView: () => void;
  close: () => void;
}

/**
 * Read/write the entity sheet URL params:
 *   ?entity=type:id          → peek (default ~500px panel)
 *   ?entity=type:id&view=full → expanded (full content area, no route change)
 *
 * Designed to work on any route — uses lenient `useSearch({ strict: false })`
 * so it doesn't require the host route to declare these search params.
 */
export function useEntitySheet(): UseEntitySheetReturn {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();

  const rawEntity =
    typeof search[ENTITY_SHEET_PARAM] === 'string'
      ? (search[ENTITY_SHEET_PARAM] as string)
      : null;
  const target = useMemo(() => decodeEntitySheetParam(rawEntity), [rawEntity]);
  const view = decodeEntitySheetView(search[ENTITY_SHEET_VIEW_PARAM]);

  const open = useCallback(
    (type: EntitySheetType, id: string) => {
      navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => {
          const next = { ...prev };
          next[ENTITY_SHEET_PARAM] = encodeEntitySheetTarget(type, id);
          delete next[ENTITY_SHEET_VIEW_PARAM];
          return next;
        },
        replace: false,
      } as never);
    },
    [navigate],
  );

  const openExpanded = useCallback(
    (type: EntitySheetType, id: string) => {
      navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          [ENTITY_SHEET_PARAM]: encodeEntitySheetTarget(type, id),
          [ENTITY_SHEET_VIEW_PARAM]: 'full',
        }),
        replace: false,
      } as never);
    },
    [navigate],
  );

  const toggleView = useCallback(() => {
    navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev };
        if (decodeEntitySheetView(next[ENTITY_SHEET_VIEW_PARAM]) === 'full') {
          delete next[ENTITY_SHEET_VIEW_PARAM];
        } else {
          next[ENTITY_SHEET_VIEW_PARAM] = 'full';
        }
        return next;
      },
      replace: false,
    } as never);
  }, [navigate]);

  const close = useCallback(() => {
    navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev };
        delete next[ENTITY_SHEET_PARAM];
        delete next[ENTITY_SHEET_VIEW_PARAM];
        return next;
      },
      replace: false,
    } as never);
  }, [navigate]);

  return {
    target,
    view,
    isOpen: target !== null,
    open,
    openExpanded,
    toggleView,
    close,
  };
}
