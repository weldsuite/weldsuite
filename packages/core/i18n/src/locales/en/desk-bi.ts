/**
 * WeldDesk → Reports → BI connector: the OData feed Power BI and Excel read
 * (apps/web/platform/app/welddesk/bi-connector, TASK-1235).
 */
export const deskBi = {
  title: 'BI connector',
  description: 'Read your helpdesk data in Power BI or Excel over a read-only OData feed.',
  feed: {
    title: 'Feed URL',
    description: 'Paste this address into Power BI or Excel. It lists every table below.',
    label: 'OData feed URL',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Could not copy. Select the address and copy it by hand.',
  },
  key: {
    title: 'API key',
    description:
      'The feed is read with an API key, sent as the password. Create a key with the Reports (BI connector) permission: it can read helpdesk data and nothing else.',
    action: 'Create an API key',
  },
  tables: {
    title: 'Tables',
    description: 'Each table is read-only. Message text, attachments and call recordings are never included.',
    name: 'Table',
    contains: 'Contains',
    items: {
      Conversations: 'Conversations with their state, channel, assignee, priority, SLA and timings',
      Messages: 'Every message, note and event on a conversation, without the text',
      SlaClocks: 'The SLA clocks of each conversation: target, elapsed time and breaches',
      Calls: 'Phone calls with direction, outcome, queue time and duration',
      Teams: 'Teams and how they are set up',
      TicketTypes: 'Ticket types and their defaults',
      Agents: 'Workspace members and whether they are active',
      Problems: 'Problems with root cause, workaround and resolution',
      CatalogItems: 'Items of the service catalogue',
      Articles: 'Help centre articles with views and votes, without the text',
    },
  },
  powerBi: {
    title: 'Connect Power BI',
    steps: [
      'In Power BI Desktop, choose Get data, then OData feed.',
      'Paste the feed URL and choose OK.',
      'Choose Basic. Enter any username and the API key as the password.',
      'Pick the tables you need and choose Load.',
    ],
  },
  excel: {
    title: 'Connect Excel',
    steps: [
      'Open the Data tab and choose Get Data, From Other Sources, From OData Feed.',
      'Paste the feed URL and choose OK.',
      'Choose Basic. Enter any username and the API key as the password.',
      'Pick the tables you need and choose Load.',
    ],
  },
  refresh: {
    title: 'Refresh in the Power BI service',
    body: 'After you publish a report, open the dataset settings in the Power BI service, edit the data source credentials and choose Basic with the same username and API key. Without this a scheduled refresh fails.',
  },
};
