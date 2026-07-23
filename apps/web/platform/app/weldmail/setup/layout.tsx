export default function MailSetupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // This layout intentionally doesn't include the MailSidebar
  // because we're in the setup flow where no accounts exist yet
  return <>{children}</>;
}
