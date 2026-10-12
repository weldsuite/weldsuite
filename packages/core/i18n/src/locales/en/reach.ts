/**
 * WeldReach — cold email outreach (on request only). See docs/plans/weldreach.md.
 */
export const reach = {
  title: 'WeldReach',
  tagline: 'Cold email outreach from dedicated mailboxes',

  // Requesting access (app store) and the states a workspace sees before approval.
  access: {
    requestAccess: 'Request access',
    requestTitle: 'Request access to WeldReach',
    requestIntro:
      'WeldReach is available on request. Tell us how you plan to use it; we review every request by hand and usually reply within two working days.',
    onlyAdmins: 'Only workspace owners and admins can request access.',
    status: {
      none: 'Not requested',
      requested: 'Request pending',
      approved: 'Approved',
      rejected: 'Request rejected',
      suspended: 'Access suspended',
      revoked: 'Access revoked',
    },
    pendingTitle: 'Your request is being reviewed',
    pendingDescription: 'We will email you as soon as WeldReach is enabled for this workspace.',
    rejectedTitle: 'Your request was not approved',
    rejectedDescription: 'You can update your answers and request access again.',
    suspendedTitle: 'WeldReach is suspended for this workspace',
    suspendedDescription: 'Sending is stopped. Contact support if you think this is a mistake.',
    reason: 'Reason',
    requestAgain: 'Request again',
    submitted: 'Request sent. We will get back to you by email.',
    alreadyPending: 'A request for this workspace is already pending.',
    form: {
      companyName: 'Company legal name',
      website: 'Website',
      contactName: 'Contact person',
      contactEmail: 'Contact email',
      useCase: 'What will you use WeldReach for?',
      useCasePlaceholder: 'Who do you want to reach, with what offer, and why would they want to hear from you?',
      expectedDailySends: 'Expected emails per day',
      targetCountries: 'Countries you will email',
      targetCountriesPlaceholder: 'Select countries',
      listSource: 'Where do your contact lists come from?',
      listSources: {
        own_customers: 'Our own customers and past customers',
        own_research: 'Our own research (company websites, events, referrals)',
        bought_list: 'A bought or rented list',
        other: 'Other',
      },
      listSourceDetails: 'Tell us more about your lists',
      consentNotice:
        'In the Netherlands and Germany, emailing business addresses also requires prior consent, unless the recipient is an existing customer. Only email those countries if you have that consent.',
      termsTitle: 'Before you send',
      termsIntro: 'Tick each statement to confirm it.',
      submit: 'Send request',
      submitting: 'Sending…',
    },
    terms: {
      b2b_only: 'We email business addresses only, never consumers.',
      comply_with_law:
        'We comply with anti-spam and privacy law (GDPR, ePrivacy, CAN-SPAM and others) in every country we email, including prior consent where it is required.',
      identify_and_opt_out:
        'Every email identifies us as the sender and contains a working opt-out, and we honour opt-outs permanently.',
      lawful_lists: 'We do not use lists that were collected without a lawful basis.',
      suspension:
        'WeldSuite may pause or suspend sending at any time, for example after complaints, high bounce rates or a legal request, and may share our details with authorities when the law requires it.',
      responsible_for_content: 'We are responsible for the content we send and for the people we contact.',
    },
  },
};
