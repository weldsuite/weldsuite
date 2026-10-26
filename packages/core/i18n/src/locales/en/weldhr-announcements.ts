/**
 * WeldHR — announcements: news the HR team posts for employees.
 * Composed into `weldhr` by ./weldhr.ts (keys are `weldhr.announcements.*`).
 */
export const weldhrAnnouncements = {
  announcements: {
    title: 'Announcements',
    loadFailed: 'Could not load the announcements.',
    add: 'New announcement',
    addTitle: 'New announcement',
    editTitle: 'Edit announcement',
    searchPlaceholder: 'Search announcements',
    pinned: 'Pinned',
    groups: {
      pinned: 'Pinned',
      other: 'Announcements',
    },
    table: {
      title: 'Announcement',
      audience: 'Audience',
      read: 'Read by',
      published: 'Posted',
    },
    everyone: 'Everyone',
    readOf: '{read} of {total}',
    pushSent: 'Push notification sent',
    empty: {
      title: 'No announcements yet',
      description: 'Post news for your employees. They see it in My HR and in the WeldHR app.',
    },
    form: {
      title: 'Title',
      titlePlaceholder: 'What is this about?',
      body: 'Message',
      bodyPlaceholder: 'Write your announcement. Line breaks are kept.',
      pinned: 'Pin to the top',
      pinnedHint: 'Pinned announcements stay above newer ones.',
      audience: 'Audience',
      audienceHint: 'Leave on everyone, or pick departments. Their sub-departments are included.',
      selectDepartments: 'Select departments',
      searchDepartments: 'Search departments',
      noDepartments: 'No departments found.',
      notify: 'Send a push notification',
      notifyHint: 'Notifies the audience in the WeldHR app, once. Editing the announcement later does not send another.',
      save: 'Save',
      saving: 'Saving…',
      create: 'Post announcement',
      cancel: 'Cancel',
      failed: 'Could not save this announcement.',
    },
    delete: {
      title: 'Delete this announcement?',
      description: 'Delete "{title}"? Employees will no longer see it.',
      failed: 'Could not delete this announcement.',
    },
    reads: {
      title: 'Read by',
      summary: '{read} of {total} employees have read this.',
      readTab: 'Read ({count})',
      notReadTab: 'Not read ({count})',
      readAt: 'Read {date}',
      emptyRead: 'Nobody has read this yet.',
      emptyNotRead: 'Everyone has read this.',
      loadFailed: 'Could not load who has read this.',
    },
  },
};
