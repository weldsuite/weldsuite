/**
 * Registry of help doc support videos.
 *
 * Each entry records the real platform UI (a /preview/* mirror of the module,
 * answered by fixtures) into public/videos/help/<name>.mp4 plus a poster
 * <name>.jpg. See video-director.mjs for the scripting API.
 */
import weldmailSendEmail from './videos/weldmail-send-email.mjs'
import weldmailReplyToEmail from './videos/weldmail-reply-to-email.mjs'
import weldchatChannelsAndMessages from './videos/weldchat-channels-and-messages.mjs'

import weldflowCreateProject from './videos/weldflow-create-project.mjs'
import welddataFindLeads from './videos/welddata-find-leads.mjs'
import weldhostManageDnsRecords from './videos/weldhost-manage-dns-records.mjs'
import welddeskHandleTickets from './videos/welddesk-handle-tickets.mjs'
import weldcalendarCreateEvents from './videos/weldcalendar-create-events.mjs'

import gettingStartedInstallApps from './videos/getting-started-install-apps.mjs'
import settingsTeamAndPermissions from './videos/settings-team-and-permissions.mjs'

import weldflowMyTasks from './videos/weldflow-my-tasks.mjs'
import weldcrmManageContacts from './videos/weldcrm-manage-contacts.mjs'
import weldhostConnectExternalDomain from './videos/weldhost-connect-external-domain.mjs'
import weldcrmSalesPipeline from './videos/weldcrm-sales-pipeline.mjs'
import weldcalendarBookingPages from './videos/weldcalendar-booking-pages.mjs'

export const videoManifest = [weldmailSendEmail, weldmailReplyToEmail, weldchatChannelsAndMessages, weldflowCreateProject, welddataFindLeads, weldhostManageDnsRecords, welddeskHandleTickets, weldcalendarCreateEvents, gettingStartedInstallApps, settingsTeamAndPermissions, weldflowMyTasks, weldcrmManageContacts, weldhostConnectExternalDomain, weldcrmSalesPipeline, weldcalendarBookingPages]
