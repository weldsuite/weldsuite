/**
 * WeldBooks US: bank feed connections.
 */
export const weldbooksUsBankFeeds = {
  title: 'Bank feeds',
  subtitle: 'Connect your bank and new transactions arrive on their own, ready to reconcile.',
  connectBank: 'Connect bank',
  connectAnotherBank: 'Connect another bank',
  connectBankFeed: 'Connect a bank feed',
  connecting: 'Connecting…',
  allFeeds: 'All bank feeds',

  list: {
    loadError: 'Your bank connections could not be loaded.',
    retry: 'Try again',
    emptyTitle: 'No bank connected yet',
    emptyDescription:
      'Connect your bank to import transactions automatically. Importing statement files keeps working next to a bank feed.',
    noProviders: 'Bank feeds are not available for {country} yet. You can still import bank statements.',
    providersLoadError: 'The available bank connection options could not be loaded.',
  },

  providers: {
    plaid: 'Plaid',
    stripe_fc: 'Stripe',
    ponto: 'Ponto',
    enable_banking: 'Enable Banking',
    teller: 'Teller',
  },

  status: {
    active: 'Connected',
    reauth_required: 'Reconnect needed',
    expiring: 'Expiring soon',
    revoked: 'Access revoked',
    disconnected: 'Disconnected',
    error: 'Sync error',
  },

  connection: {
    via: 'via {provider}',
    unknownBank: 'Bank connection',
    lastSynced: 'Last synced {time}',
    neverSynced: 'Not synced yet',
    accessEnds: 'Bank access ends {date}',
    accountsHeading: 'Accounts',
    linkedTo: 'Linked to {name}',
    notLinked: 'Not linked',
    importsFrom: 'Importing from {date}',
    importsAll: 'Importing all available history',
    accountTypes: {
      depository: 'Bank account',
      credit: 'Credit card',
      loan: 'Loan',
    },
    unlinkedNote: {
      one: '{count} account is not linked to a WeldBooks bank account, so its transactions are not imported.',
      other: '{count} accounts are not linked to a WeldBooks bank account, so their transactions are not imported.',
    },
  },

  banners: {
    reauthTitle: 'Sign in to your bank again',
    reauthBody:
      '{bank} needs you to sign in again before new transactions can be imported. What is already imported is not affected.',
    expiringTitle: 'Bank access ends soon',
    expiringToday: 'Access to {bank} ends today. Renew it to keep transactions flowing.',
    expiringBody: {
      one: 'Access to {bank} ends in {count} day. Renew it to keep transactions flowing.',
      other: 'Access to {bank} ends in {count} days. Renew it to keep transactions flowing.',
    },
    revokedTitle: 'Access was revoked',
    revokedBody:
      'Access to {bank} was withdrawn at the bank. Connect again to resume. Your bank accounts and their transactions stay as they are.',
    disconnectedTitle: 'Disconnected',
    disconnectedBody:
      'Importing is switched off for {bank}. Connect again to resume. Your bank accounts and their transactions stay as they are.',
    errorTitle: 'The last sync did not work',
    errorBody: 'The bank connection reported a problem. Try syncing again in a moment, or reconnect if it keeps happening.',
    errorDetail: 'Reported: {error}',
  },

  actions: {
    syncNow: 'Sync now',
    syncing: 'Syncing…',
    refreshAndSync: 'Ask the bank for fresh data',
    reconnect: 'Reconnect',
    renew: 'Renew access',
    connectAgain: 'Connect again',
    addAccounts: 'Add accounts',
    linkAccounts: 'Link accounts',
    pendingTransactions: 'Pending transactions',
    hidePending: 'Hide pending transactions',
    disconnect: 'Disconnect',
    remove: 'Remove connection',
    moreActions: 'More actions',
    warnings: 'Notes from recent syncs',
  },

  sync: {
    done: 'Sync finished: {added} new, {updated} updated, {removed} removed.',
    upToDate: 'Already up to date.',
    matched: '{count} matched automatically.',
    inProgress: 'A sync is already running for this connection.',
    notActive: 'Reconnect this bank before it can sync.',
    noAccounts: 'Link at least one account before syncing.',
    notFound: 'This bank connection no longer exists.',
    failed: 'The sync did not work: {error}',
  },

  pending: {
    description:
      'The bank has reported these but not posted them yet. They are reconciled once the bank posts them.',
    empty: 'No pending transactions.',
    loadError: 'Pending transactions could not be loaded.',
    count: {
      one: '{count} pending transaction',
      other: '{count} pending transactions',
    },
    columns: {
      date: 'Date',
      description: 'Description',
      amount: 'Amount',
    },
    noDescription: 'No description',
  },

  warnings: {
    description: 'Things the sync noticed and handled; nothing here needs action unless it says so.',
  },

  disconnect: {
    title: 'Disconnect {bank}?',
    description:
      'WeldBooks stops importing and withdraws its access at the bank. Everything already imported stays on your bank accounts and in your books, and you can connect again later.',
    confirm: 'Disconnect',
    done: '{bank} disconnected.',
  },

  remove: {
    title: 'Remove {bank}?',
    description:
      'WeldBooks withdraws its access at the bank and removes this connection. Everything already imported stays on your bank accounts and in your books, and those accounts can be linked to a bank feed again.',
    confirm: 'Remove connection',
    done: '{bank} removed.',
  },

  connect: {
    title: 'Connect your bank',
    description: 'Choose how WeldBooks connects to your bank.',
    providerLabel: 'Connect with',
    providerHistory: 'Up to {days} days of history',
    institutionLabel: 'Your bank',
    institutionSearch: 'Search for your bank',
    institutionList: 'Matching banks',
    institutionLoading: 'Loading banks…',
    institutionEmpty: 'No bank matches "{query}".',
    institutionError: 'The list of banks could not be loaded.',
    accountHolderLabel: 'Accounts to connect',
    business: 'Business accounts',
    personal: 'Personal accounts',
    redirectNote: 'You are sent to your bank to sign in and approve access, then brought back here.',
    continue: 'Continue',
    cancel: 'Cancel',
    connected: '{bank} connected.',
    reconnected: '{bank} reconnected.',
    accountsAdded: 'Accounts updated for {bank}.',
    syncStarted: 'First sync started. New transactions show up in a moment.',
  },

  mapping: {
    title: 'Link your {bank} accounts',
    description:
      'Match each account to a bank account in WeldBooks, create a new one, or skip it. Skipped accounts can be linked later.',
    historyTitle: 'How far back transactions go',
    historyBody:
      '{provider} provides up to {days} days of transaction history, counted from today. Older transactions have to come from a statement import.',
    actionLabel: 'What to do',
    actionLink: 'Link to an existing bank account',
    actionCreate: 'Create a new bank account',
    actionSkip: 'Do not import this account',
    bankAccountLabel: 'WeldBooks bank account',
    selectBankAccount: 'Select a bank account',
    noBankAccounts: 'No bank account is available to link. Create a new one instead.',
    bankAccountsError: 'Your bank accounts could not be loaded. You can still create new ones.',
    bankAccountsLoading: 'Loading your bank accounts…',
    suggested: {
      fingerprint: 'Same account as before',
      iban: 'Matching IBAN',
      last4: 'Matching last four digits',
      name: 'Same name',
    },
    newNameLabel: 'Name of the new bank account',
    newTypeLabel: 'Account type',
    accountTypes: {
      checking: 'Checking',
      savings: 'Savings',
      credit_card: 'Credit card',
      money_market: 'Money market',
      line_of_credit: 'Line of credit',
    },
    syncFromLabel: 'Import transactions from',
    syncFromHint: 'Leave empty to import everything {provider} can provide, up to {days} days.',
    syncFromHintNoLimit: 'Leave empty to import everything the bank can provide.',
    syncFromImported:
      'The last statement import on this account ran on {date}. Transactions before the date you set are skipped, so imported statements are not counted twice.',
    currencyMismatch: 'This account is in {feed}, but the bank account is in {bank}.',
    startSync: 'Start the first sync right away',
    submit: {
      one: 'Link {count} account',
      other: 'Link {count} accounts',
    },
    later: 'Link later',
    linking: 'Linking…',
    problems: {
      bank_account_required: 'Select a bank account.',
      bank_account_twice: 'This bank account is already used for another account above.',
      name_required: 'Enter a name for the new bank account.',
    },
    nothingToLink: 'Choose at least one account to link or create.',
    done: {
      one: '{count} account linked.',
      other: '{count} accounts linked.',
    },
    allLinked: 'All accounts of this connection are linked.',
  },

  callback: {
    title: 'Connecting your bank',
    processing: 'Finishing the connection with your bank…',
    backToFeeds: 'Back to bank feeds',
    errors: {
      noPending: 'The bank connection you started could not be found. Start again from Bank feeds.',
      missingCode: 'Your bank did not return an authorization code.',
      deniedWithReason: 'Your bank did not approve the connection: {reason}',
      stateMismatch: 'The response from your bank does not match the connection you started. Start again from Bank feeds.',
      missingOAuthState: 'Your bank did not return to the connection you started. Start again from Bank feeds.',
    },
  },

  account: {
    noFeedTitle: 'No bank feed on this account',
    noFeedDescription: 'Connect your bank to import this account’s transactions automatically.',
    connectFeed: 'Connect bank feed',
    manageFeed: 'Manage bank feed',
    feedStatusLabel: 'Bank feed',
    connectedThrough: 'Connected through {bank}',
  },

  errors: {
    generic: 'Something went wrong. Try again.',
    forbidden: 'You do not have permission to do this.',
    notFound: 'This bank connection no longer exists.',
    conflictLink: 'This bank connection already belongs to another accounting entity.',
    conflictMap:
      'One of these bank accounts is already linked to another bank connection. Pick a different bank account, or disconnect the other connection first.',
    providerFailed: 'The bank data provider could not complete the request. Try again in a few minutes.',
    unavailable: 'This bank feed provider is not set up yet. Contact support if this keeps happening.',
    badRequest: 'The bank feed provider did not accept the request.',
    scriptFailed: 'The bank connection window could not be loaded. Check your connection or ad blocker and try again.',
    incompleteSession: 'The bank connection could not be started. Try again.',
    insecureUrl: 'The bank sent a link that is not secure, so the connection was stopped.',
    stripeNotConfigured: 'Stripe bank connections are not set up in this environment.',
    providerWindow: 'The bank connection window reported a problem.',
    detail: 'Reported: {detail}',
  },
};
