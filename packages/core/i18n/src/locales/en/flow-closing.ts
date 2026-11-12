/**
 * WeldFlow closing a project, lessons learned and templates (project-control slice F). Strings of the slice go here, in en and nl.
 *
 * `close` is the Close project page, `templates` the "Save as template" dialog
 * (on the Close page and in the project menu). Counts that read "1 task" / "2
 * tasks" are plural objects: pick one with `plural(count, forms)`.
 */
export const flowClosing = {
  title: 'Closing',

  shared: {
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving…',
    delete: 'Delete',
    edit: 'Edit',
    retry: 'Try again',
    unknownMember: 'Unknown member',
    noOne: 'No one',
    choosePerson: 'Choose a person',
    validation: {
      required: 'This field is required',
      tooLong: 'Use at most {max} characters',
      invalidDate: 'Enter a valid date',
      invalidValue: 'This value is not valid',
    },
  },

  // ── Close project page ────────────────────────────────────────────────────
  close: {
    title: 'Close project',
    backToProject: 'Back to project',
    description:
      'Finish the checks, record what you learned and ask the sponsor to sign off. Closing makes the project read-only.',
    saveAsTemplate: 'Save as template',
    progress: {
      label: 'Checks done',
      value: '{done} of {total}',
      aria: '{done} of {total} checks done',
    },
    closedBanner: {
      title: 'This project is closed',
      onDate: 'It closed on {date}.',
      readOnly: 'The page is read-only: nothing can be handed over, requested or added anymore.',
    },
    states: {
      loadingLabel: 'Loading the close checklist',
      errorTitle: 'The close checklist could not be loaded',
      errorDescription: 'Check your connection and try again.',
      retry: 'Try again',
      forbiddenTitle: 'No access to this project',
      forbiddenDescription: 'You are not a member of this project. Ask a project manager to add you.',
      notFoundTitle: 'Project not found',
      notFoundDescription: 'It may have been deleted.',
    },

    checklist: {
      title: 'Close checklist',
      blocking: 'Needed before sign-off',
      state: { done: 'Done', open: 'To do', waiting: 'Waiting' },
      checks: {
        deliverables: {
          title: 'All deliverables accepted by the client',
          none: 'This project has no deliverables.',
          progress: {
            one: '{satisfied} of {total} deliverable accepted',
            other: '{satisfied} of {total} deliverables accepted',
          },
        },
        changes: {
          title: 'All change requests decided',
          none: 'There are no change requests.',
          progress: {
            one: '{satisfied} of {total} change request decided',
            other: '{satisfied} of {total} change requests decided',
          },
        },
        raid: {
          title: 'Open RAID items closed or handed over',
          none: 'There are no open register items.',
          progress: {
            one: '{satisfied} of {total} open item handed over',
            other: '{satisfied} of {total} open items handed over',
          },
        },
        benefits: {
          title: 'Final benefit measurements recorded',
          none: 'There are no benefits left to measure.',
          progress: {
            one: '{satisfied} of {total} benefit has an owner and a measurement',
            other: '{satisfied} of {total} benefits have an owner and a measurement',
          },
        },
        time: {
          title: 'Final costs booked and timesheets locked',
          none: 'No time has been logged on this project.',
          progress: {
            one: '{satisfied} of {total} time entry approved',
            other: '{satisfied} of {total} time entries approved',
          },
        },
        lessons: {
          title: 'Lessons learned published',
          none: 'No lessons yet. Add what went well and what to do differently.',
          progress: {
            one: '{satisfied} of {total} lesson published to WeldKnow',
            other: '{satisfied} of {total} lessons published to WeldKnow',
          },
        },
        signoff: {
          title: 'Sponsor sign-off',
          none: '{sponsor} signs off once the other checks are done.',
          noneNoSponsor: 'The sponsor signs off once the other checks are done.',
          pending: 'Waiting for {sponsor} to answer.',
          pendingNoSponsor: 'Waiting for the sponsor to answer.',
          approved: 'Signed off by {sponsor}.',
          approvedNoSponsor: 'Signed off by the sponsor.',
          rejected: '{sponsor} declined. Fix what was asked and request sign-off again.',
          rejectedNoSponsor: 'The sponsor declined. Fix what was asked and request sign-off again.',
        },
      },
      /** Short names of the checks, for the list of what still blocks sign-off. */
      names: {
        deliverables: 'Deliverables',
        changes: 'Change requests',
        raid: 'RAID items',
        benefits: 'Benefits',
        time: 'Time',
        lessons: 'Lessons',
        signoff: 'Sign-off',
      },
      acceptedDeliverables: 'Accepted deliverables',
      otherDeliverables: 'Deliverables still open',
      deliverableStatus: {
        not_started: 'Not started',
        in_progress: 'In progress',
        accepted: 'Accepted',
        rejected: 'Rejected',
      },
    },

    raid: {
      heading: 'Open register items',
      hint: 'Close an item that no longer matters, or hand it to the person who keeps it after the project.',
      owner: 'Owner: {name}',
      noOwner: 'No owner',
      handedOver: 'Handed over',
      handOver: 'Hand over',
      close: 'Close',
      handOverAria: 'Hand over {code}: {title}',
      closeAria: 'Close {code}: {title}',
      handover: {
        title: 'Hand over {code}',
        description: 'The new owner keeps “{title}” after the project is closed.',
        owner: 'New owner',
        ownerRequired: 'Choose who takes it over',
        submit: 'Hand over',
        submitting: 'Handing over…',
        success: '{code} handed over to {name}',
        failed: 'The item could not be handed over',
      },
      closeItem: {
        title: 'Close {code}?',
        description: '“{title}” moves to “{status}” and leaves the list of open items.',
        confirm: 'Close item',
        success: '{code} closed',
        failed: 'The item could not be closed',
      },
    },

    benefits: {
      title: 'Final benefit measurements',
      subtitle: 'The latest measurement of every benefit that is still open.',
      empty: 'No open benefits, so nothing to measure.',
      columns: {
        benefit: 'Benefit',
        baseline: 'Baseline',
        target: 'Target',
        latest: 'Latest measurement',
        status: 'Status',
        owner: 'Owner',
      },
      targetBy: 'target by {date}',
      noMeasurement: 'No measurement yet',
      noOwner: 'No owner',
      needsMeasurement: 'Needs a measurement',
      needsOwner: 'Needs an owner',
      status: {
        planned: 'Planned',
        measuring: 'Measuring',
        at_risk: 'At risk',
        realised: 'Realised',
        closed: 'Closed',
      },
      footer: {
        hint: 'Most targets fall after closing. Keep measuring:',
        handTo: 'Hand benefit tracking to',
        sponsorSuffix: '{name} (sponsor)',
        apply: 'Apply',
        applying: 'Applying…',
        success: 'Benefit tracking handed to {name}',
        failed: 'Benefit tracking could not be handed over',
      },
    },

    finance: {
      title: 'Final finance',
      openFinance: 'Open Finance',
      budget: 'Budget',
      budgetBaseline: 'Budget (baseline v{version})',
      actual: 'Actual',
      verdict: {
        over: 'Over budget',
        under: 'Under budget',
        on: 'On budget',
        none: 'No budget set',
      },
      goLive: 'Go-live',
      goLiveBaseline: '{date} · on v{version}',
      noGoLive: 'Not set',
      percentOnly: 'You can see percentages only. Amounts need access to project finance.',
      sourceSnapshot: 'Actual cost is the finance snapshot of {week}.',
      sourceTime: 'Actual cost is the cost of the approved and billed time entries.',
    },

    lessons: {
      title: 'Lessons learned',
      summary: { one: '{count} lesson', other: '{count} lessons' },
      publishedSummary: '{count} published to WeldKnow',
      add: 'Add lesson',
      publish: 'Publish lessons to WeldKnow',
      publishNeedsLessons: 'Add a lesson first',
      loadFailed: 'The lessons could not be loaded.',
      columns: {
        went_well: 'Went well',
        went_badly: "Didn't go well",
        do_differently: 'Do differently',
      },
      emptyColumn: {
        went_well: 'Nothing here yet. What worked that the next project should keep?',
        went_badly: 'Nothing here yet. What got in the way?',
        do_differently: 'Nothing here yet. What would you change next time?',
      },
      addToColumn: 'Add a lesson to “{column}”',
      vote: {
        one: 'Vote for this lesson, {count} vote',
        other: 'Vote for this lesson, {count} votes',
      },
      voteFailed: 'Your vote could not be saved',
      published: 'Published',
      publishedAria: 'Open the published page in WeldKnow',
      edit: 'Edit this lesson',
      deleteLesson: 'Delete this lesson',
      dialog: {
        createTitle: 'Add a lesson',
        editTitle: 'Edit lesson',
        description: 'One lesson per card. Be specific, so the next project can act on it.',
        category: 'Category',
        text: 'Lesson',
        textPlaceholder: 'What happened, and what should the next project do with it?',
        submit: 'Add lesson',
        save: 'Save changes',
        saving: 'Saving…',
        created: 'Lesson added',
        updated: 'Lesson updated',
        createFailed: 'The lesson could not be added',
        updateFailed: 'The lesson could not be saved',
      },
      deleteConfirm: {
        title: 'Delete this lesson?',
        description: 'It is removed from the board. A WeldKnow page that was already published keeps its text.',
        confirm: 'Delete lesson',
        success: 'Lesson deleted',
        failed: 'The lesson could not be deleted',
      },
    },

    publish: {
      title: 'Publish lessons to WeldKnow',
      description:
        'Creates one WeldKnow page with every lesson of this project, grouped by category and sorted by votes.',
      space: 'Teamspace',
      spacePlaceholder: 'Choose a teamspace',
      spaceRequired: 'Choose a teamspace',
      personalSuffix: '{name} (private)',
      noSpaces: 'You cannot write in any teamspace yet. Ask a teamspace owner to add you as an editor.',
      spacesFailed: 'The teamspaces could not be loaded.',
      loadingSpaces: 'Loading teamspaces…',
      submit: 'Publish',
      submitting: 'Publishing…',
      failed: 'The lessons could not be published',
      successTitle: 'Lessons published',
      successDescription: {
        one: '{count} lesson is now a page in {space}.',
        other: '{count} lessons are now a page in {space}.',
      },
      openPage: 'Open the page in WeldKnow',
      done: 'Done',
    },

    signoff: {
      title: 'Sponsor sign-off',
      titleWithName: 'Sponsor sign-off · {name}',
      description: {
        none: '{name} gets the request when you ask for sign-off. Once approved, the project closes and becomes read-only.',
        noneNoSponsor:
          'The sponsor gets the request when you ask for sign-off. Once approved, the project closes and becomes read-only.',
        pending: 'Waiting for {name}. The request went out on {date}.',
        pendingNoSponsor: 'Waiting for the sponsor. The request went out on {date}.',
        approved: '{name} signed the project off on {date}.',
        approvedNoSponsor: 'The sponsor signed the project off on {date}.',
        rejected: '{name} declined on {date}.',
        rejectedNoSponsor: 'The sponsor declined on {date}.',
        closed: 'The project is closed.',
      },
      noteLabel: 'Their note',
      request: 'Request sign-off',
      requested: 'Sign-off requested',
      closed: 'Closed',
      blockedReason: {
        one: '{count} blocking check is still open: {checks}',
        other: '{count} blocking checks are still open: {checks}',
      },
      managersOnly: 'Only project managers can request sign-off.',
      answerInReviews: 'You are the approver. Answer the request in My reviews.',
      openReviews: 'Open My reviews',
      dialog: {
        title: 'Request sign-off',
        description: 'Ask {name} to sign the project off. Once approved, the project becomes read-only.',
        descriptionNoSponsor: 'Ask the sponsor to sign the project off. Once approved, the project becomes read-only.',
        note: 'Note for the sponsor (optional)',
        notePlaceholder: 'Anything the sponsor should know before answering',
        submit: 'Send request',
        submitting: 'Sending…',
      },
      success: 'Sign-off requested from {name}',
      successNoSponsor: 'Sign-off requested',
      failed: 'The sign-off could not be requested',
    },
  },

  // ── Save as template ─────────────────────────────────────────────────────
  templates: {
    saveDialog: {
      title: 'Save as template',
      description:
        'Phases, tasks, milestones, deliverables, open risks and the control settings become a template. Dates turn into offsets from the start and people into roles.',
      project: 'Project',
      projectPlaceholder: 'Choose a project',
      projectRequired: 'Choose a project',
      projectsFailed: 'The projects could not be loaded.',
      name: 'Template name',
      descriptionLabel: 'Description',
      descriptionPlaceholder: 'When should someone use this template?',
      shared: 'Share with the workspace',
      sharedHint: 'Everyone who can create projects can use it. Off: only you can.',
      submit: 'Save template',
      saved: 'Template “{name}” saved',
      failed: 'The template could not be saved',
    },
  },
};
