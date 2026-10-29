/**
 * WeldPanel — product analytics and session recordings.
 *
 * Phase 1 (collect): projects, their settings and the install page. Reports,
 * funnels and recordings add their own sections in later phases.
 */
export const weldpanel = {
  title: 'WeldPanel',
  breadcrumb: {
    home: 'WeldPanel',
    projects: 'Projects',
  },
  noAccess: "You don't have access to WeldPanel.",
  retry: 'Try again',

  kinds: {
    website: 'Website',
    app: 'Web app',
  },
  kindHints: {
    website: 'A marketing site, shop or blog. Visitors are mostly anonymous.',
    app: 'A product people log in to. You can recognise those users later.',
  },
  statuses: {
    active: 'Active',
    paused: 'Paused',
  },

  validation: {
    nameRequired: 'Enter a name.',
    nameTooLong: 'Use at most 255 characters.',
    domainInvalid: 'Enter a host like example.com, shop.example.com or *.example.com.',
    domainDuplicate: 'That domain is already in the list.',
    tooManyDomains: 'Add at most 20 domains.',
    patternInvalid: 'Start with a slash, like /admin/* or /checkout/success.',
    patternDuplicate: 'That pattern is already in the list.',
    tooManyPatterns: 'Add at most 50 patterns.',
  },

  /** The editor behind "allowed domains" and "excluded pages". */
  listEditor: {
    add: 'Add',
    remove: 'Remove {value}',
    limitReached: 'You reached the limit of {max}.',
  },

  home: {
    title: 'Analytics',
    description: 'See how people use your website or app, and watch what they did.',
    newProject: 'New project',
    emptyTitle: 'No projects yet',
    emptyDescription:
      'Add a project for your website or app and paste one script tag. Traffic, funnels and session recordings appear within minutes.',
    emptyNoCreate: 'Ask an owner or admin of the workspace to add one.',
    steps: {
      install: {
        title: 'Add the snippet',
        description: 'One script tag on your site, or the npm package in your app.',
      },
      analyse: {
        title: 'Find where people drop off',
        description: 'Traffic, funnels, retention and user paths, broken down any way you like.',
      },
      watch: {
        title: 'Watch what happened',
        description: 'Session recordings and heatmaps, with rage clicks and errors flagged.',
      },
    },
    loadFailed: 'Could not load your projects.',
    projectLabel: 'Project',
    projectPlaceholder: 'Choose a project',
    allProjects: 'All projects',
    reportsTitle: 'Reports are the next step',
    reportsDescription:
      'Traffic, pages and sources reports arrive in the next phase. For now WeldPanel collects events and tells you whether they arrive.',
  },

  createDialog: {
    title: 'New project',
    description: 'A project is one website or app you want to track. You can add more later.',
    nameLabel: 'Name',
    namePlaceholder: 'My website',
    kindLabel: 'Type',
    domainsLabel: 'Allowed domains',
    domainsOptional: 'optional',
    domainsHint: 'Only events from these sites are accepted. Leave it empty to accept events from any site.',
    submit: 'Create project',
    creating: 'Creating…',
    cancel: 'Cancel',
    created: 'Project created. Add the snippet to your site.',
    createFailed: 'Could not create the project.',
  },

  projects: {
    title: 'Projects',
    description: 'The websites and apps you track.',
    newProject: 'New project',
    loadFailed: 'Could not load your projects.',
    emptyTitle: 'No projects yet',
    emptyDescription: 'Add a project for your website or app to get a snippet you can paste.',
    table: {
      name: 'Name',
      kind: 'Type',
      status: 'Status',
      domains: 'Domains',
      created: 'Created',
    },
    anySite: 'Any site',
    moreDomains: '+{count} more',
  },

  project: {
    notFound: 'This project does not exist, or was deleted.',
    loadFailed: 'Could not load the project.',
    back: 'All projects',
    created: 'Created {date}',
    pausedTitle: 'Collection is paused',
    pausedDescription: 'The collector drops events from this project until collection is resumed.',
    tabs: {
      install: 'Install',
      general: 'General',
      privacy: 'Privacy & collection',
      danger: 'Danger zone',
    },
  },

  install: {
    statusTitle: 'Installation status',
    waiting: 'Waiting for the first event',
    receiving: 'Receiving events',
    paused: 'Collection paused',
    lastEvent: 'Last event {time}',
    arriving: 'Events are arriving.',
    noEvents: 'No events yet.',
    pausedNote: 'Events are dropped while collection is paused.',
    pollHint: 'This page checks every 10 seconds.',
    checklistTitle: 'Get your first event',
    steps: {
      paste: 'Add the snippet to your site',
      open: 'Open your site in a browser',
      wait: 'Wait for the first event to show up here',
    },
    loadFailed: 'Could not check the installation.',
    openProject: 'Install instructions',
    scriptTitle: 'Script tag',
    scriptDescription: 'Paste it into the <head> of every page you want to track.',
    npmTitle: 'npm package',
    npmDescription: 'For apps that bundle their code. Install the package and initialise it once, at startup.',
    tokenLabel: 'Project token',
    tokenHint: 'Safe to put in page source: it can only send data.',
    copy: 'Copy',
    copied: 'Copied',
    copyLabel: 'Copy {label}',
    copyFailed: 'Could not copy. Select the text and copy it by hand.',
  },

  general: {
    title: 'General',
    description: 'The name of the project, what it is, and which sites may send events.',
    nameLabel: 'Name',
    kindLabel: 'Type',
    domainsLabel: 'Allowed domains',
    domainsHint:
      'Only events from these sites are accepted. Use *.example.com to include every subdomain. An empty list accepts events from any site.',
    anySite: 'Any site',
    save: 'Save changes',
    saving: 'Saving…',
    saved: 'Changes saved',
    saveFailed: 'Could not save the changes.',
  },

  privacy: {
    title: 'Privacy & collection',
    description: 'What the snippet collects, and when it may start.',
    autocaptureLabel: 'Autocapture',
    autocaptureDescription:
      'Record clicks and form submits automatically, with the text of the element. Turn it off to send only the events you track yourself.',
    on: 'On',
    off: 'Off',
    consentLabel: 'Consent',
    consent: {
      required: {
        label: 'Wait for consent',
        description:
          'Until your site calls weldpanel.consent.grant(), WeldPanel counts anonymously: page views and events only, no cookies or storage, no recordings, no identity. Recommended when you have visitors from the EU.',
      },
      none: {
        label: 'Track without consent',
        description:
          'Full tracking starts at the first page view. Only choose this if your audience does not need to give consent.',
      },
    },
    maskingLabel: 'Masking',
    maskingDescription:
      'What is hidden. It applies to the text of captured elements now, and to session recordings, which arrive in a later phase. Password fields are always masked.',
    masking: {
      strict: {
        label: 'Strict',
        description: 'Masks all text and inputs, and blocks images.',
      },
      balanced: {
        label: 'Balanced',
        description: 'Masks all inputs. Page text stays visible.',
      },
      relaxed: {
        label: 'Relaxed',
        description: 'Masks only password fields and fields you mark as sensitive.',
      },
    },
    excludedLabel: 'Excluded pages',
    excludedDescription:
      'Pages whose path matches a pattern are not tracked. * matches any characters, for example /admin/* or /checkout/success.',
    excludedPlaceholder: '/admin/*',
    excludedNone: 'No pages are excluded.',
    readOnlyNote: 'Only people who can manage WeldPanel projects can change these settings.',
    save: 'Save settings',
    saving: 'Saving…',
    saved: 'Settings saved',
    saveFailed: 'Could not save the settings.',
  },

  danger: {
    title: 'Danger zone',
    pause: {
      title: 'Pause collection',
      description: 'The collector drops events from this project until you resume. Your site keeps working.',
      button: 'Pause collection',
      confirmTitle: 'Pause collection?',
      confirmDescription: 'Events from {name} are dropped while it is paused. Nothing is collected in the meantime.',
      confirm: 'Pause',
      done: 'Collection paused',
      failed: 'Could not pause collection.',
    },
    resume: {
      title: 'Resume collection',
      description: 'Collection is paused. Resume it to accept events from this project again.',
      button: 'Resume collection',
      done: 'Collection resumed',
      failed: 'Could not resume collection.',
    },
    rotate: {
      title: 'Rotate project token',
      description: 'Issue a new token. The snippet on your site stops working at once, so update it straight away.',
      button: 'Rotate token',
      confirmTitle: 'Rotate the token?',
      confirmDescription:
        'The snippet currently on {name} stops working at once: events sent with the old token are rejected until you paste the new snippet.',
      confirm: 'Rotate token',
      done: 'Token rotated. Update the snippet on your site.',
      failed: 'Could not rotate the token.',
    },
    delete: {
      title: 'Delete project',
      description:
        "The collector stops accepting this project's token at once. The project disappears from WeldPanel and can't be restored from here.",
      button: 'Delete project',
      dialogTitle: 'Delete {name}?',
      dialogDescription:
        'Events from your site are rejected from now on and the project is removed from WeldPanel. This cannot be undone from here.',
      confirmLabel: 'Type {name} to confirm',
      confirm: 'Delete project',
      cancel: 'Cancel',
      done: 'Project deleted',
      failed: 'Could not delete the project.',
    },
    cancel: 'Cancel',
  },
};
