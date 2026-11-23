import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

import { PageMeta } from '../components/page-meta';
import { describeError, text } from '../lib/messages';

export function NotFound() {
  return (
    <div className="flex max-w-xl flex-col items-start gap-4">
      <PageMeta title={text.notFoundTitle} />
      <meta name="robots" content="noindex" />
      <h1 className="text-3xl font-semibold">{text.notFoundTitle}</h1>
      <p>{text.notFound}</p>
      <Link to="/" className="btn btn-primary">
        {text.goHome}
      </Link>
    </div>
  );
}

/** A page whose data could not load: a 404 as such, anything else with the API's reason. */
export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />;
  return (
    <div className="flex max-w-xl flex-col items-start gap-4">
      <h1 className="text-3xl font-semibold">{text.errorTitle}</h1>
      <p role="alert">{describeError(error)}</p>
      <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
        {text.tryReload}
      </button>
    </div>
  );
}

/** When even the shop's channel could not load: no header to draw. */
export function RootError() {
  return (
    <main id="main" className="mx-auto flex max-w-xl flex-col items-start gap-4 px-4 py-16">
      <RouteError />
    </main>
  );
}
