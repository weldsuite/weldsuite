/**
 * WeldBooks "connected bookkeeping" screens (phase 1): the To process page and
 * its kinds, the list views the owner's shortcuts open, the one Contacts list,
 * the overview callout and the palette commands. Plurals are `{ one, other }`
 * with a `{count}` placeholder. Reachable as `t.weldbooksConnected`.
 */
export const weldbooksConnected = {
  todo: {
    title: 'To process',
    description: 'Everything in your books that needs a person, most urgent first.',
    loadFailed: 'Your to-process list could not be loaded.',
    emptyTitle: 'All caught up',
    emptyDescription: 'Nothing needs your attention right now. New items show up here as they arrive.',
    showAll: 'Show all {count}',
    showFewer: 'Show fewer',
    loadMore: 'Load more',
    loadingMore: 'Loading…',
    listFailed: 'These items could not be loaded.',
    mixedCurrency: 'Mixed currencies, shown in {currency}',
    dueOn: 'Due {date}',
    kinds: {
      vat_return: {
        title: 'Tax return to file',
        action: 'Open the return',
      },
      bank_feeds: {
        title: 'Bank connections',
        action: 'Review bank connections',
      },
      invoices_overdue: {
        title: 'Overdue invoices',
        action: 'View overdue invoices',
      },
      bills_due: {
        title: 'Bills to pay',
        action: 'View bills to pay',
      },
      bills_to_approve: {
        title: 'Bills to approve',
        action: 'View bills to approve',
      },
      documents: {
        title: 'Inbox',
        action: { one: 'Check 1 document', other: 'Check {count} documents' },
      },
      duplicates: {
        title: 'Possible duplicates',
        action: 'Review duplicates',
      },
      bank_lines: {
        title: 'Bank lines',
        action: { one: 'Process 1 line', other: 'Process {count} lines' },
      },
      unapplied_credit: {
        title: 'Unapplied credit',
        action: 'View unapplied credit',
      },
    },
    hints: {
      possible_match: 'Possible match found',
      possible_duplicate: 'Possible duplicate',
      ocr_failed: 'Scan failed, check by hand',
      awaiting_approval: 'Awaiting approval',
      overdue: 'Overdue',
      overdue_partial: 'Overdue, partly paid',
      due_soon: 'Due soon',
      not_filed: 'Not filed yet',
      rejected: 'Rejected',
      connection_error: 'Connection error',
      reauth_required: 'Reconnect needed',
      consent_expiring: 'Consent expires soon',
      unapplied_credit: 'Unapplied credit',
    },
    severity: {
      info: 'For your information',
      warning: 'Needs attention soon',
      danger: 'Needs attention now',
    },
  },
  listViews: {
    filterLabel: 'Show',
    open: 'Open',
    overdue: 'Overdue',
    dueSoon: 'Due this week or overdue',
  },
  contacts: {
    searchPlaceholder: 'Search contacts...',
    newContact: 'New contact',
    noContacts: 'No contacts found',
    emptyDescription: 'Create your first contact to get started',
    filterRoleLabel: 'Show',
    roleAll: 'All',
    roleCustomers: 'Customers',
    colName: 'Name',
    colEmail: 'Email',
    colRole: 'Role',
  },
  dashboard: {
    calloutTitle: {
      one: '1 thing to process',
      other: '{count} things to process',
    },
    calloutDescription: 'Bank lines, documents, bills and more are waiting for you.',
    calloutAction: 'Go to To process',
  },
  palette: {
    toProcess: 'To process',
    toProcessHint: 'Everything that needs your attention',
    processBankLines: 'Process bank lines',
    processBankLinesHint: 'Book the lines waiting on your bank accounts',
    keywords: 'to process todo inbox attention te verwerken openstaand',
    bankLinesKeywords: 'process bank lines reconcile categorize transactions bankregels verwerken afletteren',
  },
  menu: {
    toProcessBadge: '{count} items to process',
    inboxBadge: '{count} documents in the inbox',
    bankBadge: '{count} bank lines to process',
  },
};
