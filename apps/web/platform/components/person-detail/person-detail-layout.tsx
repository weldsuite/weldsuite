
import { ReactNode } from 'react';
import { PersonDetailHeader, PersonDetailHeaderProps } from './person-detail-header';
import { PersonDetailSidebar, PersonDetailSidebarProps } from './person-detail-sidebar';
import { PersonDetailContent, PersonDetailContentProps } from './person-detail-content';

export interface PersonDetailLayoutProps {
  /** Header configuration */
  header: PersonDetailHeaderProps;
  /** Sidebar configuration */
  sidebar: PersonDetailSidebarProps;
  /** Content configuration */
  content: PersonDetailContentProps;
}

export function PersonDetailLayout({ header, sidebar, content }: PersonDetailLayoutProps) {
  return (
    <div className="h-full overflow-auto">
      {/* Header */}
      <div className="bg-background">
        <div className="container mx-auto px-4 md:px-8 max-w-7xl pt-4 md:pt-6">
          <PersonDetailHeader {...header} />
        </div>
      </div>

      {/* Content */}
      <div className="container mx-auto px-4 md:px-8 max-w-7xl pb-6">
        <div className="flex flex-col md:flex-row gap-6 md:gap-8">
          <PersonDetailSidebar {...sidebar} />
          <PersonDetailContent {...content} />
        </div>
      </div>
    </div>
  );
}
