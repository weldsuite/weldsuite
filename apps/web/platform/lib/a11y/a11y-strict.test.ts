// @vitest-environment node
/**
 * TASK-1184: folders whose accessibility pass is done stay clean. ESLint
 * reports the a11y rules there too (eslint/a11y-strict.mjs), but the shared
 * config turns every rule into a warning, so this test is what blocks CI.
 */
import { join } from 'node:path';
import { ESLint, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, expect, it } from 'vitest';
import { A11Y_RULE_PREFIXES, A11Y_STRICT_FOLDERS, a11yPlugin } from '../../eslint/a11y-strict.mjs';

const PLATFORM = join(__dirname, '..', '..');

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const rule = (name: string) => a11yPlugin.rules![name] as Parameters<typeof ruleTester.run>[1];

describe('weldsuite-a11y rules', () => {
  ruleTester.run('icon-button-has-name', rule('icon-button-has-name'), {
    valid: [
      '<Button>Save</Button>',
      '<Button aria-label={t.close}><X /></Button>',
      '<Button><X /><span className="sr-only">{t.close}</span></Button>',
      '<Button><X />{label}</Button>',
      '<Button {...props}><X /></Button>',
      '<Button asChild><Link to="/">{t.home}</Link></Button>',
    ],
    invalid: [
      { code: '<Button size="icon"><X className="h-4 w-4" /></Button>', errors: [{ messageId: 'missing' }] },
      { code: '<button onClick={f}>{busy ? <Loader /> : <Send />}</button>', errors: [{ messageId: 'missing' }] },
    ],
  });

  ruleTester.run('field-has-name', rule('field-has-name'), {
    valid: [
      '<input aria-label={t.subject} placeholder={t.subject} />',
      '<Input id="name" />',
      '<label>{t.name}<input /></label>',
      '<input type="hidden" name="x" />',
      '<input type="file" className="hidden" />',
      '<div contentEditable aria-label={t.body} />',
    ],
    invalid: [
      { code: '<input placeholder={t.subject} />', errors: [{ messageId: 'missing' }] },
      { code: '<Textarea value={v} />', errors: [{ messageId: 'missing' }] },
      { code: '<div contentEditable />', errors: [{ messageId: 'missing' }] },
    ],
  });

  ruleTester.run('outline-none-has-focus-style', rule('outline-none-has-focus-style'), {
    valid: [
      '<input className="outline-none focus-visible:ring-1" />',
      '<div tabIndex={0} className={cn("outline-none", "focus:bg-accent")} />',
      '<Button className="focus-visible:outline-none" />',
      '<div className="focus-within:ring-2"><input className="outline-none focus-visible:ring-1" /></div>',
    ],
    invalid: [
      { code: '<input className="w-full outline-none bg-transparent" />', errors: [{ messageId: 'missing' }] },
      { code: '<SelectTrigger className="focus:ring-0 focus:outline-none" />', errors: [{ messageId: 'missing' }] },
      { code: '<a className={`p-1 ${x} focus:outline-none`} />', errors: [{ messageId: 'missing' }] },
    ],
  });

  ruleTester.run('dialog-has-title', rule('dialog-has-title'), {
    valid: [
      '<DialogContent><DialogHeader><DialogTitle>a</DialogTitle><DialogDescription>b</DialogDescription></DialogHeader></DialogContent>',
      '<DialogContent aria-describedby={undefined}><DialogTitle>a</DialogTitle></DialogContent>',
      '<SheetContent>{open && <SheetTitle>a</SheetTitle>}<SheetDescription>b</SheetDescription></SheetContent>',
    ],
    invalid: [
      { code: '<DialogContent><Form /></DialogContent>', errors: [{ messageId: 'title' }, { messageId: 'description' }] },
      { code: '<AlertDialogContent><AlertDialogTitle>a</AlertDialogTitle></AlertDialogContent>', errors: [{ messageId: 'description' }] },
    ],
  });
});

describe('accessibility-strict folders', () => {
  it('have no accessibility lint findings', { timeout: 300_000 }, async () => {
    const eslint = new ESLint({ cwd: PLATFORM });
    const results = await eslint.lintFiles(A11Y_STRICT_FOLDERS);
    expect(results.length).toBeGreaterThan(A11Y_STRICT_FOLDERS.length);
    const findings = results.flatMap((r) =>
      r.messages
        .filter((m) => m.fatal || A11Y_RULE_PREFIXES.some((p) => m.ruleId?.startsWith(p)))
        .map((m) => `${r.filePath.slice(PLATFORM.length + 1)}:${m.line} ${m.ruleId ?? 'parse error'}`),
    );
    expect(findings).toEqual([]);
  });
});
