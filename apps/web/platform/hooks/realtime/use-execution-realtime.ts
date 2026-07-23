/**
 * useExecutionRealtime Hook
 *
 * Subscribes to workflow execution realtime events via the WorkspaceHub
 * WebSocket connection (useTopic from @weldsuite/realtime/react).
 *
 * Replaces the Trigger.dev useRealtimeRun hook.
 */

import { useState, useCallback } from 'react';
import { useTopic } from '@weldsuite/realtime/react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkspaceEvent } from '@weldsuite/realtime';

interface ExecutionProgress {
  current: number;
  total: number;
  stepName: string;
}

interface ExecutionLogEntry {
  level: string;
  message: string;
  stepId?: string;
  ts: number;
}

interface ExecutionRealtimeState {
  status: string | null;
  progress: ExecutionProgress | null;
  logs: ExecutionLogEntry[];
  isLive: boolean;
}

export function useExecutionRealtime(executionId: string, enabled = true) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ExecutionRealtimeState>({
    status: null,
    progress: null,
    logs: [],
    isLive: false,
  });

  const handler = useCallback(
    (event: WorkspaceEvent) => {
      setState((prev) => {
        const data = event.data as Record<string, unknown>;

        switch (event.event) {
          case 'started':
            return { ...prev, status: 'running', isLive: true };

          case 'step_started':
            return {
              ...prev,
              progress: {
                current: data.stepIndex as number,
                total: data.totalSteps as number,
                stepName: data.stepName as string,
              },
            };

          case 'step_completed':
            // Invalidate steps query to refresh the steps tab
            queryClient.invalidateQueries({ queryKey: ['automation', 'execution-steps', executionId] });
            return {
              ...prev,
              progress: {
                current: data.stepIndex as number,
                total: data.totalSteps as number,
                stepName: data.stepName as string,
              },
            };

          case 'step_skipped':
          case 'step_failed':
            queryClient.invalidateQueries({ queryKey: ['automation', 'execution-steps', executionId] });
            return {
              ...prev,
              progress: prev.progress
                ? { ...prev.progress, stepName: data.stepName as string }
                : null,
            };

          case 'completed':
            // Invalidate all execution queries
            queryClient.invalidateQueries({ queryKey: ['automation', 'execution', executionId] });
            queryClient.invalidateQueries({ queryKey: ['automation', 'execution-steps', executionId] });
            queryClient.invalidateQueries({ queryKey: ['automation', 'execution-logs', executionId] });
            return { ...prev, status: 'completed', isLive: false };

          case 'failed':
            queryClient.invalidateQueries({ queryKey: ['automation', 'execution', executionId] });
            queryClient.invalidateQueries({ queryKey: ['automation', 'execution-steps', executionId] });
            return { ...prev, status: 'failed', isLive: false };

          case 'cancelled':
            queryClient.invalidateQueries({ queryKey: ['automation', 'execution', executionId] });
            return { ...prev, status: 'cancelled', isLive: false };

          case 'waiting_for_input':
            queryClient.invalidateQueries({ queryKey: ['automation', 'execution', executionId] });
            return { ...prev, status: 'waiting_for_input' };

          case 'log':
            return {
              ...prev,
              logs: [
                ...prev.logs,
                {
                  level: data.level as string,
                  message: data.message as string,
                  stepId: data.stepId as string | undefined,
                  ts: event.ts,
                },
              ],
            };

          default:
            return prev;
        }
      });
    },
    [executionId, queryClient],
  );

  // Subscribe to the workflow_execution topic only when enabled
  useTopic(enabled ? `workflow_execution.${executionId}` : '', handler);

  return state;
}
