import { describe, expect, it } from 'vitest';
import {
  emptySipTrunkForm,
  ipRowsOf,
  isIpv4,
  sipTrunkFormToInput,
  validateSipTrunkForm,
} from './sip-trunk-form';

describe('sip trunk form', () => {
  it('recognises IPv4 addresses', () => {
    expect(isIpv4('8.8.8.8')).toBe(true);
    expect(isIpv4(' 203.0.114.10 ')).toBe(true);
    expect(isIpv4('256.1.1.1')).toBe(false);
    expect(isIpv4('1.1.1')).toBe(false);
    expect(isIpv4('example.com')).toBe(false);
  });

  it('needs a name, and for an IP phone system at least one valid address', () => {
    expect(validateSipTrunkForm(emptySipTrunkForm())).toEqual([{ kind: 'name' }, { kind: 'ipRequired' }]);
    const bad = { ...emptySipTrunkForm(), name: 'X', ips: [{ ip: '8.8.8.8', port: '70000' }, { ip: 'nope', port: '' }] };
    expect(validateSipTrunkForm(bad)).toEqual([
      { kind: 'port', index: 0 },
      { kind: 'ip', index: 1, ip: 'nope' },
    ]);
    expect(validateSipTrunkForm({ ...emptySipTrunkForm(), name: 'X', authMode: 'credentials' })).toEqual([]);
  });

  it('turns the form into the request, dropping blank rows and the addresses of a login trunk', () => {
    const values = {
      ...emptySipTrunkForm(),
      name: ' Head office ',
      ips: [{ ip: ' 8.8.8.8 ', port: '' }, { ip: '', port: '' }, { ip: '1.1.1.1', port: '5070' }],
    };
    expect(sipTrunkFormToInput(values)).toEqual({
      name: 'Head office',
      provider: 'xelion',
      authMode: 'ip',
      transport: 'udp',
      ipAddresses: [{ ip: '8.8.8.8' }, { ip: '1.1.1.1', port: 5070 }],
    });
    expect(sipTrunkFormToInput({ ...values, authMode: 'credentials' })).not.toHaveProperty('ipAddresses');
  });

  it('turns saved addresses back into rows', () => {
    expect(ipRowsOf([{ ip: '8.8.8.8', port: 5070 }, { ip: '1.1.1.1' }])).toEqual([
      { ip: '8.8.8.8', port: '5070' },
      { ip: '1.1.1.1', port: '' },
    ]);
    expect(ipRowsOf([])).toEqual([{ ip: '', port: '' }]);
  });
});
