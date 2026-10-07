"use client"

import * as React from "react"
import {
  Bot,
  Send,
  Sparkles,
  Code,
  FileSearch,
  Bug,
  User,
  ChevronDown,
  Trash2,
} from "lucide-react"
import { Button } from "./button"
import { Input } from "./input"
import { ScrollArea } from "./scroll-area"
import { Avatar, AvatarFallback } from "./avatar"
import { cn } from "../lib/utils"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover"
import { TypingIndicator, StreamingCursor } from "./ai-typing-indicator"

interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: Date
  isStreaming?: boolean
}

interface Suggestion {
  id: string
  title: string
  description: string
  icon: React.ReactNode
  action: string
  category: "code" | "debug" | "improve" | "search"
}

import type { AiAction, AiActionRecord, AiActionResult, AiStreamChunk } from "../hooks/use-ai-stream"

interface AiChatDropdownProps {
  onSendMessage?: (message: string) => Promise<string>
  onStartStream?: (message: string) => Promise<{ streamId: string }>
  onGetChunks?: (streamId: string, lastIndex: number) => Promise<{
    chunks: AiStreamChunk[]
    isComplete: boolean
    error?: string
  }>
  onAction?: (action: AiAction) => void
  className?: string
}

const defaultSuggestions: Suggestion[] = [
  {
    id: "1",
    title: "Generate Code",
    description: "Create boilerplate code",
    icon: <Code className="h-3 w-3" />,
    action: "generate",
    category: "code",
  },
  {
    id: "2",
    title: "Debug Issue",
    description: "Help debug errors",
    icon: <Bug className="h-3 w-3" />,
    action: "debug",
    category: "debug",
  },
  {
    id: "3",
    title: "Improve Code",
    description: "Optimize performance",
    icon: <Sparkles className="h-3 w-3" />,
    action: "improve",
    category: "improve",
  },
  {
    id: "4",
    title: "Search Docs",
    description: "Find documentation",
    icon: <FileSearch className="h-3 w-3" />,
    action: "search",
    category: "search",
  },
]

type SetMessages = React.Dispatch<React.SetStateAction<Message[]>>

/** Strip action markers and the assistant's generic filler sentences. */
function stripAssistantBoilerplate(text: string): string {
  return text
    .replaceAll(/\[ACTION:[^\]]+\]/g, "") // Remove action markers
    .replaceAll("I'll get that information for you.", "") // Remove generic text
    .replaceAll("Let me retrieve those details.", "")
}

function cleanMessageContent(text: string): string {
  return stripAssistantBoilerplate(text).replaceAll(/\s+/g, " ").trim()
}

/** Apply `patch` to the message with `id`, leaving every other message untouched. */
function patchMessage(
  setMessages: SetMessages,
  id: string,
  patch: (msg: Message) => Message
) {
  setMessages((prev) => prev.map((msg) => (msg.id === id ? patch(msg) : msg)))
}

function describeListResult(data: AiActionRecord[], label: string): string {
  const count = data.length
  if (count === 0) {
    return `I couldn't find any ${label}s in your workspace.`
  }
  const name = data[0]?.name
  if (count === 1) {
    const found = `I found 1 ${label}.`
    return name ? `${found} It's "${name}".` : found
  }
  const found = `I found ${count} ${label}s.`
  return name ? `${found} Including "${name}".` : found
}

function describeFoundResult(data: AiActionResult["data"], label: string): string {
  if (!data) {
    return `I couldn't find that ${label}.`
  }
  const record: AiActionRecord | null =
    typeof data === "object" && !Array.isArray(data) ? data : null
  const found = `I found the ${label}.`
  return record?.name ? `${found} It's "${record.name}".` : found
}

/** Append `text` to the cleaned-up message content. */
function appendCleaned(text: string): (content: string) => string {
  return (content) => `${cleanMessageContent(content)} ${text}`.trim()
}

/**
 * Turn an action result into a function that rewrites the assistant message
 * content, or `null` when the result adds nothing to the message.
 */
function buildActionResultUpdate(
  result: AiActionResult,
  action: AiAction
): ((content: string) => string) | null {
  if (!result.success) {
    // Show error inline
    const reason =
      typeof result.error === "string" && result.error ? result.error : "Unable to fetch data."
    return (content) => content + ` I encountered an issue: ${reason}`
  }

  const label = action.params?.model?.toLowerCase() || "item"
  const type = result.type

  if (type?.includes("count")) {
    // A non-numeric payload reads as 0 rather than "[object Object]".
    const count = Number(result.data ?? 0) || 0
    return appendCleaned(`You have ${count} ${label}s in your workspace.`)
  }
  if (type?.includes("list") && Array.isArray(result.data)) {
    return appendCleaned(describeListResult(result.data, label))
  }
  if (type?.includes("found")) {
    return appendCleaned(describeFoundResult(result.data, label))
  }

  // For other types, just append the message
  const message = result.message
  return message ? (content) => content + " " + message : null
}

