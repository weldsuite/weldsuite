/**
 * Two-way issue sync between WeldMerge issues and provider issues (GitHub now,
 * GitLab through the same engine). Spec: docs/plans/weldmerge-phases-2-5.md,
 * phase 2.
 *
 * THE ADAPTER BOUNDARY (what a provider implements, and nothing else)
 * -------------------------------------------------------------------
 * The engine never talks to a provider. It calls an `IssueSyncAdapter`
 * (`../providers/types.ts`, picked with `issueAdapterFor(provider)`):
 * `listIssues`, `getIssue`, `createIssue`, `updateIssue`, `listComments`,
 * `createComment`, all in the neutral `NormalizedIssue` / `NormalizedIssueComment`
 * shapes (state `open|closed`, `stateReason` `completed|not_planned|null`, labels
 * by name, assignee login). The provider module registers it as `issues` in its
 * `ProviderModule` (`providers/<name>/index.ts`). An adapter:
 *  - skips whatever is not an issue (GitHub: pull requests; GitLab: merge requests);
 *  - throws `ProviderApiError(provider, status, <its own message>)` for a refusal
 *    and `ProviderUnsupportedError` for what it cannot do;
 *  - reads a provider that has no `state_reason` as `stateReason: completed` when
 *    closed, and writes `stateReason` only if it can;
 *  - makes one `fetch` per call, no retries (calls are compared in conformance).
 *
 * Provider -> WeldMerge (webhooks, imports) is `inbound.ts`: turn the provider's
 * event body into a `NormalizedIssue` / `NormalizedIssueComment` and call
 * `applyInboundIssue(ctx, issue, { create })`, `applyInboundComment(ctx, action,
 * comment)` or `unlinkProviderIssue(ctx, number)` with an `InboundContext`
 * (`{ db, target, userId, hooks? }`, `target` from `loadTargetByExternalId`).
 * They return the entity events to publish (the caller publishes: `system`
 * source for a webhook) and an outcome (`created`, `updated`, `unchanged` or
 * `ignored` + reason). GitHub's body parsing is `handleGithubIssueSyncEvent`
 * in `hooks.ts`; GitLab's event handler is the same shape.
 *
 * WeldMerge -> provider is `outbound.ts`, driven by `../hooks.ts`
 * (`afterIssueUpdated`, `afterCommentChanged`) and by the explicit routes
 * (`createExternalIssue`, `removeExternalIssue`). It needs nothing from the
 * adapter beyond the interface above.
 *
 * Loop guard and ordering: `fields.ts`. `merge_external_issues.checksum` is the
 * sha-256 of the canonical synced fields, always as the PROVIDER last had
 * them (an inbound issue, or the answer to our own call), so the webhook echo
 * of a push is ignored; `last_writer` records who wrote last; an inbound
 * issue older than `provider_updated_at` is stale. Assignees map through the
 * member's linked provider account (`merge_provider_accounts`), labels by
 * name (a missing label becomes a team label), statuses per
 * `providerStateToStatus` / `statusToProviderState`.
 *
 * Failures: an automatic push (hook) is logged by `../hooks.ts` and swallowed;
 * the explicit routes (`POST|DELETE /issues/:id/external`, `POST
 * /repositories/:id/import-issues`) map `ProviderApiError` to 502 `provider_error`.
 */

export * from './fields';
export * from './inbound';
export * from './outbound';
export * from './people';
export * from './targets';
export { handleGithubIssueSyncEvent } from './hooks';
