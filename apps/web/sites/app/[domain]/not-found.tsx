export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="text-center">
        <h1 className="text-6xl font-bold mb-4">404</h1>
        <h2 className="text-2xl font-semibold mb-4">Website Not Found</h2>
        <p className="text-muted-foreground">
          The website you are looking for does not exist or has been removed.
        </p>
      </div>
    </div>
  );
}