
import { useSearchParams, Link } from '@/lib/router';
import { Button } from "@weldsuite/ui/components/button";
import {
  Plus,
  FileText,
  CheckCircle,
  FolderOpen,
  Eye,
} from "lucide-react";
import { ServerHelpArticlesDataTable } from "./server-help-articles-data-table";
import { useHelpArticleStats } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

interface HelpArticleStatsData {
  totalArticles: number;
  publishedCount: number;
  draftCount: number;
  archivedCount: number;
  totalViews: number;
  categories: number;
}

export default function HelpPage() {
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const th = t.helpdesk.helpArticles;
  const status = searchParams.get('status') || 'all';
  const folder = searchParams.get('folder') || undefined;

  const { data: statsResult, isLoading } = useHelpArticleStats();
  const stats = statsResult as unknown as HelpArticleStatsData | undefined;

  if (isLoading) return <PageLoader fullScreen={false} />;

  const { publishedCount, draftCount, totalViews, categories } = stats || {
    totalArticles: 0,
    publishedCount: 0,
    draftCount: 0,
    archivedCount: 0,
    totalViews: 0,
    categories: 0,
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-8 max-w-[1600px] space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{th.title}</h1>
            <div className="flex items-center gap-6 mt-3">
              <div className="flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <span className="font-medium">{publishedCount}</span> {th.published}
                </span>
                <span className="text-muted-foreground">-</span>
                <span className="flex items-center gap-1">
                  <FileText className="h-4 w-4 text-yellow-600" />
                  <span className="font-medium">{draftCount}</span> {th.draft}
                </span>
                <span className="text-muted-foreground">-</span>
                <span className="flex items-center gap-1">
                  <FolderOpen className="h-4 w-4 text-purple-600" />
                  <span className="font-medium">{categories}</span> {th.categories}
                </span>
                <span className="text-muted-foreground">-</span>
                <span className="flex items-center gap-1">
                  <Eye className="h-4 w-4 text-blue-600" />
                  <span className="font-medium">{totalViews.toLocaleString()}</span> {th.views}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href={folder ? `/welddesk/help/new?category=${encodeURIComponent(folder)}` : "/welddesk/help/new"}>
              <Button className="h-8 text-sm px-3 flex items-center gap-2 shadow-none">
                <Plus className="h-4 w-4" />
                {th.newArticle}
              </Button>
            </Link>
          </div>
        </div>

        {/* Help Articles Table with server-side pagination */}
        <div className="space-y-6 mt-8">
          <ServerHelpArticlesDataTable initialStatus={status} />
        </div>
      </div>
    </div>
  );
}
