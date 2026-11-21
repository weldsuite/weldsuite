/**
 * WeldPanel collaboration, monitoring and data-out hooks: annotations,
 * comments, report versions, share links, dashboard filters / text tiles /
 * templates (the `weldpanelCollab` and `weldpanel.dashboards` clients), and
 * alerts, scheduled reports, raw exports and custom collector domains (the
 * `weldpanelMonitor` client). Also the public share page's hooks, which send
 * no session at all.
 *
 * Keys build on `weldpanelKeys.all`, like every WeldPanel hook, so a
 * realtime refresh of `weldpanel` reaches them too. Mutations refresh what
 * they change; pages only call `mutate`.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useAppApi } from '@/lib/api/use-app-api';
import { getApiOriginForPath } from '@/lib/api/public-env';
import { createWeldPanelPublicShareApi } from '@weldsuite/app-api-client/domains/weldpanel-collab';
import type {
  CreatePanelAnnotationInput,
  CreatePanelCommentInput,
  CreatePanelDashboardFromTemplateInput,
  CreatePanelShareLinkInput,
  PanelAnnotationListParams,
  PanelPublicResultsInput,
  PanelTargetParams,
  PanelTemplateLocale,
  UpdatePanelAnnotationInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type {
  CreatePanelAlertInput,
  CreatePanelExportInput,
  CreatePanelSubscriptionInput,
  PanelAlertListParams,
  PanelSubscriptionListParams,
  SnoozePanelAlertInput,
  TestPanelExportInput,
  UpdatePanelAlertInput,
  UpdatePanelExportInput,
  UpdatePanelSubscriptionInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import type { PanelReportDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { weldpanelKeys } from './use-weldpanel-queries';

export const weldpanelCollabKeys = {
  annotations: () => [...weldpanelKeys.all, 'annotations'] as const,
  annotationList: (params: PanelAnnotationListParams) => [...weldpanelCollabKeys.annotations(), 'list', params] as const,

  comments: () => [...weldpanelKeys.all, 'comments'] as const,
  commentList: (target: PanelTargetParams) => [...weldpanelCollabKeys.comments(), target.targetType, target.targetId] as const,

  /** Under the report's own key, so refreshing a report refreshes its history. */
  reportVersions: (reportId: string) => [...weldpanelKeys.report(reportId), 'versions'] as const,
  reportVersion: (reportId: string, version: number) => [...weldpanelCollabKeys.reportVersions(reportId), version] as const,

  shareLinks: () => [...weldpanelKeys.all, 'share-links'] as const,
  shareLinkList: (target: PanelTargetParams) => [...weldpanelCollabKeys.shareLinks(), target.targetType, target.targetId] as const,

  dashboardTemplates: (locale: string) => [...weldpanelKeys.dashboards(), 'templates', locale] as const,

  alerts: () => [...weldpanelKeys.all, 'alerts'] as const,
  alertList: (params: PanelAlertListParams) => [...weldpanelCollabKeys.alerts(), 'list', params] as const,
  alert: (id: string) => [...weldpanelCollabKeys.alerts(), 'detail', id] as const,
  alertEvents: (id: string) => [...weldpanelCollabKeys.alert(id), 'events'] as const,

  subscriptions: () => [...weldpanelKeys.all, 'subscriptions'] as const,
  subscriptionList: (params: PanelSubscriptionListParams) => [...weldpanelCollabKeys.subscriptions(), 'list', params] as const,

  exports: () => [...weldpanelKeys.all, 'exports'] as const,
  exportList: (projectId: string) => [...weldpanelCollabKeys.exports(), 'list', projectId] as const,
  exportRuns: (id: string) => [...weldpanelCollabKeys.exports(), 'runs', id] as const,

  /** Under the project, like its keys. */
  domains: (projectId: string) => [...weldpanelKeys.project(projectId), 'domains'] as const,

  /** The public share page (no session): its own root, never persisted. */
  publicShare: (token: string) => ['weldpanel-public-share', token] as const,
  publicResult: (token: string, input: PanelPublicResultsInput) => [...weldpanelCollabKeys.publicShare(token), 'result', input] as const,
};

