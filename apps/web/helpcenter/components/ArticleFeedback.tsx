'use client'

import { useState } from 'react'

interface ArticleFeedbackProps {
  articleId: string
  domain: string
}

export function ArticleFeedback({ articleId, domain }: ArticleFeedbackProps) {
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  const handleFeedback = async (helpful: boolean) => {
    if (loading || submitted) return
    setLoading(true)
    setError(false)
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain, articleId, helpful }),
      })
      if (!res.ok) throw new Error(`Feedback failed: ${res.status}`)
      setSubmitted(true)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  if (submitted) {
    return (
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Thanks for your feedback!
      </p>
    )
  }

  return (
    <div>
      <p className="text-sm font-medium text-zinc-900 dark:text-white">Was this article helpful?</p>
      <div className="mt-3 flex gap-2.5">
        <button
          onClick={() => handleFeedback(true)}
          disabled={loading}
          className="rounded-lg border border-zinc-200 px-4 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:border-[var(--hc-accent)] hover:text-[var(--hc-accent)] disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200"
        >
          Yes
        </button>
        <button
          onClick={() => handleFeedback(false)}
          disabled={loading}
          className="rounded-lg border border-zinc-200 px-4 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-400 hover:text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:text-white"
        >
          No
        </button>
      </div>
      {error && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">
          Something went wrong. Please try again.
        </p>
      )}
    </div>
  )
}