/** Run a host action right away and fold its result into the assistant message. */
function runAction(
  onAction: (action: AiAction) => void,
  action: AiAction,
  setMessages: SetMessages,
  assistantMessageId: string
) {
  Promise.resolve(onAction(action) as AiActionResult | void)
    .then((result) => {
      if (!result) return
      const update = buildActionResultUpdate(result, action)
      if (!update) return
      patchMessage(setMessages, assistantMessageId, (msg) => ({
        ...msg,
        content: update(msg.content),
      }))
    })
    .catch((error: unknown) => {
      console.error("Action error:", error)
      patchMessage(setMessages, assistantMessageId, (msg) => ({
        ...msg,
        content: msg.content + " I encountered an error while fetching the data.",
      }))
    })
}

/** Split a batch of stream chunks into appended text and host actions. */
function collectChunks(
  chunks: AiStreamChunk[],
  acceptActions: boolean
): { text: string; hasNewContent: boolean; actions: AiAction[] } {
  let text = ""
  let hasNewContent = false
  const actions: AiAction[] = []
  for (const chunk of chunks) {
    if (chunk.type === "chunk") {
      text += chunk.content
      hasNewContent = true
    } else if (chunk.type === "action" && acceptActions && chunk.action) {
      actions.push(chunk.action)
    }
  }
  return { text, hasNewContent, actions }
}

