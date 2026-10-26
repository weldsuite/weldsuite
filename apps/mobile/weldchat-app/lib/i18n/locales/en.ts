export const en = {
  appName: 'WeldChat',
  languageNames: {
    en: 'English',
    nl: 'Nederlands',
  },

  common: {
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    retry: 'Try again',
    search: 'Search',
  },

  login: {
    subtitle: 'Team communication for your workspace',
  },

  // Tab bar titles are also the screen headers, so they must stay in step.
  tabs: {
    home: 'Home',
    directMessages: 'Direct messages',
    activity: 'Activity',
    calls: 'Calls',
  },

  home: {
    saved: 'Saved',
    drafts: 'Drafts',
    channelsGroup: 'Channels',
    addChannel: 'Add channel',
    createChannel: 'Create channel',
    channelCount: {
      one: '{count} channel',
      other: '{count} channels',
    },
    emptyTitle: 'No channels yet',
    emptyHint: 'Create a channel for your team, or start a direct message.',
    emptyCreateChannel: 'Create a channel',
    emptyStartDm: 'Start a direct message',
  },

  dms: {
    filterAll: 'All',
    filterUnread: 'Unread',
    filterFavourites: 'Favourites',
    filterMuted: 'Muted',
    archive: 'Archive',
    mute: 'Mute',
    unmute: 'Unmute',
    pin: 'Pin',
    unpin: 'Unpin',
    emptyTitle: 'No messages yet',
    emptyHint: 'Start a conversation with someone',
    noMessagesPreview: 'No messages yet',
    newDm: 'New direct message',
  },

  activity: {
    emptyTitle: 'No activity yet',
    emptyHint: 'Mentions, thread replies, and DMs will show up here.',
    markAllRead: 'Mark all as read',
  },

  calls: {
    join: 'Join',
    emptyTitle: 'No active calls',
    emptyHint: 'Voice and video calls happening in your conversations will appear here.',
  },

  channel: {
    // Neutral header text while the channel is still loading.
    loadingTitle: 'Loading…',
    channelDetails: 'Channel details',
    startVideoCall: 'Start video call',
    startVoiceCall: 'Start voice call',
    activeNow: 'Active now',
    offline: 'Offline',
    welcome: 'Welcome to #{name}',
    dmConversation: 'Conversation with {name}',
    startOfConversation: 'This is the start of the conversation.',
    archivedNotice: 'This conversation is archived',
    unarchive: 'Unarchive',
    scrollToLatest: 'Scroll to latest messages',
    deleteMessageTitle: 'Delete message',
    deleteMessageBody: 'Are you sure you want to delete this message? This cannot be undone.',
  },

  composer: {
    messageDm: 'Message...',
    messageChannel: 'Message #{name}',
    send: 'Send',
    recordVoice: 'Record voice message',
    attach: 'Add attachment',
  },

  messageActions: {
    reply: 'Reply',
    replyInThread: 'Reply in Thread',
    copyText: 'Copy Text',
    pin: 'Pin Message',
    unpin: 'Unpin',
    save: 'Save Message',
    edit: 'Edit Message',
    delete: 'Delete',
    moreReactions: 'More reactions',
  },

  channelInfo: {
    title: 'Channel details',
    loadFailed: 'Could not load this channel.',
    publicChannel: 'Public channel',
    privateChannel: 'Private channel',
    description: 'Description',
    noDescription: 'No description yet',
    members: 'Members',
    memberCount: {
      one: '{count} member',
      other: '{count} members',
    },
    actions: 'Actions',
    rename: 'Rename channel',
    renameLabel: 'Channel name',
    renamePlaceholder: 'channel-name',
    renamed: 'Channel renamed',
    renameFailed: 'Could not rename the channel.',
    renameTaken: 'A channel with that name already exists.',
    leave: 'Leave channel',
    leaveTitle: 'Leave #{name}?',
    leaveBody: 'You will stop receiving messages from this channel.',
    left: 'You left #{name}',
    leaveFailed: 'Could not leave the channel.',
    ownerCannotLeave: 'Channel owners cannot leave. Transfer ownership first.',
    delete: 'Delete channel',
    deleteTitle: 'Delete #{name}?',
    deleteBody: 'This removes the channel for everyone. This cannot be undone.',
    deleted: 'Channel deleted',
    deleteFailed: 'Could not delete the channel.',
  },

  // Chats on companies, people, tasks, projects and domains.
  recordChats: {
    title: 'Record chats',
    // Quick action card on Home; short, three cards share the row.
    quickAction: 'Records',
    groups: {
      company: 'Companies',
      person: 'People',
      task: 'Tasks',
      project: 'Projects',
      domain: 'Domains',
    },
    types: {
      company: 'Company',
      person: 'Person',
      task: 'Task',
      project: 'Project',
      domain: 'Domain',
    },
    allTypes: 'All types',
    filters: {
      following: 'Following',
      unread: 'Unread',
      mentions: 'Mentions',
      all: 'All',
    },
    showAll: 'Show all ({count})',
    searchPlaceholder: 'Search record chats',
    follow: 'Follow',
    following: 'Following',
    unfollow: 'Unfollow',
    mute: 'Mute',
    unmute: 'Unmute',
    openIn: 'Open in {app}',
    appMissingTitle: '{app} is not installed',
    appMissingBody: 'Install {app} on this device to open the record there.',
    followFailed: 'Could not follow this chat.',
    unfollowFailed: 'Could not unfollow this chat.',
    muteFailed: 'Could not change notifications for this chat.',
    loadFailed: 'Could not load record chats.',
    noMessages: 'No messages yet',
    emptyFollowing: 'You follow no record chats yet. Post in a chat on a company, person, task, project or domain, or follow one under All.',
    emptyUnread: 'You are all caught up.',
    emptyMentions: 'No unread mentions.',
    emptyAll: 'No record chats yet.',
    emptySearch: 'No record chats match "{query}".',
    welcome: 'Chat about {name}',
    messagePlaceholder: 'Message {name}',
  },
};

export type Translations = typeof en;
