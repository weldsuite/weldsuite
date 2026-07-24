
import { useParams, useRouter } from '@/lib/router';
import { useNewsArticle, type NewsArticle } from '@/hooks/queries/use-helpdesk-queries';
import { NewsViewer } from './news-viewer';
import { PageLoader } from '@/components/page-loader';

/** Raw row shape returned by `GET /helpdesk-news/:id` (app-api). */
interface RawNewsItem {
  id?: string;
  title?: string;
  excerpt?: string;
  content?: string;
  authorName?: string;
  category?: 'company' | 'product' | 'industry' | 'announcement';
  status?: 'draft' | 'published' | 'scheduled';
  publishedAt?: string | Date;
  createdAt?: string | Date;
  viewCount?: number;
  featuredImage?: string;
  tags?: string[];
}

export default function NewsPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const { data: response, isLoading } = useNewsArticle(id, !!id);
  const raw: RawNewsItem | undefined = response?.data;

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!raw) {
    router.push('/welddesk/news');
    return null;
  }

  const article: NewsArticle = {
    id: raw.id || id,
    title: raw.title || '',
    excerpt: raw.excerpt || '',
    content: raw.content || '',
    author: raw.authorName || 'Unknown',
    category: raw.category || 'company',
    status: raw.status || 'draft',
    publishDate: new Date(raw.publishedAt || raw.createdAt || Date.now()),
    views: raw.viewCount || 0,
    featured: false,
    coverImage: raw.featuredImage,
    tags: raw.tags || [],
  };

  return <NewsViewer article={article} />;
}
