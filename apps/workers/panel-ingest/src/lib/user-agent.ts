/**
 * A small user-agent reader: device class, browser and OS for the standard
 * columns, plus the bot check. Not a full UA database: it names the browsers
 * and systems that make up nearly all real traffic and leaves the rest null,
 * which the reports show as "unknown".
 */

export interface ParsedUserAgent {
  deviceType: 'desktop' | 'mobile' | 'tablet' | null;
  browser: string | null;
  os: string | null;
}

/**
 * Crawlers, link previewers, monitors, headless browsers and scripting HTTP
 * clients. `bot` is matched anywhere (Googlebot, bingbot, GPTBot) except in
 * "Cubot", an Android phone brand whose model name appears in real browsers.
 */
const BOT_USER_AGENT = new RegExp(
  [
    '(?<!cu)bot',
    'crawl',
    'spider',
    'slurp',
    'headless',
    'lighthouse',
    'pagespeed',
    'pingdom',
    'uptime',
    'statuscake',
    'gtmetrix',
    'facebookexternalhit',
    'bingpreview',
    'embedly',
    'python-requests',
    'python-urllib',
    'aiohttp',
    'curl/',
    'wget/',
    'libwww',
    'go-http-client',
    'java/',
    'apache-httpclient',
    'axios/',
    'node-fetch',
    'scrapy',
    'phantomjs',
    'selenium',
    'puppeteer',
    'wkhtmltopdf',
  ].join('|'),
  'i',
);

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  return !!userAgent && BOT_USER_AGENT.test(userAgent);
}

/** First match wins, so the browsers that also say "Chrome" or "Safari" come first. */
const BROWSERS: [RegExp, string][] = [
  [/\b(?:Edg|EdgA|EdgiOS|Edge)\//, 'Edge'],
  [/\bOPR\/|\bOPiOS\/|\bOpera\b/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/\bVivaldi\//, 'Vivaldi'],
  [/YaBrowser\//, 'Yandex'],
  [/DuckDuckGo\//, 'DuckDuckGo'],
  [/UCBrowser\/|UCWEB/, 'UC Browser'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/MSIE |Trident\//, 'Internet Explorer'],
  [/Chrome\/|CriOS\/|Chromium\//, 'Chrome'],
  // Safari proper says "Safari/"; a WKWebView only says AppleWebKit.
  [/Safari\/|AppleWebKit\//, 'Safari'],
];

/** Phones and tablets say "like Mac OS X" and "Linux" too, so they are tested before macOS and Linux. */
const SYSTEMS: [RegExp, string][] = [
  [/Windows Phone|IEMobile/, 'Windows Phone'],
  [/Windows/, 'Windows'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux|X11|Ubuntu|Fedora|Debian/, 'Linux'],
];

const TV_OR_CONSOLE = /SmartTV|Smart-TV|HbbTV|AppleTV|Tizen|Web0S|WebOS|NetCast|Roku|CrKey|Android TV|GoogleTV|BRAVIA|PlayStation|Xbox|Nintendo/i;
const TABLET = /iPad|Tablet|PlayBook|Kindle|Silk\/|Android(?!.*Mobile)/i;
const MOBILE = /iPhone|iPod|Windows Phone|IEMobile|BlackBerry|BB10|Opera Mini|Mobile|Mobi\b/i;

function firstMatch(table: [RegExp, string][], userAgent: string): string | null {
  for (const [pattern, name] of table) if (pattern.test(userAgent)) return name;
  return null;
}

export function parseUserAgent(userAgent: string | null | undefined): ParsedUserAgent {
  const ua = userAgent ?? '';
  const browser = firstMatch(BROWSERS, ua);
  const os = firstMatch(SYSTEMS, ua);

  let deviceType: ParsedUserAgent['deviceType'] = null;
  if (ua && !TV_OR_CONSOLE.test(ua)) {
    if (TABLET.test(ua)) deviceType = 'tablet';
    else if (MOBILE.test(ua)) deviceType = 'mobile';
    else if (browser || os) deviceType = 'desktop';
  }
  return { deviceType, browser, os };
}
