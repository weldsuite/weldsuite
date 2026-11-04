/**
 * The shape of `projects.settings` (jsonb): one exported type for every key the
 * WeldFlow project-control and delivery designs put there (docs:
 * weldsuite-documentation, design/modules/weldflow-project-control.md and
 * weldflow-delivery-and-portfolio.md; ADRs FLOW-013, FLOW-015, FLOW-017,
 * FLOW-018).
 *
 * Every key is optional: a project that never set one reads the default
 * below. The type keeps an index signature, because `settings` also carries
 * keys of other features, so a writer must merge into the stored object and
 * never replace it with just its own key.
 *
 * Types only (plus the defaults): no table lives here, so nothing in this file
 * reaches a migration.
 */

/**
 * `changeControl` (FLOW-013): who approves a change request. Under both limits
 * the project manager approves; over either, the change board does, and every
 * board member has to approve.
 */
export interface ProjectChangeControlSettings {
  /** In the project's `budget_currency`. A cost delta at or above this goes to the board. */
  costLimit: number;
  /** In working days. A delay at or above this goes to the board. */
  scheduleLimitDays: number;
  /** Project members (a viewer is enough). While empty, the project manager approves everything. */
  boardMemberIds: string[];
}

/** `schedule` (FLOW-015): the project calendar `computeSchedule` counts working days on. */
export interface ProjectScheduleSettings {
  /** ISO weekdays that are working days: 1 = Monday ... 7 = Sunday. */
  workingDays: number[];
  /** Non-working dates, `YYYY-MM-DD`. */
  holidays: string[];
  /** When on, saving a task move also moves every dependent task. */
  autoSchedule: boolean;
}

/** Who gets a published status report: named stakeholders, or everyone a rule selects. */
export interface StatusReportRecipients {
  /** `project_stakeholders.id` values. */
  stakeholderIds?: string[];
  /** `sponsor`: the sponsor only; `all_stakeholders`; `portal_contacts`: stakeholders with portal access. */
  rule?: 'sponsor' | 'all_stakeholders' | 'portal_contacts';
}

/** `statusReport` (FLOW-018): when the `status_report_due` sweep drafts the next report. */
export interface ProjectStatusReportSettings {
  cadence: 'weekly' | 'biweekly' | 'monthly';
  /** ISO weekday (1 to 7) for weekly and biweekly reports; ignored for monthly (the first working day). */
  weekday: number;
  /** Hour of day, 0 to 23, in the project manager's time zone. */
  hour: number;
  recipients: StatusReportRecipients;
}

/** One row of the communication plan (who hears what, how often, through which channel). */
export interface CommunicationPlanEntry {
  what: string;
  audience: string;
  cadence: string;
  channel: string;
}

/**
 * `closing` (slice F): what the close page recorded. Each hand-over names the
 * person who took an open RAID item over, keyed by the item's id, so the
 * checklist can tell an item that was handed over from one that merely has an
 * owner. Merge-written by `POST /api/project-close/:projectId/handover`.
 */
export interface ProjectClosingSettings {
  handovers: Record<string, { ownerId: string; by: string; at: string }>;
}

/** One manual forecast at completion, with why (slice E). `amount: null` records that the manual forecast was cleared. */
export interface ProjectManualForecast {
  amount: number | null;
  reason: string | null;
  /** The member who set it. */
  setBy: string;
  /** ISO date-time. */
  setAt: string;
}

/** `finance` (FLOW-019): the project manager's manual forecast and the history of it (slice E). */
export interface ProjectFinanceSettings {
  /** Replaces budget / CPI as the forecast while set. */
  manualForecast: ProjectManualForecast | null;
  /** Every change, newest first, at most 25. */
  history: ProjectManualForecast[];
}

export interface ProjectSettings {
  // slice E:
  finance?: ProjectFinanceSettings;
  changeControl?: ProjectChangeControlSettings;
  schedule?: ProjectScheduleSettings;
  statusReport?: ProjectStatusReportSettings;
  communicationPlan?: CommunicationPlanEntry[];
  /** `project_phases.id` of the active phase (set by gate approval). */
  currentPhaseId?: string | null;
  /**
   * The project sponsor's user id. Several approval rules route to the sponsor
   * (stage gates, deliverable sign-off, accepting a risk scoring 9 or more,
   * closing the project); with no sponsor set they fall back to the project
   * manager (`projects.project_manager_id`).
   */
  sponsorId?: string | null;
  /**
   * The highest risk score (1 to 25) the project accepts without escalating;
   * the status report's risk colour reads it (FLOW-018, open question: it may
   * move to workspace level).
   */
  riskAppetite?: number;
  /** slice F: hand-overs recorded on the close page. */
  closing?: ProjectClosingSettings;
  /** slice F: the project template this project was created from (`POST /api/project-templates/:id/instantiate`). */
  templateId?: string;
  /** Other features' keys. */
  [key: string]: unknown;
}

/** Defaults for a new project (FLOW-013: 5.000 and 5 working days, the board empty until set). */
export const DEFAULT_CHANGE_CONTROL: Readonly<ProjectChangeControlSettings> = {
  costLimit: 5000,
  scheduleLimitDays: 5,
  boardMemberIds: [],
};

/** Default calendar: Monday to Friday, no holidays, no automatic rescheduling (FLOW-015). */
export const DEFAULT_SCHEDULE_SETTINGS: Readonly<ProjectScheduleSettings> = {
  workingDays: [1, 2, 3, 4, 5],
  holidays: [],
  autoSchedule: false,
};

/** Default risk appetite: up to the top of the medium band (a high risk, 10 or more, is outside it). */
export const DEFAULT_RISK_APPETITE = 9;
