import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { isApiError } from '@weldsuite/api-client/client';
import { appApi } from '@/services/app-api';
import { weldstashKeys } from '@/lib/query-client';
import { applyLocalStockDelta } from '@/lib/weldstash-cache';
import { buildAdjustPayload } from '@/utils/barcode';
import {
  clampDelta,
  createPendingAdjustQueue,
  type PendingAdjustQueue,
  warehouseOnHand,
} from '@/utils/stock';
import type { InventoryRow } from '@weldsuite/app-api-client/domains/inventory';
import type { ListResponse } from '@weldsuite/app-api-client/types';

interface UseStockAdjusterOptions {
  productId: string | undefined;
  warehouseId: string | null;
  reason: string;
  onError: (message: string) => void;
}

/**
 * Instant +/- stock: update the cache immediately, then coalesce taps into
 * one `/inventory/adjust` call. The stepper never waits on the network.
 */
export function useStockAdjuster({
  productId,
  warehouseId,
  reason,
  onError,
}: UseStockAdjusterOptions) {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const reasonRef = useRef(reason);
  reasonRef.current = reason;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const queueRef = useRef<PendingAdjustQueue | null>(null);

  useEffect(() => {
    if (!productId) return;

    const queue = createPendingAdjustQueue(async (delta, flushWarehouseId) => {
      setSyncing(true);
      try {
        await appApi.inventory.adjust(
          buildAdjustPayload({
            productId,
            warehouseId: flushWarehouseId,
            delta,
            reason: reasonRef.current,
          }),
        );
      } catch (err) {
        applyLocalStockDelta(queryClient, {
          productId,
          warehouseId: flushWarehouseId,
          delta: -delta,
        });
        const message = isApiError(err) ? err.message : (err as Error).message;
        onErrorRef.current(message || 'Failed to adjust stock');
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } finally {
        setSyncing(queue.getPending() !== 0);
      }
    });

    queueRef.current = queue;
    return () => {
      void queue.flushNow();
      queue.dispose();
      queueRef.current = null;
    };
  }, [productId, queryClient]);

  const applyDelta = useCallback(
    (delta: number) => {
      if (!productId || !warehouseId || delta === 0) return false;
      const stock = queryClient.getQueryData<ListResponse<InventoryRow>>(weldstashKeys.stock(productId));
      const onHand = warehouseOnHand(stock?.data ?? [], warehouseId);
      const clamped = clampDelta(onHand, delta);
      if (clamped === 0) return false;

      applyLocalStockDelta(queryClient, { productId, warehouseId, delta: clamped });
      queueRef.current?.enqueue(clamped, warehouseId);
      setSyncing(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return true;
    },
    [productId, queryClient, warehouseId],
  );

  return { applyDelta, syncing };
}
