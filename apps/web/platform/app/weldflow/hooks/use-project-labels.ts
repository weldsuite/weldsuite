import { useEffect, useState } from 'react';
import { labelsApi, type ApiProjectLabel } from '@/app/weldflow/lib/api-client';

/** This project's labels (plus legacy workspace-wide labels), with a setter for optimistic additions. */
export function useProjectLabels(projectId: string) {
  const [labels, setLabels] = useState<ApiProjectLabel[]>([]);

  useEffect(() => {
    async function loadLabels() {
      const result = await labelsApi.list(projectId);
      if (result.success && result.data) {
        setLabels(result.data);
      }
    }
    void loadLabels();
  }, [projectId]);

  return [labels, setLabels] as const;
}
