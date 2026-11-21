import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SignInForm } from '@/components/sign-in-form';
import { safePath } from '@/lib/actions/state';
import { getShopper } from '@/lib/data';
import { single } from '@/lib/params';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SignInPage({ searchParams }: Props) {
  const next = safePath(single((await searchParams).next) ?? '', '/account');
  if (await getShopper()) redirect(next);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Sign in</h1>
        <p className="text-ink-muted">We email you a code to sign in. No password needed; new here? This creates your account.</p>
      </div>
      <SignInForm next={next} />
    </div>
  );
}
