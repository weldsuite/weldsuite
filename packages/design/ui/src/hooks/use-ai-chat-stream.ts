"use client"

import { useState, useCallback, useRef } from "react"

import type { AiAction } from "./use-ai-stream"

interface StreamChunk {
  type: "chunk" | "action" | "done" | "error"
  content?: string
  action?: AiAction
  fullResponse?: string
}

interface UseAiChatStreamOptions {
  onAction?: (action: AiAction) => void
  onComplete?: (fullResponse: string) => void
  onError?: (error: string) => void
  startStream: (message: string, context?: unknown) => Promise<{ streamId: string }>
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
  // Mirrors streamingContent so the polling closure can read the latest value
  // without streamMessage being rebuilt on every chunk.
  const streamingContentRef = useRef("")
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const lastIndexRef = useRef(0)
  
  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }
  }, [])
  
  const streamMessage = useCallback(async (message: string, context?: unknown) => {
    setIsStreaming(true)
    setStreamingContent("")
    streamingContentRef.current = ""
    lastIndexRef.current = 0
    
    try {
      // Start the stream on the server
      const { streamId } = await startStream(message, context)
      
      // Poll for chunks
      pollingIntervalRef.current = setInterval(async () => {
        try {
          const { chunks, done, error } = await getChunks(streamId, lastIndexRef.current)
          
          if (error) {
            streamingContentRef.current = error
            setStreamingContent(error)
            if (onError) onError(error)
            stopPolling()
            setIsStreaming(false)
            return
          }
          
          // Process new chunks
          for (const chunk of chunks) {
            if (chunk.type === "chunk") {
              setStreamingContent(prev => { streamingContentRef.current = prev + chunk.content; return streamingContentRef.current })
            } else if (chunk.type === "action" && onAction && chunk.action) {
              onAction(chunk.action)
            } else if (chunk.type === "done") {
              if (onComplete) onComplete(chunk.fullResponse || streamingContentRef.current)
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
      streamingContentRef.current = errorMsg
      setStreamingContent(errorMsg)
      if (onError) onError(errorMsg)
    }
    
    return streamingContentRef.current
  }, [startStream, getChunks, onAction, onComplete, onError, stopPolling])
  
  return {
    isStreaming,
    streamingContent,
    streamMessage,
    stopPolling
  }
}