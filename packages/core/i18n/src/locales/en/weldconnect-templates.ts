/**
 * Strings of the WeldConnect starter templates (the built-in workflow
 * templates every workspace sees in the template gallery).
 *
 * Not part of the `en` bundle the apps load: connect-api imports this file
 * (`@weldsuite/i18n/locales/en/weldconnect-templates`) and returns templates
 * already translated, and "use template" writes the translated names and texts
 * into the new workflow. The template structure lives in
 * `@weldsuite/app-api-client/schemas/weldconnect-templates`.
 *
 * Per template: `steps` are the step names shown on the canvas, `text` the
 * texts that end up in a step's settings. `{name}` placeholders are filled in
 * with workflow variables (`{{trigger.record.fullName}}`, …) by the template
 * definition, so keep every placeholder when translating.
 */
export const weldconnectTemplates = {
  leadFollowUp: {
    name: 'Follow up on new leads',
    description: 'When a lead comes in, create a follow-up task for it in a WeldFlow project and send yourself a notification.',
    steps: {
      task: 'Create follow-up task',
      notify: 'Notify me',
    },
    text: {
      taskTitle: 'Follow up with {name}',
      taskDescription: 'New lead from {company}. Email: {email}, phone: {phone}.',
      notifyTitle: 'New lead: {name}',
      notifyBody: 'A follow-up task was created: {task}',
    },
  },
  dealWonAnnouncement: {
    name: 'Celebrate won deals',
    description: 'When a deal is won, announce it in a WeldChat channel and log a note on the deal.',
    steps: {
      announce: 'Announce in WeldChat',
      log: 'Log a note',
    },
    text: {
      message: 'Deal won: {deal} ({amount}).',
      activitySubject: 'Deal won: {deal}',
      activityDescription: 'Announced in WeldChat by a workflow.',
    },
  },
  weeklyKickoff: {
    name: 'Weekly AI kickoff email',
    description: 'Every Monday at 08:00, let AI write a short kickoff message for the week and email it to your team.',
    steps: {
      write: 'Write the kickoff with AI',
      email: 'Email the team',
    },
    text: {
      prompt:
        'Write a short, friendly kickoff message for the team for the week starting {date}. Give three practical focus tips. Keep it under 150 words and write plain text.',
      subject: 'Weekly kickoff',
    },
  },
  webhookToContact: {
    name: 'Web form to contact and Slack',
    description: 'Receive form submissions on a webhook URL, add the sender as a contact and post a message to a Slack channel.',
    steps: {
      contact: 'Create the contact',
      slack: 'Post to Slack',
    },
    text: {
      slackText: 'New contact from the web form: {name} ({email})',
    },
  },
  contactApproval: {
    name: 'Review new contacts',
    description: 'Ask for an approval when a contact is added. Approved contacts get the "verified" tag, and you are notified about rejected ones.',
    steps: {
      review: 'Ask for approval',
      check: 'Approved?',
      tag: 'Tag as verified',
      notify: 'Notify about the rejection',
    },
    text: {
      reviewTitle: 'Review new contact {name}',
      reviewDescription: 'Check {name} ({email}) and approve to mark the contact as verified.',
      tag: 'verified',
      notifyTitle: 'Contact not approved: {name}',
      notifyBody: 'Comment: {comment}',
    },
  },
  companyToSheet: {
    name: 'Log new companies in Google Sheets',
    description: 'Append a row to a Google Sheet for every new company added to WeldCRM.',
    steps: {
      row: 'Append a row',
    },
    text: {
      columnName: 'Name',
      columnWebsite: 'Website',
      columnIndustry: 'Industry',
      columnEmail: 'Email',
      columnPhone: 'Phone',
    },
  },
  workflowFailureAlert: {
    name: 'Alert me when a workflow fails',
    description: 'Get a notification as soon as a run of another workflow fails, with a link to that run.',
    steps: {
      notify: 'Notify me',
    },
    text: {
      title: 'Workflow failed: {workflow}',
      body: 'A run of {workflow} did not complete. Open it to see what went wrong.',
    },
  },
  aiLeadTriage: {
    name: 'Sort new leads with AI',
    description: 'Let AI rate every new lead as hot, warm or cold, and get notified right away about the hot ones.',
    steps: {
      classify: 'Rate the lead with AI',
      check: 'Hot lead?',
      notify: 'Notify me',
    },
    text: {
      classifyText: 'Lead: {name}, {title} at {company} ({website}). Source: {source}.',
      hot: 'Hot',
      warm: 'Warm',
      cold: 'Cold',
      notifyTitle: 'Hot lead: {name}',
      notifyBody: '{company} looks like a strong fit. Follow up soon.',
    },
  },
  welcomeEmail: {
    name: 'Welcome email for new contacts',
    description: 'One day after a contact is added, send them a welcome email from your default WeldMail account.',
    steps: {
      wait: 'Wait one day',
      check: 'Has an email address?',
      email: 'Send the welcome email',
    },
    text: {
      subject: 'Welcome, {firstName}',
      body: '<p>Hi {firstName},</p><p>Thanks for getting in touch. We are glad to have you with us and will be in touch soon.</p><p>Kind regards</p>',
    },
  },
};
