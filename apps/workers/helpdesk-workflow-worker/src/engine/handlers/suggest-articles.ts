import { eq, and, isNull } from 'drizzle-orm';
import { schema } from '../../db';
import type { StepHandler, StepContext, StepResult } from '../../types';

export const suggestArticlesHandler: StepHandler = {
  type: 'suggest_articles',

  async execute(ctx: StepContext): Promise<StepResult> {
    const query = String(ctx.inputs.query || ctx.inputs.searchTerm || '');
    const limit = Number(ctx.inputs.limit || 3);

    try {
      const articles = await ctx.options.db
        .select({
          id: schema.helpdeskArticles.id,
          title: schema.helpdeskArticles.title,
          slug: schema.helpdeskArticles.slug,
          excerpt: schema.helpdeskArticles.excerpt,
        })
        .from(schema.helpdeskArticles)
        .where(
          and(
            eq(schema.helpdeskArticles.status, 'published'),
            isNull(schema.helpdeskArticles.deletedAt),
          ),
        )
        .limit(limit);

      ctx.emit({
        event: 'step:suggest_articles',
        data: {
          articles: articles.map((a) => ({
            id: a.id,
            title: a.title,
            snippet: a.excerpt || '',
            url: `/articles/${a.slug}`,
          })),
        },
      });

      return { success: true, articleCount: articles.length };
    } catch (err) {
      console.error('[SuggestArticles] Failed to fetch articles:', err);
      return { success: false, error: 'Failed to fetch articles' };
    }
  },
};
