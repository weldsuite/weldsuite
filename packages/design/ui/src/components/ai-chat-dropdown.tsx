"use client"

import * as React from "react"
import {
  Bot,
  Send,
  Sparkles,
  Code,
  Lightbulb,
  FileSearch,
  Bug,
  MessageSquare,
  User,
  Loader2,
  ChevronDown,
  Trash2,
} from "lucide-react"
import { Button } from "./button"
import { Input } from "./input"
import { ScrollArea } from "./scroll-area"
import { Badge } from "./badge"
import { Avatar, AvatarFallback } from "./avatar"
import { cn } from "../lib/utils"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover"
import { Separator } from "./separator"
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

interface AiChatDropdownProps {
  onSendMessage?: (message: string) => Promise<string>
  onStartStream?: (message: string) => Promise<{ streamId: string }>
  onGetChunks?: (streamId: string, lastIndex: number) => Promise<{
    chunks: any[]
    isComplete: boolean
    error?: string
  }>
  onAction?: (action: any) => void
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

export function AiChatDropdown({
  onSendMessage,
  onStartStream,
  onGetChunks,
  onAction,
  className,
}: AiChatDropdownProps) {
  const [open, setOpen] = React.useState(false)
  const [messages, setMessages] = React.useState<Message[]>([])
  const [input, setInput] = React.useState("")
  const [isLoading, setIsLoading] = React.useState(false)
  const [streamingMessageId, setStreamingMessageId] = React.useState<string | null>(null)
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  
  console.log("AiChatDropdown received props:", {
    hasOnStartStream: !!onStartStream,
    hasOnGetChunks: !!onGetChunks,
    hasOnAction: !!onAction,
    hasOnSendMessage: !!onSendMessage
  })

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
    console.log("Streaming functions available:", !!onStartStream, !!onGetChunks)
    if (onStartStream && onGetChunks) {
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
        const { streamId } = await onStartStream(content)
        console.log("Stream started with ID:", streamId)
        
        let lastIndex = 0
        let pollCount = 0
        const maxPolls = 300 // 30 seconds max
        
        // Wait a moment for the stream to initialize
        await new Promise(resolve => setTimeout(resolve, 100))
        
        // Poll for chunks with batching to reduce re-renders
        let accumulatedContent = ""
        let updateTimer: NodeJS.Timeout | null = null
        const pendingActions: any[] = []
        
        const updateMessage = () => {
          if (accumulatedContent) {
            setMessages((prev) => 
              prev.map(msg => 
                msg.id === assistantMessageId 
                  ? { ...msg, content: msg.content + accumulatedContent }
                  : msg
              )
            )
            accumulatedContent = ""
          }
        }
        
        const pollInterval = setInterval(async () => {
          pollCount++
          
          try {
            const { chunks, isComplete, error } = await onGetChunks(streamId, lastIndex)
            
            if (error) {
              // Clear any pending updates
              if (updateTimer) clearTimeout(updateTimer)
              updateMessage()
              
              setMessages((prev) => 
                prev.map(msg => 
                  msg.id === assistantMessageId 
                    ? { ...msg, content: error, isStreaming: false }
                    : msg
                )
              )
              clearInterval(pollInterval)
              setStreamingMessageId(null)
              setIsLoading(false)
              return
            }
            
            // Process chunks
            let hasNewContent = false
            for (const chunk of chunks) {
              if (chunk.type === "chunk") {
                accumulatedContent += chunk.content
                hasNewContent = true
              } else if (chunk.type === "action" && onAction) {
                pendingActions.push(chunk.action)
              }
            }
            
            // Batch updates to reduce re-renders
            if (hasNewContent) {
              if (updateTimer) clearTimeout(updateTimer)
              // Clean content before updating
              accumulatedContent = accumulatedContent
                .replace(/\[ACTION:[^\]]+\]/g, '') // Remove action markers
                .replace(/I'll get that information for you\./g, '') // Remove generic text
                .replace(/Let me retrieve those details\./g, '')
              updateTimer = setTimeout(updateMessage, 100) // Update every 100ms max
            }
            
            // Process actions and append results to the message
            for (const action of pendingActions) {
              // Execute action immediately without waiting
              if (onAction) {
                const actionHandler = onAction;
                Promise.resolve(actionHandler(action)).then((result: any) => {
                  if (result) {
                    let resultContent = ""
                    
                    if (result.success) {
                      // Format the result based on the action type
                      if (result.type?.includes('count')) {
                        // Append count result to message
                        setMessages((prev) => 
                          prev.map(msg => {
                            if (msg.id === assistantMessageId) {
                              // Clean up the message first
                              let cleanContent = msg.content
                                .replace(/\[ACTION:[^\]]+\]/g, '') // Remove action markers
                                .replace(/I'll get that information for you\./g, '') // Remove generic text
                                .replace(/Let me retrieve those details\./g, '')
                                .replace(/\s+/g, ' ')
                                .trim()
                              
                              // Add the result
                              const resultText = `You have ${result.data} ${action.params.model?.toLowerCase() || 'item'}s in your workspace.`
                              return { ...msg, content: `${cleanContent} ${resultText}`.trim() }
                            }
                            return msg
                          })
                        )
                        return
                      } else if (result.type?.includes('list') && Array.isArray(result.data)) {
                        const count = result.data.length
                        let resultText = ""
                        
                        if (count === 0) {
                          resultText = `I couldn't find any ${action.params.model?.toLowerCase() || 'item'}s in your workspace.`
                        } else if (count === 1) {
                          resultText = `I found 1 ${action.params.model?.toLowerCase() || 'item'}.`
                          if (result.data[0]?.name) {
                            resultText += ` It's "${result.data[0].name}".`
                          }
                        } else {
                          resultText = `I found ${count} ${action.params.model?.toLowerCase() || 'item'}s.`
                          if (result.data[0]?.name) {
                            resultText += ` Including "${result.data[0].name}".`
                          }
                        }
                        
                        setMessages((prev) => 
                          prev.map(msg => {
                            if (msg.id === assistantMessageId) {
                              // Clean up the message first
                              let cleanContent = msg.content
                                .replace(/\[ACTION:[^\]]+\]/g, '') // Remove action markers
                                .replace(/I'll get that information for you\./g, '') // Remove generic text
                                .replace(/Let me retrieve those details\./g, '')
                                .replace(/\s+/g, ' ')
                                .trim()
                              
                              return { ...msg, content: `${cleanContent} ${resultText}`.trim() }
                            }
                            return msg
                          })
                        )
                        return
                      } else if (result.type?.includes('found')) {
                        let resultText = ""
                        
                        if (result.data) {
                          resultText = `I found the ${action.params.model?.toLowerCase() || 'item'}.`
                          if (result.data.name) {
                            resultText += ` It's "${result.data.name}".`
                          }
                        } else {
                          resultText = `I couldn't find that ${action.params.model?.toLowerCase() || 'item'}.`
                        }
                        
                        setMessages((prev) => 
                          prev.map(msg => {
                            if (msg.id === assistantMessageId) {
                              // Clean up the message first
                              let cleanContent = msg.content
                                .replace(/\[ACTION:[^\]]+\]/g, '') // Remove action markers
                                .replace(/I'll get that information for you\./g, '') // Remove generic text
                                .replace(/Let me retrieve those details\./g, '')
                                .replace(/\s+/g, ' ')
                                .trim()
                              
                              return { ...msg, content: `${cleanContent} ${resultText}`.trim() }
                            }
                            return msg
                          })
                        )
                        return
                      }
                      
                      // For other types, just append the message
                      if (result.message) {
                        setMessages((prev) => 
                          prev.map(msg => 
                            msg.id === assistantMessageId 
                              ? { ...msg, content: msg.content + " " + result.message }
                              : msg
                          )
                        )
                      }
                    } else {
                      // Show error inline
                      setMessages((prev) => 
                        prev.map(msg => 
                          msg.id === assistantMessageId 
                            ? { ...msg, content: msg.content + ` I encountered an issue: ${result.error || 'Unable to fetch data.'}` }
                            : msg
                        )
                      )
                    }
                  }
                }).catch((error: any) => {
                  console.error("Action error:", error)
                  setMessages((prev) => 
                    prev.map(msg => 
                      msg.id === assistantMessageId 
                        ? { ...msg, content: msg.content + " I encountered an error while fetching the data." }
                        : msg
                    )
                  )
                })
              }
            }
            pendingActions.length = 0
            
            lastIndex += chunks.length
            
            if (isComplete || pollCount >= maxPolls) {
              // Final update
              if (updateTimer) clearTimeout(updateTimer)
              updateMessage()
              
              setMessages((prev) => 
                prev.map(msg => 
                  msg.id === assistantMessageId 
                    ? { ...msg, isStreaming: false }
                    : msg
                )
              )
              clearInterval(pollInterval)
              setStreamingMessageId(null)
              setIsLoading(false)
            }
          } catch (error) {
            console.error("Polling error:", error)
            clearInterval(pollInterval)
            setStreamingMessageId(null)
            setIsLoading(false)
          }
        }, 100) // Poll every 100ms
        
      } catch (error) {
        setMessages((prev) => 
          prev.map(msg => 
            msg.id === assistantMessageId 
              ? { ...msg, content: "Sorry, I encountered an error. Please try again.", isStreaming: false }
              : msg
          )
        )
        setStreamingMessageId(null)
        setIsLoading(false)
      }
    } else {
      // Fallback to non-streaming
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
  }

  const handleSuggestionClick = (suggestion: Suggestion) => {
    onAction?.(suggestion.action)
    const promptMap: { [key: string]: string } = {
      generate: "Help me generate code for ",
      debug: "I need help debugging ",
      improve: "How can I improve ",
      search: "Search documentation for ",
    }
    
    const prompt = promptMap[suggestion.action] || "Help me with "
    handleSendMessage(prompt + suggestion.title.toLowerCase())
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage(input)
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