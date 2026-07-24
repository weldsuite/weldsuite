
import { useI18n } from "@/lib/i18n/provider";
import "./files-table.css";
import { Button } from "@weldsuite/ui/components/button";
import { Folder, FolderOpen } from "lucide-react";
import { Link } from '@/lib/router';

export default function FilesPage() {
  const { t } = useI18n();
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-8 max-w-[1600px] space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{t.projects.filesPage.title}</h1>
            <p className="text-muted-foreground mt-1">
              {t.projects.filesPage.description}
            </p>
          </div>
        </div>

        {/* Empty State */}
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-muted p-6 mb-6">
            <FolderOpen className="h-12 w-12 text-muted-foreground" />
          </div>
          <h2 className="text-xl font-semibold mb-2">{t.projects.filesPage.selectProject}</h2>
          <p className="text-muted-foreground max-w-md mb-6">
            {t.projects.filesPage.selectProjectDescription}
          </p>
          <Link href="/weldflow/all-projects">
            <Button>
              <Folder className="h-4 w-4 mr-0.5" />
              {t.projects.filesPage.browseProjects}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
