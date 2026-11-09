/**
 * Registry of help doc screenshots.
 *
 * Each entry maps a committed PNG under public/images/help/ to a live URL.
 * Platform scenes render real WeldHost components via /preview/help-docs.
 */
export const screenshotManifest = [
  {
    file: 'onboarding-workspace.png',
    url: (env) => `${env.platformBase}/preview/help-docs?scene=onboarding`,
    selector: '[data-screenshot-frame]',
    readySelector: '[data-screenshot-ready="true"]',
  },
  {
    file: 'weldhost-domains.png',
    url: (env) => `${env.platformBase}/preview/help-docs?scene=domains`,
    selector: '[data-screenshot-frame]',
    readySelector: '[data-screenshot-ready="true"]',
  },
  {
    file: 'dns-navigation.png',
    url: (env) => `${env.platformBase}/preview/help-docs?scene=dns-list`,
    selector: '[data-screenshot-frame]',
    readySelector: '[data-screenshot-ready="true"]',
  },
  {
    file: 'dns-add-record.png',
    url: (env) => `${env.platformBase}/preview/help-docs?scene=dns-add`,
    selector: '[data-screenshot-frame]',
    readySelector: '[data-screenshot-ready="true"]',
  },
  {
    file: 'dns-record-types.png',
    url: (env) => `${env.platformBase}/preview/help-docs?scene=dns-list`,
    selector: '[data-screenshot-frame]',
    readySelector: '[data-screenshot-ready="true"]',
  },
  {
    file: 'dns-locked.png',
    url: (env) => `${env.platformBase}/preview/help-docs?scene=dns-locked`,
    selector: '[data-screenshot-frame]',
    readySelector: '[data-screenshot-ready="true"]',
  },
]

/**
 * WeldForms guides. The scenes are the real module under /preview/weldforms,
 * answered in the browser by apps/web/platform/app/preview/weldforms
 * (no backend, no Clerk session). Capture only these with
 * `pnpm --filter docs capture-screenshots weldforms`.
 */
const weldformsShot = (file, route, readySelector) => ({
  file,
  url: (env) => `${env.platformBase}/preview/weldforms${route}`,
  selector: '[data-screenshot-frame]',
  readySelector,
})

screenshotManifest.push(
  weldformsShot('weldforms-home.png', '', 'text=Customer feedback (NPS)'),
  weldformsShot('weldforms-builder.png', '/frm_preview_feedback/edit', 'text=Add question'),
  weldformsShot('weldforms-logic.png', '/frm_preview_feedback/logic', 'text=Otherwise go to'),
  weldformsShot('weldforms-design.png', '/frm_preview_feedback/design', 'text=Midnight'),
  weldformsShot('weldforms-respondents.png', '/frm_preview_feedback/settings', 'text=Respondents'),
  weldformsShot('weldforms-share.png', '/frm_preview_event/share', 'text=Public link'),
  weldformsShot('weldforms-integrations.png', '/frm_preview_feedback/integrations', 'text=WeldCRM'),
  weldformsShot('weldforms-results-summary.png', '/frm_preview_feedback/results?tab=summary', 'text=How likely are you to recommend us'),
  weldformsShot('weldforms-results-responses.png', '/frm_preview_feedback/results?tab=responses', 'text=Submitted at'),
  weldformsShot('weldforms-results-insights.png', '/frm_preview_feedback/results?tab=insights', 'text=Where people drop off'),
  weldformsShot('weldforms-limits.png', '/settings', 'text=Completed responses'),
)