/** How often a pending custom domain is re-read while the page is open. */
export const DOMAIN_POLL_MS = 30_000;

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/** Project-wide annotations in the range, plus the report's own when `reportId` is given. */
export function useWeldPanelAnnotations(params: PanelAnnotationListParams, enabled = true) {
  const { weldpanelCollab } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.annotationList(params),
    queryFn: () => weldpanelCollab.annotations.list(params),
    select: (res) => res.data,
    enabled: enabled && params.projectId !== '',
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

function useRefreshAnnotations() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: weldpanelCollabKeys.annotations() });
}

export function useCreateWeldPanelAnnotation() {
  const { weldpanelCollab } = useAppApi();
  const refresh = useRefreshAnnotations();
  return useMutation({
    mutationFn: (input: CreatePanelAnnotationInput) => weldpanelCollab.annotations.create(input).then((res) => res.data),
    onSuccess: refresh,
  });
}

export function useUpdateWeldPanelAnnotation() {
  const { weldpanelCollab } = useAppApi();
  const refresh = useRefreshAnnotations();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & UpdatePanelAnnotationInput) => weldpanelCollab.annotations.update(id, input).then((res) => res.data),
    onSuccess: refresh,
  });
}

export function useDeleteWeldPanelAnnotation() {
  const { weldpanelCollab } = useAppApi();
  const refresh = useRefreshAnnotations();
  return useMutation({
    mutationFn: (id: string) => weldpanelCollab.annotations.remove(id),
    onSuccess: refresh,
  });
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export function useWeldPanelComments(target: PanelTargetParams, enabled = true) {
  const { weldpanelCollab } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.commentList(target),
    queryFn: () => weldpanelCollab.comments.list(target),
    select: (res) => res.data,
    enabled: enabled && target.targetId !== '',
  });
}

export function useCreateWeldPanelComment() {
  const { weldpanelCollab } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePanelCommentInput) => weldpanelCollab.comments.create(input).then((res) => res.data),
    onSuccess: (comment) =>
      void queryClient.invalidateQueries({ queryKey: weldpanelCollabKeys.commentList({ targetType: comment.targetType, targetId: comment.targetId }) }),
  });
}

export function useUpdateWeldPanelComment() {
  const { weldpanelCollab } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => weldpanelCollab.comments.update(id, { body }).then((res) => res.data),
    onSuccess: (comment) =>
      void queryClient.invalidateQueries({ queryKey: weldpanelCollabKeys.commentList({ targetType: comment.targetType, targetId: comment.targetId }) }),
  });
}

export function useDeleteWeldPanelComment(target: PanelTargetParams) {
  const { weldpanelCollab } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldpanelCollab.comments.remove(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldpanelCollabKeys.commentList(target) }),
  });
}

// ---------------------------------------------------------------------------
// Report versions
// ---------------------------------------------------------------------------

export function useWeldPanelReportVersions(reportId: string, enabled = true) {
  const { weldpanelCollab } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.reportVersions(reportId),
    queryFn: () => weldpanelCollab.reportVersions.list(reportId),
    select: (res) => res.data,
    enabled: enabled && reportId !== '',
  });
}

/** One version with its spec (to show what it was). */
export function useWeldPanelReportVersion(reportId: string, version: number | null) {
  const { weldpanelCollab } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.reportVersion(reportId, version ?? 0),
    queryFn: () => weldpanelCollab.reportVersions.get(reportId, version ?? 0),
    select: (res) => res.data,
    enabled: reportId !== '' && version !== null,
  });
}

