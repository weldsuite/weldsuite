import { describe, expect, it } from 'vitest';
import { isBotUserAgent, parseUserAgent } from './user-agent';

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  chromeAndroidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
  chromeAndroidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Safari/537.36',
  samsungBrowser:
    'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0',
  operaWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ie11: 'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; AS; rv:11.0) like Gecko',
  webview:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  smartTv:
    'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 94.0.4606.31/7.0 TV Safari/537.36',
  cubotPhone:
    'Mozilla/5.0 (Linux; Android 10; CUBOT_X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
};

describe('parseUserAgent', () => {
  it.each([
    ['Chrome on Windows', UA.chromeWindows, { deviceType: 'desktop', browser: 'Chrome', os: 'Windows' }],
    ['Edge on Windows (also says Chrome and Safari)', UA.edgeWindows, { deviceType: 'desktop', browser: 'Edge', os: 'Windows' }],
    ['Firefox on Linux', UA.firefoxLinux, { deviceType: 'desktop', browser: 'Firefox', os: 'Linux' }],
    ['Safari on macOS', UA.safariMac, { deviceType: 'desktop', browser: 'Safari', os: 'macOS' }],
    ['Safari on iPhone (says Mac OS X too)', UA.safariIphone, { deviceType: 'mobile', browser: 'Safari', os: 'iOS' }],
    ['Chrome on iPhone', UA.chromeIphone, { deviceType: 'mobile', browser: 'Chrome', os: 'iOS' }],
    ['Safari on iPad (says Mobile too)', UA.safariIpad, { deviceType: 'tablet', browser: 'Safari', os: 'iOS' }],
    ['Chrome on an Android phone', UA.chromeAndroidPhone, { deviceType: 'mobile', browser: 'Chrome', os: 'Android' }],
    ['Chrome on an Android tablet (no "Mobile")', UA.chromeAndroidTablet, { deviceType: 'tablet', browser: 'Chrome', os: 'Android' }],
    ['Samsung Internet', UA.samsungBrowser, { deviceType: 'mobile', browser: 'Samsung Internet', os: 'Android' }],
    ['Firefox on Android', UA.firefoxAndroid, { deviceType: 'mobile', browser: 'Firefox', os: 'Android' }],
    ['Opera', UA.operaWindows, { deviceType: 'desktop', browser: 'Opera', os: 'Windows' }],
    ['Chrome on ChromeOS', UA.chromeOs, { deviceType: 'desktop', browser: 'Chrome', os: 'ChromeOS' }],
    ['Internet Explorer 11', UA.ie11, { deviceType: 'desktop', browser: 'Internet Explorer', os: 'Windows' }],
    ['an iOS web view', UA.webview, { deviceType: 'mobile', browser: 'Safari', os: 'iOS' }],
  ])('%s', (_label, ua, expected) => {
    expect(parseUserAgent(ua)).toEqual(expected);
  });

  it('gives a smart TV no device class', () => {
    expect(parseUserAgent(UA.smartTv).deviceType).toBeNull();
  });

  it('gives nothing for an empty or unknown agent', () => {
    expect(parseUserAgent('')).toEqual({ deviceType: null, browser: null, os: null });
    expect(parseUserAgent(undefined)).toEqual({ deviceType: null, browser: null, os: null });
    expect(parseUserAgent('SomethingOdd/1.0')).toEqual({ deviceType: null, browser: null, os: null });
  });
});

describe('isBotUserAgent', () => {
  it.each([
    ['Googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
    ['bingbot', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
    ['GPTBot', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)'],
    ['Baiduspider', 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)'],
    ['Yahoo Slurp', 'Mozilla/5.0 (compatible; Yahoo! Slurp; http://help.yahoo.com/help/us/ysearch/slurp)'],
    ['facebookexternalhit', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
    ['Lighthouse', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Chrome-Lighthouse'],
    ['headless Chrome', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36'],
    ['curl', 'curl/8.4.0'],
    ['python-requests', 'python-requests/2.31.0'],
    ['Go http client', 'Go-http-client/2.0'],
    ['UptimeRobot', 'Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)'],
  ])('flags %s', (_label, ua) => {
    expect(isBotUserAgent(ua)).toBe(true);
  });

  it.each([
    ['Chrome on Windows', UA.chromeWindows],
    ['Safari on iPhone', UA.safariIphone],
    ['Firefox on Linux', UA.firefoxLinux],
    ['a Cubot phone', UA.cubotPhone],
  ])('does not flag %s', (_label, ua) => {
    expect(isBotUserAgent(ua)).toBe(false);
  });

  it('does not flag a missing agent', () => {
    expect(isBotUserAgent('')).toBe(false);
    expect(isBotUserAgent(null)).toBe(false);
  });
});
