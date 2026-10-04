import { Component, useEffect, useState, type ReactNode } from 'react';
import { ClerkProvider, useAuth } from '@clerk/chrome-extension';
import { openTab } from '../lib/chrome-page';
import { readConfig, type ExtensionConfig } from '../lib/config';
import { t } from '../lib/i18n';
import { Button, Screen, Spinner } from './ui';
import { Vault } from './Vault';

const configuration = readConfig(import.meta.env);

function OpenWebApp({ config }: { config: ExtensionConfig }) {
  return (
    <Button variant="primary" autoFocus onClick={() => openTab(config.appUrl)}>
      {t('openWebApp')}
    </Button>
  );
}

/**
 * Clerk's extension SDK validates the manifest when it starts and throws if a
 * permission it needs is missing. Without a boundary that is a blank popup.
 */
class AuthBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function AuthGate({ config }: { config: ExtensionConfig }) {
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (isLoaded) return;
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, [isLoaded]);

  if (!isLoaded) {
    return (
      <Screen
        title="WeldPass"
        body={slow ? t('authSlow') : <Spinner label={t('loading')} />}
        action={slow ? <OpenWebApp config={config} /> : undefined}
      />
    );
  }
  if (!isSignedIn) {
    return (
      <Screen
        title={t('signedOutTitle')}
        body={t('signedOutBody')}
        action={<OpenWebApp config={config} />}
      />
    );
  }
  // The API takes the workspace from the token's active organization.
  if (!orgId) {
    return (
      <Screen
        title={t('noWorkspaceTitle')}
        body={t('noWorkspaceBody')}
        action={<OpenWebApp config={config} />}
      />
    );
  }
  return <Vault config={config} />;
}

export function App() {
  if (!configuration.ok) {
    return (
      <Screen
        title={t('notConfiguredTitle')}
        body={t('notConfiguredBody', configuration.missing.join(', '))}
      />
    );
  }
  const { config } = configuration;

  return (
    <AuthBoundary
      fallback={
        <Screen
          title={t('authFailedTitle')}
          body={t('authSlow')}
          action={<OpenWebApp config={config} />}
        />
      }
    >
      {/* `syncHost` makes the SDK reuse the web app's Clerk session instead of
          signing in on its own; the extension has no sign-in UI. */}
      <ClerkProvider publishableKey={config.publishableKey} syncHost={config.syncHost}>
        <AuthGate config={config} />
      </ClerkProvider>
    </AuthBoundary>
  );
}
