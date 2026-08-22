/**
 * Registry of help doc screenshots.
 *
 * Each entry maps a committed PNG under public/images/help/ to a live URL.
 * Platform scenes render real WeldHost components via /preview/help-docs.
 */
export const screenshotManifest = [
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
