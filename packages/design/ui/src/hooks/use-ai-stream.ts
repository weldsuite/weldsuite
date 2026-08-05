"use client"

import { useState, useCallback } from "react"

/** A command the assistant asks the host app to run, with a free-form payload. */
export interface AiAction {
  type: string
  /** Action arguments, e.g. `{ model: 'Customer' }`. */
  params?: Record<string, string | undefined>
  [key: string]: unknown
}

/** A record an action returned, as far as the chat formatting cares. */
export interface AiActionRecord {
  name?: string
  [key: string]: unknown
}

/** One frame of an assistant response stream. */
export interface AiStreamChunk {
  type: "chunk" | "action" | "done" | "error"
  content?: string
  action?: AiAction
  error?: string
}

/** What the host app returns after running an AiAction. */
export interface AiActionResult {
  success?: boolean
  /** Result kind, e.g. `'count'` / `'list'` / `'found'`. */
  type?: string
  message?: string
  data?: AiActionRecord | AiActionRecord[] | string | number | null
  [key: string]: unknown
}

interface StreamChunk {
  type: "chunk" | "action" | "done" | "error"
  content?: string
  action?: AiAction
  fullResponse?: string
}

interface UseAiStreamOptions {
  onAction?: (action: AiAction) => void
  onError?: (error: string) => void
  onComplete?: (fullResponse: string) => void
}

export function useAiStream(options?: UseAiStreamOptions) {
  const [isStreaming, setIsStreaming] = useState(false)
  const [currentMessage, setCurrentMessage] = useState("")
  
  const streamMessage = useCallback(async (
    sendMessage: (message: string, context?: unknown) => AsyncGenerator<StreamChunk>,
    message: string,
    context?: unknown
  ) => {
    setIsStreaming(true)
    setCurrentMessage("")
    
    try {
      const stream = sendMessage(message, context)
      
      for await (const chunk of stream) {
        switch (chunk.type) {
          case "chunk":
            setCurrentMessage(prev => prev + chunk.content)
            break
            
          case "action":
            if (options?.onAction && chunk.action) {
              options.onAction(chunk.action)
            }
            break
            
          case "done":
            if (options?.onComplete) {
              options.onComplete(chunk.fullResponse || currentMessage)
            }
            break
            
          case "error":
            setCurrentMessage(chunk.content || "An error occurred")
            if (options?.onError) {
              options.onError(chunk.content || "An error occurred")
            }
            break
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "An error occurred"
      setCurrentMessage(errorMessage)
      if (options?.onError) {
        options.onError(errorMessage)
      }
    } finally {
      setIsStreaming(false)
    }
  }, [currentMessage, options])
  
  return {
    isStreaming,
    currentMessage,
    streamMessage,
    setCurrentMessage
  }
}