/** Puts a version back; the report (and its history, under its key) refreshes. 409 when that spec no longer parses. */
export function useRestoreWeldPanelReportVersion(reportId: string) {
  const { weldpanelCollab } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => weldpanelCollab.reportVersions.restore(reportId, version).then((res) => res.data),
    onSuccess: (report: PanelReportDto) => {
      queryClient.setQueryData(weldpanelKeys.report(report.id), { data: report });
      void queryClient.invalidateQueries({ queryKey: weldpanelCollabKeys.reportVersions(report.id) });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.reports(), 'list'] });
      void queryClient.invalidateQueries({ queryKey: weldpanelKeys.dashboards() });
    },
  });
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

export function useWeldPanelShareLinks(target: PanelTargetParams, enabled = true) {
  const { weldpanelCollab } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.shareLinkList(target),
    queryFn: () => weldpanelCollab.shareLinks.list(target),
    select: (res) => res.data,
    enabled: enabled && target.targetId !== '',
  });
}

/** The answer carries the token and URL once; 422 `NOT_SHAREABLE` (with `details.reasons`) for people data. */
export function useCreateWeldPanelShareLink() {
  const { weldpanelCollab } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePanelShareLinkInput) => weldpanelCollab.shareLinks.create(input).then((res) => res.data),
    onSuccess: (link) =>
      void queryClient.invalidateQueries({ queryKey: weldpanelCollabKeys.shareLinkList({ targetType: link.targetType, targetId: link.targetId }) }),
  });
}

export function useRevokeWeldPanelShareLink(target: PanelTargetParams) {
  const { weldpanelCollab } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldpanelCollab.shareLinks.revoke(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldpanelCollabKeys.shareLinkList(target) }),
  });
}

// ---------------------------------------------------------------------------
// Dashboards: templates and text tiles
// ---------------------------------------------------------------------------

export function useWeldPanelDashboardTemplates(locale: PanelTemplateLocale, enabled = true) {
  const { weldpanel } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.dashboardTemplates(locale),
    queryFn: () => weldpanel.dashboards.templates(locale),
    select: (res) => res.data,
    enabled,
    staleTime: 60 * 60_000,
  });
}

/** Creates the template's reports and the dashboard; the dashboard lands in the cache as `get` answers it. */
export function useCreateWeldPanelDashboardFromTemplate() {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePanelDashboardFromTemplateInput) => weldpanel.dashboards.createFromTemplate(input).then((res) => res.data),
    onSuccess: (dashboard) => {
      queryClient.setQueryData(weldpanelKeys.dashboard(dashboard.id), { data: dashboard });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.dashboards(), 'list'] });
      void queryClient.invalidateQueries({ queryKey: [...weldpanelKeys.reports(), 'list'] });
    },
  });
}

/** Changes a text tile's Markdown (the general tile hook only moves tiles). */
export function useUpdateWeldPanelTextTile(dashboardId: string) {
  const { weldpanel } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ tileId, text }: { tileId: string; text: string }) => weldpanel.dashboards.updateTile(dashboardId, tileId, { text }).then((res) => res.data),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: weldpanelKeys.dashboard(dashboardId) }),
  });
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export function useWeldPanelAlerts(params: PanelAlertListParams, enabled = true) {
  const { weldpanelMonitor } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.alertList(params),
    queryFn: () => weldpanelMonitor.alerts.list(params),
    select: (res) => res.data,
    enabled,
  });
}

export function useWeldPanelAlert(id: string) {
  const { weldpanelMonitor } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.alert(id),
    queryFn: () => weldpanelMonitor.alerts.get(id),
    select: (res) => res.data,
    enabled: id !== '',
  });
}

/** An alert's history, newest first (the first 50). */
export function useWeldPanelAlertEvents(id: string, enabled = true) {
  const { weldpanelMonitor } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.alertEvents(id),
    queryFn: () => weldpanelMonitor.alerts.events(id, { limit: 50 }),
    select: (res) => res.data,
    enabled: enabled && id !== '',
  });
}

function useRefreshAlerts() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: weldpanelCollabKeys.alerts() });
}

