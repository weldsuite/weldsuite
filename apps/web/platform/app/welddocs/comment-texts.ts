/**
 * Comments between a document's chat and a .docx file. A discussion's text
 * lives in the document's WeldChat chat (ADR CHAT-007), so a .docx written
 * here reads it from there, and the comments of an imported .docx are posted
 * there once the document exists.
 */

import type { CommentText, DocSnapshot, DocxCommentThread } from '@weldsuite/docs-engine';
import { weldchatEntityApi } from '@/lib/api/domains/weldchat-entity';
import { plainComment } from '@/components/record-comments/mentions';
import { groupThreads } from '@/components/record-comments/use-record-comments';

/** What is said in each of a document's discussions, as a .docx keeps it (first comment first). */
export async function commentTexts(docId: string): Promise<(thread: string) => CommentText[]> {
  const { messages } = await weldchatEntityApi.getRecordComments('doc', docId);
  const threads = groupThreads(messages);
  return (thread) =>
    (threads.get(thread)?.messages ?? []).map((m) => ({ author: m.authorName, createdAt: Date.parse(m.createdAt), body: plainComment(m.content) }));
}

/**
 * Posts an imported file's comments to the new document's chat, each thread
 * as a thread. They are posted by whoever imports the file, so each says
 * who wrote it in Word.
 */
export async function postImportedComments(docId: string, snapshot: DocSnapshot, threads: readonly DocxCommentThread[]): Promise<void> {
  const quotes = new Map((snapshot.comments ?? []).map((c) => [c.id, c.quote]));
  for (const thread of threads) {
    const [first, ...replies] = thread.comments;
    if (!first) continue;
    const quote = quotes.get(thread.thread);
    const { message } = await weldchatEntityApi.sendEntityMessage('doc', docId, {
      content: said(first),
      metadata: { anchor: { id: thread.thread, ...(quote ? { quote } : {}) } },
    });
    for (const reply of replies) await weldchatEntityApi.sendEntityMessage('doc', docId, { content: said(reply), parentId: message.id });
  }
}

const said = (c: CommentText) => (c.author ? `${c.author}: ${c.body}` : c.body);

/** A snapshot without its comment threads (suggestions stay), for a document that has no chat. */
export function withoutCommentThreads(snapshot: DocSnapshot): DocSnapshot {
  const comments = (snapshot.comments ?? []).filter((c) => c.suggestion);
  const { comments: _all, ...rest } = snapshot;
  return { ...rest, anchors: snapshot.anchors.filter((a) => a.kind !== 'comment'), ...(comments.length ? { comments } : {}) };
}
