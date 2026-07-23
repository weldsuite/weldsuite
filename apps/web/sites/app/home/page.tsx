export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">WeldSuite Sites</h1>
        <p className="text-lg text-muted-foreground mb-8">
          Welcome to the customer website platform
        </p>
        <div className="max-w-md mx-auto">
          <p className="text-sm text-muted-foreground">
            To view a customer website, visit their custom domain or subdomain.
          </p>
          <p className="text-sm text-muted-foreground mt-4">
            For local development, use: <code className="bg-muted px-2 py-1 rounded">subdomain.localhost:3007</code>
          </p>
        </div>
      </div>
    </div>
  );
}