export function useCreateWeldPanelAlert() {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshAlerts();
  return useMutation({
    mutationFn: (input: CreatePanelAlertInput) => weldpanelMonitor.alerts.create(input).then((res) => res.data),
    onSuccess: refresh,
  });
}

export function useUpdateWeldPanelAlert() {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshAlerts();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & UpdatePanelAlertInput) => weldpanelMonitor.alerts.update(id, input).then((res) => res.data),
    onSuccess: refresh,
  });
}

export function useDeleteWeldPanelAlert() {
  const { weldpanelMonitor } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => weldpanelMonitor.alerts.remove(id),
    onSuccess: (_void, id) => {
      queryClient.removeQueries({ queryKey: weldpanelCollabKeys.alert(id) });
      void queryClient.invalidateQueries({ queryKey: weldpanelCollabKeys.alerts() });
    },
  });
}

/** Sends a test message on every channel; answers what each channel did. */
export function useTestWeldPanelAlert() {
  const { weldpanelMonitor } = useAppApi();
  return useMutation({
    mutationFn: (id: string) => weldpanelMonitor.alerts.test(id).then((res) => res.data),
  });
}

export function useSnoozeWeldPanelAlert() {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshAlerts();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & SnoozePanelAlertInput) => weldpanelMonitor.alerts.snooze(id, input).then((res) => res.data),
    onSuccess: refresh,
  });
}

// ---------------------------------------------------------------------------
// Subscriptions (scheduled reports)
// ---------------------------------------------------------------------------

export function useWeldPanelSubscriptions(params: PanelSubscriptionListParams, enabled = true) {
  const { weldpanelMonitor } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.subscriptionList(params),
    queryFn: () => weldpanelMonitor.subscriptions.list(params),
    select: (res) => res.data,
    enabled,
  });
}

function useRefreshSubscriptions() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: weldpanelCollabKeys.subscriptions() });
}

export function useCreateWeldPanelSubscription() {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshSubscriptions();
  return useMutation({
    mutationFn: (input: CreatePanelSubscriptionInput) => weldpanelMonitor.subscriptions.create(input).then((res) => res.data),
    onSuccess: refresh,
  });
}

export function useUpdateWeldPanelSubscription() {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshSubscriptions();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & UpdatePanelSubscriptionInput) => weldpanelMonitor.subscriptions.update(id, input).then((res) => res.data),
    onSuccess: refresh,
  });
}

export function useDeleteWeldPanelSubscription() {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshSubscriptions();
  return useMutation({
    mutationFn: (id: string) => weldpanelMonitor.subscriptions.remove(id),
    onSuccess: refresh,
  });
}

export function useSendWeldPanelSubscriptionNow() {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshSubscriptions();
  return useMutation({
    mutationFn: (id: string) => weldpanelMonitor.subscriptions.sendNow(id).then((res) => res.data),
    onSuccess: refresh,
  });
}

// ---------------------------------------------------------------------------
// Raw exports
// ---------------------------------------------------------------------------

export function useWeldPanelExports(projectId: string, enabled = true) {
  const { weldpanelMonitor } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.exportList(projectId),
    queryFn: () => weldpanelMonitor.exports.list(projectId),
    select: (res) => res.data,
    enabled: enabled && projectId !== '',
  });
}

/** An export's runs, newest first (the first 50). */
export function useWeldPanelExportRuns(id: string, enabled = true) {
  const { weldpanelMonitor } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.exportRuns(id),
    queryFn: () => weldpanelMonitor.exports.runs(id, { limit: 50 }),
    select: (res) => res.data,
    enabled: enabled && id !== '',
  });
}

function useRefreshExports() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: weldpanelCollabKeys.exports() });
}

export function useCreateWeldPanelExport() {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshExports();
  return useMutation({
    mutationFn: (input: CreatePanelExportInput) => weldpanelMonitor.exports.create(input).then((res) => res.data),
    onSuccess: refresh,
  });
}

