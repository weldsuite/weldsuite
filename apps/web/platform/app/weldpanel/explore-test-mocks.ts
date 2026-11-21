/**
 * A stand-in for `@/hooks/queries/use-weldpanel-analysis-queries` in page
 * tests: no definitions, idle queries and mutations. Use it from a mock
 * factory and override what a test needs:
 *
 *   vi.mock('@/hooks/queries/use-weldpanel-analysis-queries', async () =>
 *     (await import('../explore-test-mocks')).analysisHooksMock());
 */

const noop = () => undefined;

export const idleQuery = { data: undefined, error: null, isLoading: false, isFetching: false, isPlaceholderData: false, refetch: noop };
export const idleMutation = { mutate: noop, mutateAsync: async () => undefined, reset: noop, data: undefined, error: null, isPending: false, isError: false };

export function analysisHooksMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    useWeldPanelCustomEvents: () => ({ data: [] }),
    useWeldPanelComputedProperties: () => ({ data: [] }),
    useWeldPanelGroupTypes: () => ({ data: [] }),
    useWeldPanelFunnelCorrelation: () => idleQuery,
    useExplainWeldPanelChange: () => idleMutation,
    ...overrides,
  };
}
