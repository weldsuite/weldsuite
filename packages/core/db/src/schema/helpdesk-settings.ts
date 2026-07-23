import {
  pgTable,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
} from 'drizzle-orm/pg-core';

// Settings types
export interface BusinessHours {
  timezone: string;
  monday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  tuesday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  wednesday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  thursday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  friday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  saturday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  sunday?: { isOpen: boolean; openTime?: string; closeTime?: string };
  holidays?: { date: string; name: string; isRecurring?: boolean }[];
}

export interface GeneralSettings {
  companyName: string;
  supportEmail: string;
  defaultLanguage: string;
  timezone: string;
  businessHours: BusinessHours;
}

export interface TicketSettings {
  autoAssignment: boolean;
  requireApproval: boolean;
  allowCustomerCreation: boolean;
  defaultPriority: string;
  defaultStatus: string;
  autoCloseAfterDays?: number;
  mergeThreshold?: number;
  assignmentStrategy?: 'round_robin' | 'least_busy' | 'manual';
}

export interface NotificationSettings {
  emailNotifications: boolean;
  pushNotifications: boolean;
  smsNotifications: boolean;
  notifyOnNewTicket: boolean;
  notifyOnAssignment: boolean;
  notifyOnStatusChange: boolean;
  notifyOnCustomerReply: boolean;
  notifyOnSLABreach: boolean;
}

export interface SatisfactionSettings {
  enableSurveys: boolean;
  sendAfterResolution: boolean;
  delayMinutes?: number;
  surveyTemplate?: string;
  thankYouMessage?: string;
}

export interface AutomationSettings {
  enabled: boolean;
  slaBreachAction?: 'escalate_and_notify' | 'notify_only' | 'none';
  priorityAlertThreshold?: ('urgent' | 'high')[];
}

export interface IntegrationSettings {
  slack?: {
    enabled: boolean;
    webhookUrl: string;
    channel?: string;
  };
  email?: {
    enabled: boolean;
    incomingServer: string;
    outgoingServer: string;
    username: string;
  };
  chat?: {
    enabled: boolean;
    provider: string;
    apiKey: string;
  };
}

export interface CustomizationSettings {
  logoUrl?: string;
  primaryColor?: string;
  customCSS?: string;
  emailTemplate?: string;
  customFields?: {
    name: string;
    type: 'text' | 'number' | 'date' | 'select' | 'multiselect';
    required: boolean;
    options?: string[];
  }[];
}

export const helpdeskSettings = pgTable('helpdesk_settings', {
  // BaseEntity fields
  id: varchar('id', { length: 30 }).primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),

  // Settings sections
  general: jsonb('general').$type<GeneralSettings>(),
  tickets: jsonb('tickets').$type<TicketSettings>(),
  notifications: jsonb('notifications').$type<NotificationSettings>(),
  satisfaction: jsonb('satisfaction').$type<SatisfactionSettings>(),
  integrations: jsonb('integrations').$type<IntegrationSettings>(),
  customization: jsonb('customization').$type<CustomizationSettings>(),
  automation: jsonb('automation').$type<AutomationSettings>(),
});

export type HelpdeskSettings = typeof helpdeskSettings.$inferSelect;
export type NewHelpdeskSettings = typeof helpdeskSettings.$inferInsert;