export function useUpdateWeldPanelExport() {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshExports();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string } & UpdatePanelExportInput) => weldpanelMonitor.exports.update(id, input).then((res) => res.data),
    onSuccess: refresh,
  });
}

export function useDeleteWeldPanelExport() {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshExports();
  return useMutation({
    mutationFn: (id: string) => weldpanelMonitor.exports.remove(id),
    onSuccess: refresh,
  });
}

export function usePauseWeldPanelExport() {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshExports();
  return useMutation({
    mutationFn: ({ id, pause }: { id: string; pause: boolean }) =>
      (pause ? weldpanelMonitor.exports.pause(id) : weldpanelMonitor.exports.resume(id)).then((res) => res.data),
    onSuccess: refresh,
  });
}

/** Writes and deletes a test file at the destination. */
export function useTestWeldPanelExport() {
  const { weldpanelMonitor } = useAppApi();
  return useMutation({
    mutationFn: (input: TestPanelExportInput) => weldpanelMonitor.exports.test(input).then((res) => res.data),
  });
}

// ---------------------------------------------------------------------------
// Custom collector domains
// ---------------------------------------------------------------------------

/** 503 `FEATURE_UNAVAILABLE` where Cloudflare for SaaS is not set up: no retries then. Polls while one is pending. */
export function useWeldPanelDomains(projectId: string, enabled = true) {
  const { weldpanelMonitor } = useAppApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.domains(projectId),
    queryFn: () => weldpanelMonitor.domains.list(projectId),
    select: (res) => res.data,
    enabled: enabled && projectId !== '',
    retry: false,
    refetchInterval: (query) => (query.state.data?.data.some((d) => d.status === 'pending' || d.status === 'deleting') ? DOMAIN_POLL_MS : false),
  });
}

function useRefreshDomains(projectId: string) {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: weldpanelCollabKeys.domains(projectId) });
}

export function useCreateWeldPanelDomain(projectId: string) {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshDomains(projectId);
  return useMutation({
    mutationFn: (hostname: string) => weldpanelMonitor.domains.create(projectId, { hostname }).then((res) => res.data),
    onSuccess: refresh,
  });
}

export function useRefreshWeldPanelDomain(projectId: string) {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshDomains(projectId);
  return useMutation({
    mutationFn: (domainId: string) => weldpanelMonitor.domains.refresh(projectId, domainId).then((res) => res.data),
    onSuccess: refresh,
  });
}

/** May answer 202 while Cloudflare's delete is retried; the list shows the domain as deleting until it is gone. */
export function useDeleteWeldPanelDomain(projectId: string) {
  const { weldpanelMonitor } = useAppApi();
  const refresh = useRefreshDomains(projectId);
  return useMutation({
    mutationFn: (domainId: string) => weldpanelMonitor.domains.remove(projectId, domainId),
    onSuccess: refresh,
  });
}

// ---------------------------------------------------------------------------
// Public share page (no session)
// ---------------------------------------------------------------------------

/** The public share client: panel-api's origin, no credentials. */
export function usePublicShareApi() {
  return useMemo(() => createWeldPanelPublicShareApi({ baseUrl: getApiOriginForPath('/public/panel/share') }), []);
}

/** What a share link shows. A 404 (unknown, revoked or expired) is not retried. */
export function useWeldPanelPublicShare(token: string) {
  const api = usePublicShareApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.publicShare(token),
    queryFn: () => api.get(token),
    enabled: token !== '',
    retry: false,
    staleTime: 60_000,
    meta: { persist: false },
  });
}

/** One report's result on a share link (`tileId` for a dashboard tile). */
export function useWeldPanelPublicResult(token: string, input: PanelPublicResultsInput, enabled = true) {
  const api = usePublicShareApi();
  return useQuery({
    queryKey: weldpanelCollabKeys.publicResult(token, input),
    queryFn: () => api.results(token, input),
    enabled: enabled && token !== '',
    retry: false,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    meta: { persist: false },
  });
}
