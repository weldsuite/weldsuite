/**
 * All 30 home widgets aggregator. Real-data widgets live in their own files
 * (hook + adapter + Render + SettingsForm). Demo widgets (no backing endpoint
 * yet) still go through the thin `wrap()` helper which renders the Card with
 * its hardcoded fixture + a "Demo" badge.
 *
 * As more endpoints get wired, entries move from the `wrap(...)` block at the
 * bottom into their own per-widget files imported at the top.
 */

import type { ReactElement } from 'react';
import { z } from 'zod';
import {
  BarChart3, LifeBuoy, MessageSquare, Slack, MessagesSquare, Bot, Star, Briefcase,
  Workflow, ListTodo, Video, MessageCircle, Hash, Calendar, Phone, FolderOpen, Globe, Mail,
} from 'lucide-react';
import {
  AnalyticsCard,
  DeskCard, DeskEmailsCard, DeskLiveChatCard, DeskSlackCard, DeskDiscordCard,
  DeskAiActiveCard, DeskAiResolvedCard, DeskReviewsCard,
  CrmCard, PipelineCard, SequencesCard,
  ConnectCard, WorkflowsCard,
  MeetCard, MeetHistoryCard,
  ChatCard, ChatDMsCard, ChatChannelsCard,
  CalendarCard, CalendarScheduleCard, CalendarFourDayCard, CalendarDayCard,
  CallCard, DriveCard, HostCard,
} from '@/components/home/app-cards';
import { NoSettingsForm } from '../common';
import type { HomeWidgetDefinition, WidgetId, WidgetModule } from '../types';

// Real-data widgets — each owns its file.
import { weldmailInboxWidget } from './weldmail-inbox';
import { weldflowMyTasksWidget } from './weldflow-my-tasks';
import { weldflowProjectsWidget } from './weldflow-projects';
import { weldflowWorkloadWidget } from './weldflow-workload';
import { welddeskTicketsWidget } from './welddesk-tickets';
import { welddeskEmailsWidget } from './welddesk-emails';
import { welddeskLiveChatWidget } from './welddesk-live-chat';
import { welddeskAiActiveWidget } from './welddesk-ai-active';
import { welddeskAiResolvedWidget } from './welddesk-ai-resolved';
import { welddeskReviewsWidget } from './welddesk-reviews';
import { weldcrmMyTasksWidget } from './weldcrm-my-tasks';
import { weldcrmPipelineWidget } from './weldcrm-pipeline';
import { weldcrmSequencesWidget } from './weldcrm-sequences';
import { weldconnectExecutionsWidget } from './weldconnect-executions';
import { weldconnectWorkflowsWidget } from './weldconnect-workflows';
import { weldmeetUpcomingWidget } from './weldmeet-upcoming';
import { weldmeetHistoryWidget } from './weldmeet-history';
import { weldchatChannelsWidget } from './weldchat-channels';
import { weldcallHistoryWidget } from './weldcall-history';
import { welddriveRecentWidget } from './welddrive-recent';
import { weldhostDomainsWidget } from './weldhost-domains';

const emptySchema = z.object({});
type Empty = z.infer<typeof emptySchema>;

/** Thin wrapper used for widgets that still render their Card with the
 *  hardcoded fixture (no backing endpoint yet). */
function wrap(
  id: WidgetId,
  module: WidgetModule,
  icon: HomeWidgetDefinition['icon'],
  Render: () => ReactElement,
): HomeWidgetDefinition<Empty> {
  return {
    id, module, title: id, description: '', icon,
    schema: emptySchema, defaultSettings: {},
    HomeRender: Render, SettingsForm: NoSettingsForm,
  };
}

export const allWidgets: HomeWidgetDefinition[] = [
  // Wired to real data
  weldmailInboxWidget as unknown as HomeWidgetDefinition,
  weldflowMyTasksWidget as unknown as HomeWidgetDefinition,
  weldflowProjectsWidget as unknown as HomeWidgetDefinition,
  weldflowWorkloadWidget as unknown as HomeWidgetDefinition,
  welddeskTicketsWidget as unknown as HomeWidgetDefinition,
  welddeskEmailsWidget as unknown as HomeWidgetDefinition,
  welddeskLiveChatWidget as unknown as HomeWidgetDefinition,
  welddeskAiActiveWidget as unknown as HomeWidgetDefinition,
  welddeskAiResolvedWidget as unknown as HomeWidgetDefinition,
  welddeskReviewsWidget as unknown as HomeWidgetDefinition,
  weldcrmMyTasksWidget as unknown as HomeWidgetDefinition,
  weldcrmPipelineWidget as unknown as HomeWidgetDefinition,
  weldcrmSequencesWidget as unknown as HomeWidgetDefinition,
  weldconnectExecutionsWidget as unknown as HomeWidgetDefinition,
  weldconnectWorkflowsWidget as unknown as HomeWidgetDefinition,
  weldmeetUpcomingWidget as unknown as HomeWidgetDefinition,
  weldmeetHistoryWidget as unknown as HomeWidgetDefinition,
  weldchatChannelsWidget as unknown as HomeWidgetDefinition,
  weldcallHistoryWidget as unknown as HomeWidgetDefinition,
  welddriveRecentWidget as unknown as HomeWidgetDefinition,
  weldhostDomainsWidget as unknown as HomeWidgetDefinition,

  // Demo widgets — still render their hardcoded fixture with a "Demo" badge.
  // Wiring these needs custom backend work (analytics aggregator, slack/discord
  // feed, chat-activity composer) or substantial date/grouping logic (calendar).
  wrap('analytics-activity', 'analytics', BarChart3, () => <AnalyticsCard isDemo />) as unknown as HomeWidgetDefinition,
  wrap('welddesk-slack', 'welddesk', Slack, () => <DeskSlackCard isDemo />) as unknown as HomeWidgetDefinition,
  wrap('welddesk-discord', 'welddesk', MessagesSquare, () => <DeskDiscordCard isDemo />) as unknown as HomeWidgetDefinition,
  wrap('weldchat-activity', 'weldchat', MessageSquare, () => <ChatCard isDemo />) as unknown as HomeWidgetDefinition,
  wrap('weldchat-dms', 'weldchat', MessageCircle, () => <ChatDMsCard isDemo />) as unknown as HomeWidgetDefinition,
  wrap('weldcalendar-week', 'weldcalendar', Calendar, () => <CalendarCard isDemo />) as unknown as HomeWidgetDefinition,
  wrap('weldcalendar-schedule', 'weldcalendar', Calendar, () => <CalendarScheduleCard isDemo />) as unknown as HomeWidgetDefinition,
  wrap('weldcalendar-4day', 'weldcalendar', Calendar, () => <CalendarFourDayCard isDemo />) as unknown as HomeWidgetDefinition,
  wrap('weldcalendar-day', 'weldcalendar', Calendar, () => <CalendarDayCard isDemo />) as unknown as HomeWidgetDefinition,
];
