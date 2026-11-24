// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { loginFields, submittedLogin } from './detect';
import { fillLogin, fillNewPasswords, fillOtp } from './fill';

function page(html: string): void {
  document.body.innerHTML = html;
}

function input(selector: string, root: ParentNode = document): HTMLInputElement {
  const found = root.querySelector<HTMLInputElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('loginFields', () => {
  it('finds a login form from its password field', () => {
    page(`<form>
      <input type="email" name="email" />
      <input type="password" name="password" />
    </form>`);
    const fields = loginFields(input('[name=password]'));
    expect(fields).toMatchObject({ kind: 'login', hasPassword: true, hasUsername: true });
    expect(fields?.username).toBe(input('[name=email]'));
    expect(fields?.password).toBe(input('[name=password]'));
  });

  it('treats the username field of a login form as a login field', () => {
    page(`<form><input name="login" /><input type="password" /></form>`);
    expect(loginFields(input('[name=login]'))?.kind).toBe('login');
  });

  it('prefers fields the page marks with autocomplete', () => {
    page(`<form>
      <input name="company" />
      <input name="who" autocomplete="username" />
      <input name="note" />
      <input type="password" autocomplete="current-password" />
    </form>`);
    expect(loginFields(input('[type=password]'))?.username).toBe(input('[name=who]'));
  });

  it('finds the first step of a two-step login, with no password yet', () => {
    page(`<form><input type="email" id="identifier" /><button>Next</button></form>`);
    expect(loginFields(input('#identifier'))).toMatchObject({ kind: 'login', hasPassword: false, hasUsername: true });
  });

  it('ignores search boxes, coupon fields and fields of no login', () => {
    page(`<form role="search"><input type="search" name="q" /></form>
      <input name="coupon" /><input name="city" />`);
    expect(loginFields(input('[name=q]'))).toBeNull();
    expect(loginFields(input('[name=coupon]'))).toBeNull();
    expect(loginFields(input('[name=city]'))).toBeNull();
  });

  it('ignores hidden, disabled and read-only fields', () => {
    page(`<form>
      <input type="password" id="hidden" style="display:none" />
      <input type="password" id="disabled" disabled />
      <input type="password" id="readonly" readonly />
    </form>`);
    for (const id of ['hidden', 'disabled', 'readonly']) expect(loginFields(input(`#${id}`))).toBeNull();
  });

  it('sees a sign-up form: new-password fields get the generator, not saved logins', () => {
    page(`<form>
      <input type="email" name="email" />
      <input type="password" name="password" autocomplete="new-password" />
      <input type="password" name="confirm" autocomplete="new-password" />
    </form>`);
    const fields = loginFields(input('[name=password]'));
    expect(fields?.kind).toBe('new-password');
    expect(fields?.newPasswords).toHaveLength(2);
    expect(fields?.hasPassword).toBe(false);
    // The username of a sign-up is the person's to choose.
    expect(loginFields(input('[name=email]'))).toBeNull();
  });

  it('reads unmarked sign-up and change-password forms from their fields', () => {
    page(`<form id="signup">
      <input type="password" name="password" />
      <input type="password" name="password_confirm" />
    </form>
    <form id="change">
      <input type="password" name="a" /><input type="password" name="b" /><input type="password" name="c" />
    </form>`);
    expect(loginFields(input('#signup [name=password]'))?.kind).toBe('new-password');
    expect(loginFields(input('#change [name=a]'))?.kind).toBe('login');
    expect(loginFields(input('#change [name=b]'))?.kind).toBe('new-password');
    expect(loginFields(input('#change [name=a]'))?.newPasswords.map((field) => field.name)).toEqual(['b', 'c']);
  });

  it('finds one-time-code fields, one field or one box per digit', () => {
    page(`<form id="one"><input autocomplete="one-time-code" name="code" /></form>
      <form id="boxes">${Array.from({ length: 6 }, (_, i) => `<input name="otp${i}" maxlength="1" inputmode="numeric" />`).join('')}</form>`);
    expect(loginFields(input('#one [name=code]'))?.kind).toBe('one-time-code');
    const boxes = loginFields(input('#boxes [name=otp0]'));
    expect(boxes?.kind).toBe('one-time-code');
    expect(boxes?.otp).toHaveLength(6);
  });

  it('finds fields inside an open shadow root, scoped to that root', () => {
    page(`<login-box></login-box><input type="password" id="outside" />`);
    const host = document.querySelector('login-box')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<input name="user" autocomplete="username" /><input type="password" name="pass" />`;
    const fields = loginFields(input('[name=pass]', root));
    expect(fields).toMatchObject({ kind: 'login', hasUsername: true });
    expect(fields?.scope).toBe(root);
    expect(fields?.username).toBe(input('[name=user]', root));
  });
});

describe('filling', () => {
  it('sets values the way typing would, so controlled inputs see them', () => {
    page(`<form><input name="user" /><input type="password" name="pass" /></form>`);
    const events: string[] = [];
    for (const field of document.querySelectorAll('input')) {
      field.addEventListener('input', () => events.push(`input:${field.name}`));
      field.addEventListener('change', () => events.push(`change:${field.name}`));
    }
    const fields = loginFields(input('[name=pass]'))!;
    expect(fillLogin(fields, 'ada@example.com', 's3cret')).toBe(2);
    expect(input('[name=user]').value).toBe('ada@example.com');
    expect(input('[name=pass]').value).toBe('s3cret');
    expect(events).toEqual(['input:user', 'change:user', 'input:pass', 'change:pass']);
    // The password is filled last and keeps focus.
    expect(document.activeElement).toBe(input('[name=pass]'));
  });

  it('fills only the username on the first step of a two-step login', () => {
    page(`<form><input type="email" name="email" /></form>`);
    const fields = loginFields(input('[name=email]'))!;
    expect(fillLogin(fields, 'ada@example.com', null)).toBe(1);
    expect(input('[name=email]').value).toBe('ada@example.com');
  });

  it('spreads a code over one box per digit', () => {
    page(`<form>${Array.from({ length: 6 }, (_, i) => `<input name="d${i}" maxlength="1" inputmode="numeric" autocomplete="one-time-code" />`).join('')}</form>`);
    const fields = loginFields(input('[name=d0]'))!;
    expect(fillOtp(fields, '123456')).toBe(6);
    expect([...document.querySelectorAll('input')].map((box) => box.value).join('')).toBe('123456');
  });

  it('puts a generated password into the password and its confirmation', () => {
    page(`<form><input type="password" autocomplete="new-password" /><input type="password" autocomplete="new-password" /></form>`);
    const fields = loginFields(input('input'))!;
    expect(fillNewPasswords(fields, 'Generated-1')).toBe(2);
    expect([...document.querySelectorAll('input')].every((box) => box.value === 'Generated-1')).toBe(true);
  });
});

describe('submittedLogin', () => {
  it('reads the username and password of a submitted login form', () => {
    page(`<form><input name="user" value="ada" /><input type="password" value="pw" /></form>`);
    expect(submittedLogin(document.querySelector('form')!)).toEqual({ username: 'ada', password: 'pw' });
  });

  it('takes the new password of a sign-up or change-password form', () => {
    page(`<form>
      <input type="email" value="ada@example.com" />
      <input type="password" autocomplete="current-password" value="old" />
      <input type="password" autocomplete="new-password" value="new" />
      <input type="password" autocomplete="new-password" value="new" />
    </form>`);
    expect(submittedLogin(document.querySelector('form')!)).toEqual({ username: 'ada@example.com', password: 'new' });
  });

  it('reads the username of a first step, with an empty password', () => {
    page(`<form><input type="email" value="ada@example.com" /></form>`);
    expect(submittedLogin(document.querySelector('form')!)).toEqual({ username: 'ada@example.com', password: '' });
  });

  it('has nothing to say about a form with no login in it', () => {
    page(`<form><input name="city" value="Utrecht" /></form>`);
    expect(submittedLogin(document.querySelector('form')!)).toBeNull();
  });
});
