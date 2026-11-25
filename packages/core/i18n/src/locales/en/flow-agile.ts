/**
 * WeldFlow agile delivery, the parts every agile screen shares: item types,
 * delivery approaches, sprint states, the view switches, and the project
 * Settings sections (Delivery approach, Item types). The Backlog, task panel
 * and epic page strings are in `flowAgileBacklog`; the Pipeline, sprint page,
 * Analytics › Sprints and Gantt › Phases strings in `flowAgileSprints`.
 *
 * Counts that read "1 point" / "2 points" are plural objects: pick one with
 * `plural(count, forms)`.
 */
export const flowAgile = {
  itemTypes: {
    epic: 'Epic',
    feature: 'Feature',
    /** A story is named by the project: a PBI or a user story. */
    story: { pbi: 'PBI', story: 'User story' },
    bug: 'Bug',
    task: 'Task',
    spike: 'Spike',
    subtask: 'Subtask',
  },

  itemTypeDescriptions: {
    epic: 'A large piece of work that holds items. Deleting it never deletes them.',
    feature: 'Sits between an epic and its items, when the feature level is on.',
    story: 'Something of value for the user, estimated in points.',
    bug: 'Something that doesn’t work as it should.',
    task: 'Work that has to be done, without user value of its own.',
    spike: 'Time-boxed research that ends in an answer, not in code.',
    subtask: 'A step of one item. It follows its parent into a sprint.',
  },

  approaches: {
    tasklist: {
      name: 'Task list',
      description: 'Tasks with stages, dates and assignees. WeldFlow as it always was.',
    },
    predictive: {
      name: 'Predictive',
      description: 'Plan it up front: phases with gates, a baseline and a Gantt chart.',
    },
    scrum: {
      name: 'Scrum',
      description: 'Work in sprints from an ordered backlog, with reviews and retros.',
    },
    kanban: {
      name: 'Kanban',
      description: 'A continuous flow with WIP limits on the board, no sprints.',
    },
    hybrid: {
      name: 'Hybrid',
      description: 'Phases and gates for the plan, sprints for the build.',
    },
  },

  sprintStatus: {
    planned: 'Planned',
    active: 'Active',
    completed: 'Completed',
    cancelled: 'Cancelled',
  },

  points: { one: '{count} point', other: '{count} points' },
  pointsShort: '{count} pts',
  noEstimate: 'No estimate',

  routeLabels: { epics: 'Epics' },

  views: {
    list: 'List',
    backlog: 'Backlog',
    sprints: 'Sprints',
    customReports: 'Custom reports',
    board: 'Board',
    report: 'Report',
    retro: 'Retro',
  },

  shared: {
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved',
    cancel: 'Cancel',
    delete: 'Delete',
    open: 'Open',
    none: 'None',
    retry: 'Try again',
    loadFailed: 'This couldn’t be loaded.',
    saveFailed: 'This couldn’t be saved. Try again.',
  },

  // ── Settings › Delivery approach ──────────────────────────────────────────
  delivery: {
    navLabel: 'Delivery approach',
    title: 'Delivery approach',
    description:
      'How this project delivers. It only sets defaults: what Tasks opens on, what the Pipeline shows and which item types you can pick. Your tasks stay as they are.',
    approachLabel: 'Approach',
    changesTitle: 'What this changes in the project',
    changes: {
      tasksOpensOnList: 'Tasks opens on the list',
      tasksOpensOnBacklog: 'Tasks opens on the backlog',
      pipelineShowsAll: 'The Pipeline shows all open work',
      pipelineShowsSprint: 'The Pipeline shows the active sprint',
      pipelineShowsWip: 'The Pipeline shows WIP limits per column',
      itemTypesOn: 'Items get a type: epics, PBIs, bugs and more',
      itemTypesOff: 'No item types',
      sprintsOn: 'Sprints with planning, reports and retros',
      phasesOn: 'Gantt › Phases plans the phases and gates',
      phasesWithSprints: 'Gantt › Phases shows the sprints inside each phase',
      nothing: 'Nothing changes: this is how WeldFlow works today.',
    },
    showSuggestedTabs: 'Also show the tabs that fit this approach',
    showSuggestedTabsHint: 'Hides the other tabs for everyone. You can change this under Tabs at any time.',
    sprintsTitle: 'Sprints',
    sprintLength: 'Sprint length',
    sprintLengthOption: { one: '{count} week', other: '{count} weeks' },
    sprintLengthDays: { one: '{count} day', other: '{count} days' },
    wipTitle: 'WIP limits',
    wipDescription:
      'The most items a Pipeline column should hold. The column turns amber at its limit; nothing is refused.',
    wipNone: 'No limit',
    wipNoStages: 'This project has no pipeline stages yet.',
    dodTitle: 'Definition of Done',
    dodDescription: 'What every PBI and bug has to meet before it counts as done. Shown on the item.',
    dodPlaceholder: 'Add a criterion',
    dodAdd: 'Add',
    dodRemove: 'Remove “{text}”',
    dodEmpty: 'No criteria yet.',
    managersOnly: 'Only project managers can change the delivery approach.',
  },

  // ── Settings › Item types ─────────────────────────────────────────────────
  itemTypesSettings: {
    navLabel: 'Item types',
    title: 'Item types',
    description: 'The kinds of item this project uses. Set an item’s type in the task panel or the backlog.',
    notAgile: 'Item types are part of the Scrum, Kanban and Hybrid approaches. Pick one under Delivery approach.',
    namingTitle: 'What do you call a story?',
    naming: { pbi: 'PBI (product backlog item)', story: 'User story' },
    featureLevelTitle: 'Feature level',
    featureLevelDescription: 'Epics hold features, and features hold items. Off: epics hold items directly.',
    typesTitle: 'Types',
    typeColumn: 'Type',
    meaningColumn: 'What it is',
    enabledColumn: 'On',
    alwaysOn: 'Always on',
    rulesTitle: 'Rules',
    rules: {
      epicDelete: 'Deleting an epic never deletes its items: they stay in the backlog without an epic.',
      subtaskSprint: 'A subtask follows its parent into a sprint.',
      typeChange: 'Changing an epic into another type takes its items out of it.',
    },
  },
};
