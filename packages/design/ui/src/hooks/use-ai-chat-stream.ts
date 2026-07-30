"use client"

import { useState, useCallback, useRef } from "react"

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

interface UseAiChatStreamOptions {
  onAction?: (action: StreamAction) => void
  onComplete?: (fullResponse: string) => void
  onError?: (error: string) => void
  startStream: (message: string, context?: StreamContext) => Promise<{ streamId: string }>
  getChunks: (streamId: string, lastIndex: number) => Promise<{
    chunks: StreamChunk[]
    done: boolean
    error?: string
  }>
}

export function useAiChatStream({
  onAction,
  onComplete,
  onError,
  startStream,
  getChunks
}: UseAiChatStreamOptions) {
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingContent, setStreamingContent] = useState("")
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const lastIndexRef = useRef(0)
  // Mirrors `streamingContent`. `streamMessage` is a stable callback, so the
  // state variable it closes over is always the value from when the stream
  // started (""), which made both `onComplete` and the return value report an
  // empty response. The ref always holds what has actually accumulated.
  const contentRef = useRef("")
  
  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }
  }, [])
  
  const streamMessage = useCallback(async (message: string, context?: StreamContext) => {
    setIsStreaming(true)
    setStreamingContent("")
    contentRef.current = ""
    lastIndexRef.current = 0
    
    try {
      // Start the stream on the server
      const { streamId } = await startStream(message, context)
      
      // Poll for chunks
      pollingIntervalRef.current = setInterval(async () => {
        try {
          const { chunks, done, error } = await getChunks(streamId, lastIndexRef.current)
          
          if (error) {
            contentRef.current = error
            setStreamingContent(error)
            if (onError) onError(error)
            stopPolling()
            setIsStreaming(false)
            return
          }
          
          // Process new chunks
          for (const chunk of chunks) {
            if (chunk.type === "chunk") {
              contentRef.current += chunk.content
              setStreamingContent(prev => prev + chunk.content)
            } else if (chunk.type === "action" && onAction) {
              onAction(chunk.action ?? {})
            } else if (chunk.type === "done") {
              if (onComplete) onComplete(chunk.fullResponse || contentRef.current)
            } else if (chunk.type === "error") {
              if (onError) onError(chunk.content || "An error occurred")
            }
          }
          
          lastIndexRef.current += chunks.length
          
          if (done) {
            stopPolling()
            setIsStreaming(false)
          }
        } catch (error) {
          console.error("Polling error:", error)
          stopPolling()
          setIsStreaming(false)
          if (onError) onError("Failed to fetch stream chunks")
        }
      }, 100) // Poll every 100ms
      
    } catch (error) {
      console.error("Stream start error:", error)
      setIsStreaming(false)
      const errorMsg = error instanceof Error ? error.message : "Failed to start stream"
      contentRef.current = errorMsg
      setStreamingContent(errorMsg)
      if (onError) onError(errorMsg)
    }

    return contentRef.current
  }, [startStream, getChunks, onAction, onComplete, onError, stopPolling])
  
  return {
    isStreaming,
    streamingContent,
    streamMessage,
    stopPolling
  }
}