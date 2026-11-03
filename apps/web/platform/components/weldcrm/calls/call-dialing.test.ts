import { describe, it, expect } from 'vitest';
import { isWeldCallDialerPath } from './call-dialing';

describe('isWeldCallDialerPath', () => {
  it('matches the WeldCall landing page, which shows a live call in place', () => {
    expect(isWeldCallDialerPath('/weldcall')).toBe(true);
    expect(isWeldCallDialerPath('/weldcall/')).toBe(true);
    expect(isWeldCallDialerPath('/weldcall/new')).toBe(true);
  });

  it('leaves the floating panel everywhere else, WeldCall sub-pages included', () => {
    expect(isWeldCallDialerPath('/weldcall/history')).toBe(false);
    expect(isWeldCallDialerPath('/weldcall/call_123')).toBe(false);
    expect(isWeldCallDialerPath('/weldcrm/people')).toBe(false);
  });
});
