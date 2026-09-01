import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Personal inboxes used to be unreachable once a Clerk org was active.
 * These source guards lock the product decision: workspace membership
 * no longer excludes personal-api, and Add account can create a personal
 * address while signed into a workspace.
 */
describe('Personal + workspace coexistence', () => {
  const layout = readFileSync(join(__dirname, '../_layout.tsx'), 'utf8');
  const mailContext = readFileSync(join(__dirname, '../../contexts/MailContext.tsx'), 'utf8');
  const addAccount = readFileSync(join(__dirname, '../add-account.tsx'), 'utf8');

  it('AuthGuard does not treat org membership as excluding personal mail', () => {
    expect(layout).toMatch(/Personal mail is loaded alongside workspace/);
    expect(mailContext).toMatch(/personalApi\.me/);
    expect(mailContext).toMatch(/tenantKind: 'personal'/);
  });

  it('Add account can create a personal WeldMail address', () => {
    expect(addAccount).toMatch(/personalApi\.weldmail/);
    expect(addAccount).toMatch(/canAddPersonal/);
    expect(addAccount).toMatch(/setScreen\('personal'\)/);
  });

  it('MailContext also lists mailboxes from every workspace', () => {
    expect(mailContext).toMatch(/appApi\.mailboxes\.list/);
  });
});
