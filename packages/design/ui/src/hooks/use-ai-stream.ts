"use client"

import { useState, useCallback } from "react"

/** A tool/UI action the assistant asks the host app to perform. */
export type StreamAction = Record<string, unknown>;

/** Free-form conversation context sent alongside a message. */
export type StreamContext = Record<string, unknown>;

interface StreamChunk {
  type: "chunk" | "action" | "done" | "error"
  content?: string
  action?: StreamAction
  fullResponse?: string
}

interface UseAiStreamOptions {
  onAction?: (action: StreamAction) => void
  onError?: (error: string) => void
  onComplete?: (fullResponse: string) => void
}

export function useAiStream(options?: UseAiStreamOptions) {
  const [isStreaming, setIsStreaming] = useState(false)
  const [currentMessage, setCurrentMessage] = useState("")
  
  const streamMessage = useCallback(async (
    sendMessage: (message: string, context?: StreamContext) => AsyncGenerator<StreamChunk>,
    message: string,
    context?: StreamContext
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
            if (options?.onAction) {
              options.onAction(chunk.action ?? {})
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