
import { ReactNode } from 'react';
import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { ProjectsHeader } from './projects-header';
import { ModuleContent } from '@/components/layout/module-content';

interface ProjectsLayoutClientProps {
  children: ReactNode;
}

export function ProjectsLayoutClient({ children }: ProjectsLayoutClientProps) {
  // When embedded inside another panel (e.g. WeldChat's project Expand
  // overlay), hide the weldflow module header so the iframed page reads as
  // "just the project" with no duplicate chrome.
  //
  // The flag is set via `?embedded=1` on the initial iframe load and
  // persisted in `window.name` (per-browsing-context — doesn't leak to the
  // parent tab) so it survives in-iframe navigation between project tabs
  // (Tasks → Sheets → Gantt …) which strips the query string.
  const isEmbedded =
    typeof window !== 'undefined' &&
    (new URLSearchParams(window.location.search).get('embedded') === '1' ||
      window.name === 'weldsuite-embedded');

  return (
    <BreadcrumbProvider>
      <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
        {!isEmbedded && <ProjectsHeader />}
        <ModuleContent className="overflow-y-auto overflow-x-hidden px-3 md:px-4 pt-3 md:pt-4 subtle-scrollbar">
          {children}
        </ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
