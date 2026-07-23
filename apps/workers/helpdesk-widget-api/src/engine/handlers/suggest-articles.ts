import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '../../db';
import type { StepHandler, StepContext, StepResult } from '../types';

export const suggestArticlesHandler: StepHandler = {
  type: 'suggest_articles',
  async execute(ctx: StepContext): Promise<StepResult> {
    const limit = Number(ctx.inputs.limit || 3);
    try {
      const articles = await ctx.options.db.select({ id: schema.helpdeskArticles.id, title: schema.helpdeskArticles.title, slug: schema.helpdeskArticles.slug })
        .from(schema.helpdeskArticles)
        .where(and(eq(schema.helpdeskArticles.status, 'published'), isNull(schema.helpdeskArticles.deletedAt)))
        .limit(limit);
      return { success: true, articleCount: articles.length };
    } catch {
      return { success: false, error: 'Failed to fetch articles' };
    }
  },
};
