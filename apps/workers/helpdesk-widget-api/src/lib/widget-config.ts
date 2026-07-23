/**
 * Shared Widget Configuration Helpers
 *
 * Extracted from config.ts and open.ts to avoid duplicating the ~80-line
 * config object construction and the settings/department queries.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../db';
import { computeAvailability } from './business-hours';

// ============================================================================
// Constants
// ============================================================================

export const REPLY_TIME_TEXT_MAP: Record<string, string> = {
  few_minutes: 'We typically reply in a few minutes',
  few_hours: 'We typically reply in a few hours',
  a_day: 'We typically reply in a day',
};

// ============================================================================
// Data Fetching
// ============================================================================

/**
 * Fetch helpdesk settings and the default department in parallel.
 * Both config.ts and open.ts need these two queries to build the widget config.
 */
export async function fetchWidgetBaseData(db: any) {
  const [settingsResult, departmentResult] = await Promise.all([
    db
      .select({
        general: schema.helpdeskSettings.general,
      })
      .from(schema.helpdeskSettings)
      .where(isNull(schema.helpdeskSettings.deletedAt))
      .limit(1),

    db
      .select({
        businessHours: schema.helpdeskDepartments.businessHours,
        replyTime: schema.helpdeskDepartments.replyTime,
      })
      .from(schema.helpdeskDepartments)
      .where(
        and(
          eq(schema.helpdeskDepartments.isActive, true),
          isNull(schema.helpdeskDepartments.deletedAt)
        )
      )
      .orderBy(schema.helpdeskDepartments.sortOrder)
      .limit(1),
  ]);

  return {
    settings: settingsResult[0] as
      | { general: any }
      | undefined,
    defaultDepartment: departmentResult[0] as
      | { businessHours: any; replyTime: string | null }
      | undefined,
  };
}

// ============================================================================
// Availability
// ============================================================================

/**
 * Compute availability info from resolved business hours and reply time.
 * Returns the full `availability` sub-object used in the widget config.
 */
export function buildAvailabilityInfo(
  businessHours: any,
  replyTime: string
) {
  const { isWithinOfficeHours, nextOpenTime } = computeAvailability(businessHours);
  const replyTimeText = REPLY_TIME_TEXT_MAP[replyTime] || REPLY_TIME_TEXT_MAP['few_hours'];

  return {
    replyTime,
    replyTimeText,
    isWithinOfficeHours,
    nextOpenTime,
    officeHoursTimezone: businessHours?.timezone || null,
    officeHours: businessHours
      ? {
          monday: businessHours.monday,
          tuesday: businessHours.tuesday,
          wednesday: businessHours.wednesday,
          thursday: businessHours.thursday,
          friday: businessHours.friday,
          saturday: businessHours.saturday,
          sunday: businessHours.sunday,
        }
      : null,
  };
}

// ============================================================================
// Config Builder
// ============================================================================

/**
 * Build the shared widget config response object.
 *
 * Both GET /config and POST /open return this exact shape.
 * config.ts additionally spreads `welcome` and `welcomeFlow` on top.
 */
export function buildWidgetConfigResponse(
  widgetConfig: any,
  settings: { general: any } | undefined,
  defaultDepartment: { businessHours: any; replyTime: string | null } | undefined,
  removeBranding: boolean
) {
  const generalSettings = settings?.general;
  const workspaceBusinessHours =
    defaultDepartment?.businessHours || generalSettings?.businessHours || null;
  const replyTime = defaultDepartment?.replyTime || 'few_hours';
  const availability = buildAvailabilityInfo(workspaceBusinessHours, replyTime);

  return {
    widgetId: widgetConfig.widgetId,
    widgetName: widgetConfig.widgetName,
    pages: {
      home: widgetConfig.pageHome ?? true,
      chat: widgetConfig.pageChat ?? true,
      help: widgetConfig.pageHelp ?? true,
      parcelTracking: widgetConfig.pageParcelTracking ?? false,
      changelog: widgetConfig.pageChangelog ?? true,
      news: widgetConfig.pageNews ?? true,
      feedback: widgetConfig.pageFeedback ?? true,
      announcements: widgetConfig.pageAnnouncements ?? true,
      eventSignUp: widgetConfig.pageEventSignUp ?? false,
    },
    colors: {
      primary: widgetConfig.colorPrimary,
      button: widgetConfig.colorButton,
      buttonText: widgetConfig.colorButtonText,
      launcher: widgetConfig.colorLauncher,
      header: widgetConfig.colorHeader,
      accent: widgetConfig.colorAccent,
    },
    styling: {
      borderRadius: widgetConfig.borderRadius,
      fontSize: widgetConfig.fontSize,
      typographyText: widgetConfig.typographyText,
      typographyBackground: widgetConfig.typographyBackground,
    },
    behavior: {
      startingPage: widgetConfig.startingPage,
      position: widgetConfig.position,
      autoOpen: widgetConfig.autoOpen ?? false,
    },
    branding: {
      companyLogoUrl: widgetConfig.companyLogoUrl,
      showBranding: removeBranding ? (widgetConfig.showBranding ?? true) : true,
    },
    chat: {
      backgroundColor: widgetConfig.chatBackgroundColor,
      userBubbleColor: widgetConfig.userBubbleColor,
      userBubbleTextColor: widgetConfig.userBubbleTextColor,
      agentBubbleColor: widgetConfig.agentBubbleColor,
      agentBubbleTextColor: widgetConfig.agentBubbleTextColor,
    },
    availability,
  };
}
