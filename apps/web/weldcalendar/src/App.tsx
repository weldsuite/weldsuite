import { SignIn, SignUp } from '@clerk/clerk-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import {
  AppShell,
  ProtectedRoute,
  TokenBridge,
  useSyncPersonalToken,
} from '@/components/auth';
import { HomePage } from '@/pages/HomePage';
import { CalendarPage } from '@/pages/CalendarPage';
import { SchedulingPage } from '@/pages/SchedulingPage';
import { SchedulingEditorPage } from '@/pages/SchedulingEditorPage';
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
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/scheduling" element={<SchedulingPage />} />
            <Route path="/scheduling/new" element={<SchedulingEditorPage />} />
            <Route path="/scheduling/:id" element={<SchedulingEditorPage />} />
            <Route path="/pricing" element={<PricingPage />} />
            <Route path="/account/*" element={<AccountPage />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </TokenBridge>
  );
}
