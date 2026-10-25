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
    emptyTitle: 'No calls yet',
    emptyHint: 'Voice and video calls you make and receive will appear here.',
    // Section headers, and the status of a call that is still going.
    ongoing: 'Ongoing',
    recent: 'Recent',
    ongoingVoiceCall: 'Ongoing voice call',
    ongoingVideoCall: 'Ongoing video call',
    participantCount: {
      one: '{count} participant',
      other: '{count} participants',
    },
    voiceCall: 'Voice call',
    videoCall: 'Video call',
    // How a call went, as the first half of a row's subtitle ("Missed · Voice call").
    incoming: 'Incoming',
    outgoing: 'Outgoing',
    missed: 'Missed',
    // Your own call that nobody picked up.
    noAnswer: 'No answer',
    declined: 'Declined',
    yesterday: 'Yesterday',
    callBack: 'Call back',
    unknown: 'Unknown',
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
    sendFailed: 'Message failed to send',
    cancelRecording: 'Discard voice message',
    sendVoice: 'Send voice message',
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
};

export type Translations = typeof en;
