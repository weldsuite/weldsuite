
interface MailDetailWrapperProps {
  children: React.ReactNode;
}

/**
 * Wrapper component for the mail detail area.
 * Simply renders children - compose is now handled by routing.
 */
export function MailDetailWrapper({ children }: MailDetailWrapperProps) {
  return <>{children}</>;
}