export function AiChatDropdown({
  onSendMessage,
  onStartStream,
  onGetChunks,
  onAction,
  className,
}: Readonly<AiChatDropdownProps>) {
  const [open, setOpen] = React.useState(false)
  const [messages, setMessages] = React.useState<Message[]>([])
  const [input, setInput] = React.useState("")
  const [, setStreamingMessageId] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

  React.useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight
    }
  }, [messages])

  const handleSendMessage = async (content: string) => {
    if (!content.trim() || isLoading) return

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content,
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInput("")
    setIsLoading(true)

    // Use streaming if available, otherwise fall back to regular message
    if (onStartStream && onGetChunks) {
      await streamReply(content, onStartStream, onGetChunks)
    } else {
      await replyWithoutStreaming(content)
    }
  }

  const streamReply = async (
    content: string,
    startStream: NonNullable<AiChatDropdownProps["onStartStream"]>,
    getChunks: NonNullable<AiChatDropdownProps["onGetChunks"]>
  ) => {
    const assistantMessageId = (Date.now() + 1).toString()
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      timestamp: new Date(),
      isStreaming: true,
    }

    setMessages((prev) => [...prev, assistantMessage])
    setStreamingMessageId(assistantMessageId)

    try {
      // Start the stream
      const { streamId } = await startStream(content)

      let lastIndex = 0
      let pollCount = 0
      const maxPolls = 300 // 30 seconds max

      // Wait a moment for the stream to initialize
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Poll for chunks with batching to reduce re-renders
      let accumulatedContent = ""
      let updateTimer: NodeJS.Timeout | null = null

      const updateMessage = () => {
        if (!accumulatedContent) return
        const pending = accumulatedContent
        patchMessage(setMessages, assistantMessageId, (msg) => ({
          ...msg,
          content: msg.content + pending,
        }))
        accumulatedContent = ""
      }

      const flushPending = () => {
        if (updateTimer) clearTimeout(updateTimer)
        updateMessage()
      }

      const finishStream = () => {
        clearInterval(pollInterval)
        setStreamingMessageId(null)
        setIsLoading(false)
      }

      const pollInterval = setInterval(async () => {
        pollCount++

        try {
          const { chunks, isComplete, error } = await getChunks(streamId, lastIndex)

          if (error) {
            // Clear any pending updates
            flushPending()
            patchMessage(setMessages, assistantMessageId, (msg) => ({
              ...msg,
              content: error,
              isStreaming: false,
            }))
            finishStream()
            return
          }

          // Process chunks
          const collected = collectChunks(chunks, !!onAction)
          accumulatedContent += collected.text

          // Batch updates to reduce re-renders
          if (collected.hasNewContent) {
            if (updateTimer) clearTimeout(updateTimer)
            // Clean content before updating
            accumulatedContent = stripAssistantBoilerplate(accumulatedContent)
            updateTimer = setTimeout(updateMessage, 100) // Update every 100ms max
          }

          // Execute actions immediately without waiting and append results to the message
          if (onAction) {
            for (const action of collected.actions) {
              runAction(onAction, action, setMessages, assistantMessageId)
            }
          }

          lastIndex += chunks.length

          if (isComplete || pollCount >= maxPolls) {
            // Final update
            flushPending()
            patchMessage(setMessages, assistantMessageId, (msg) => ({
              ...msg,
              isStreaming: false,
            }))
            finishStream()
          }
        } catch (error) {
          console.error("Polling error:", error)
          finishStream()
        }
      }, 100) // Poll every 100ms
    } catch {
      patchMessage(setMessages, assistantMessageId, (msg) => ({
        ...msg,
        content: "Sorry, I encountered an error. Please try again.",
        isStreaming: false,
      }))
      setStreamingMessageId(null)
      setIsLoading(false)
    }
  }

  const replyWithoutStreaming = async (content: string) => {
    try {
      if (!onSendMessage) {
        throw new Error("No AI service configured. Please configure streaming or message handlers.")
      }

      const response = await onSendMessage(content)

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: response,
        timestamp: new Date(),
      }

      setMessages((prev) => [...prev, assistantMessage])
    } catch (error) {
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: error instanceof Error ? error.message : "Sorry, I encountered an error. Please try again.",
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, errorMessage])
    } finally {
      setIsLoading(false)
    }
  }

  const handleSuggestionClick = (suggestion: Suggestion) => {
    onAction?.({ type: suggestion.action })
    const promptMap: { [key: string]: string } = {
      generate: "Help me generate code for ",
      debug: "I need help debugging ",
      improve: "How can I improve ",
      search: "Search documentation for ",
    }
    
    const prompt = promptMap[suggestion.action] || "Help me with "
    void handleSendMessage(prompt + suggestion.title.toLowerCase())
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSendMessage(input)
    }
  }

  const clearChat = () => {
    setMessages([])
    setInput("")
  }

  const showSuggestions = messages.length === 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("gap-2", className)}
        >
          <Bot className="h-4 w-4" />
          <span className="hidden sm:inline">AI Assistant</span>
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent 
        className="w-[380px] p-0" 
        align="end"
        sideOffset={8}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            <span className="font-semibold text-sm">AI Assistant</span>
          </div>
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={clearChat}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>

        {/* Chat Area */}
        <ScrollArea 
          ref={scrollAreaRef}
          className="h-[300px] px-4 py-3"
        >
          {showSuggestions ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground mb-3">
                Quick actions:
              </p>
              <div className="grid gap-2">
                {defaultSuggestions.map((suggestion, index) => (
                  <button
                    key={suggestion.id}
                    onClick={() => handleSuggestionClick(suggestion)}
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-lg text-left",
                      "hover:bg-accent transition-all duration-200",
                      "border border-transparent hover:border-border",
                      "hover:shadow-sm animate-in fade-in slide-in-from-bottom-1"
                    )}
                    style={{ animationDelay: `${index * 50}ms` }}
                  >
                    <div className={cn(
                      "p-1.5 rounded-md mt-0.5",
                      suggestion.category === "code" && "bg-blue-500/10 text-blue-500",
                      suggestion.category === "debug" && "bg-red-500/10 text-red-500",
                      suggestion.category === "improve" && "bg-purple-500/10 text-purple-500",
                      suggestion.category === "search" && "bg-green-500/10 text-green-500"
                    )}>
                      {suggestion.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">
                        {suggestion.title}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {suggestion.description}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {messages.map((message, index) => (
                <div
                  key={message.id}
                  className={cn(
                    "flex gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300",
                    message.role === "user" && "justify-end"
                  )}
                  style={{ animationDelay: `${index * 50}ms` }}
                >
                  {message.role === "assistant" && (
                    <Avatar className="h-6 w-6 shrink-0">
                      <AvatarFallback className="text-xs bg-primary/10">
                        <Bot className="h-3 w-3" />
                      </AvatarFallback>
                    </Avatar>
                  )}
                  <div
                    className={cn(
                      "rounded-lg px-3 py-2 max-w-[85%] transition-all",
                      "text-sm",
                      message.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted",
                      message.isStreaming && "min-h-[32px]"
                    )}
                  >
                    {message.isStreaming && !message.content ? (
                      <TypingIndicator className="py-0.5" />
                    ) : (
                      <p className="break-words leading-relaxed">
                        {message.content}
                        {message.isStreaming && <StreamingCursor />}
                      </p>
                    )}
                  </div>
                  {message.role === "user" && (
                    <Avatar className="h-6 w-6 shrink-0">
                      <AvatarFallback className="text-xs">
                        <User className="h-3 w-3" />
                      </AvatarFallback>
                    </Avatar>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Input Area */}
        <div className="p-3">
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={showSuggestions ? "Ask me anything..." : "Type a message..."}
              disabled={isLoading}
              className="flex-1 h-8 text-sm"
            />
            <Button
              onClick={() => handleSendMessage(input)}
              disabled={isLoading || !input.trim()}
              size="icon"
              className="h-8 w-8 transition-all"
            >
              {isLoading ? (
                <div className="animate-pulse">
                  <Send className="h-3 w-3 opacity-50" />
                </div>
              ) : (
                <Send className={cn(
                  "h-3 w-3 transition-transform",
                  input.trim() && "hover:translate-x-0.5"
                )} />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Press Enter to send • Esc to close
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}