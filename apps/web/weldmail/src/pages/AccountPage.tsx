import { UserProfile } from '@clerk/clerk-react';

export function AccountPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[53px] shrink-0 items-center border-b border-border px-4">
        <h1 className="text-sm font-semibold text-foreground">Account</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <UserProfile
          routing="path"
          path="/account"
          appearance={{
            variables: {
              colorPrimary: '#1a1a1a',
            },
            elements: {
              rootBox: 'w-full max-w-none',
              cardBox: 'shadow-none border border-border rounded-xl',
            },
          }}
        />
      </div>
    </div>
  );
}
