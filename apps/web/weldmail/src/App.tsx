import { SignIn, SignUp } from '@clerk/clerk-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import {
  AppShell,
  ProtectedRoute,
  TokenBridge,
  useSyncPersonalToken,
} from '@/components/auth';
import { HomePage } from '@/pages/HomePage';
import { InboxPage } from '@/pages/InboxPage';
import { MessagePage } from '@/pages/MessagePage';
import { ComposePage } from '@/pages/ComposePage';
import { ClaimPage } from '@/pages/ClaimPage';

function ClerkAppearance() {
  return {
    variables: {
      colorPrimary: '#E85D4C',
      colorText: '#1c1917',
      borderRadius: '0.6rem',
    },
  } as const;
}

function SignInPage() {
  return (
    <div className="clerk-wrap">
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        forceRedirectUrl="/"
        appearance={ClerkAppearance()}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="clerk-wrap">
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        forceRedirectUrl="/"
        appearance={ClerkAppearance()}
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
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/inbox/:id" element={<MessagePage />} />
            <Route path="/compose" element={<ComposePage />} />
            <Route path="/claim" element={<ClaimPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </TokenBridge>
  );
}
