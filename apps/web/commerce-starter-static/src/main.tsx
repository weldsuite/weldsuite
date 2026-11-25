import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { configProblem } from './lib/client';
import { SETUP, text } from './lib/messages';
import { createRouter } from './router';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root');

function SetupNotice() {
  return (
    <main id="main" className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-16">
      <h1 className="text-3xl font-semibold">{text.setupTitle}</h1>
      <p>{text.setupIntro}</p>
      {configProblem ? <p role="alert">{SETUP[configProblem]}</p> : null}
    </main>
  );
}

async function start(root: HTMLElement) {
  if (configProblem) {
    createRoot(root).render(<SetupNotice />);
    return;
  }
  const router = createRouter();
  // A prerendered page (dist/products/<slug>/index.html) shows its HTML until
  // the app has the same page's data: wait for the first load, then take over.
  if (!router.state.initialized) {
    await new Promise<void>((resolve) => {
      const unsubscribe = router.subscribe((state) => {
        if (!state.initialized) return;
        unsubscribe();
        resolve();
      });
    });
  }
  // The prerender's head tags would contradict the app's own from here on.
  for (const tag of Array.from(document.head.querySelectorAll('[data-prerender]'))) tag.remove();
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}

void start(container);
