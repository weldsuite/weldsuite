import { SignIn, SignUp } from '@clerk/clerk-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import {
  AppShell,
  ProtectedRoute,
  TokenBridge,
  useSyncPersonalToken,
} from '@/components/auth';
import { MailEventsProvider } from '@/contexts/mail-events';
import { HomePage } from '@/pages/HomePage';
import { InboxPage } from '@/pages/InboxPage';
import { MessagePage } from '@/pages/MessagePage';
import { ComposePage } from '@/pages/ComposePage';
import { ClaimPage } from '@/pages/ClaimPage';
import { PricingPage } from '@/pages/PricingPage';
import { AccountPage } from '@/pages/AccountPage';

const clerkAppearance = {
  variables: {
    colorPrimary: '#1a1a1a',
  },
} as const;

function SignInPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center justify-center px-4">
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        forceRedirectUrl="/"
        appearance={clerkAppearance}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center justify-center px-4">
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        forceRedirectUrl="/"
        appearance={clerkAppearance}
      />
    </div>
  );
}

export default function App() {
  useSyncPersonalToken();

  return (
    <TokenBridge>
      <Routes>
        <Route path="/sign-in/*" element={<SignInPage />} />
        <Route path="/sign-up/*" element={<SignUpPage />} />

        <Route element={<ProtectedRoute />}>
          {/* Inside ProtectedRoute so the realtime socket only opens once a
              user is signed in and Clerk can mint a token for it. */}
          <Route element={<MailEventsProvider><AppShell /></MailEventsProvider>}>
            <Route path="/" element={<HomePage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/inbox/:id" element={<MessagePage />} />
            <Route path="/compose" element={<ComposePage />} />
            <Route path="/claim" element={<ClaimPage />} />
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/account/*" element={<AccountPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </TokenBridge>
  );
}
