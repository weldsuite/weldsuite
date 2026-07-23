"use client"

import * as React from "react"
import {
  Bot,
  Send,
  X,
  Code,
  Lightbulb,
  FileSearch,
  Bug,
  MessageSquare,
  User,
  Loader2,
} from "lucide-react"
import { Button } from "./button"
import { Input } from "./input"
import { ScrollArea } from "./scroll-area"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card"
import { Badge } from "./badge"
import { Avatar, AvatarFallback, AvatarImage } from "./avatar"
import { cn } from "../lib/utils"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./sheet"

interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: Date
}

interface Suggestion {
  id: string
  title: string
  description: string
  icon: React.ReactNode
  action: string
  category: "code" | "debug" | "improve" | "search"
}

interface AiChatModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSendMessage?: (message: string) => Promise<string>
  suggestions?: Suggestion[]
  title?: string
  description?: string
}

const defaultSuggestions: Suggestion[] = [
  {
    id: "1",
    title: "Generate Code",
    description: "Create boilerplate code for your components",
    icon: <Code className="h-4 w-4" />,
    action: "generate",
    category: "code",
  },
  {
    id: "2",
    title: "Debug Issue",
    description: "Help debug errors in your application",
    icon: <Bug className="h-4 w-4" />,
    action: "debug",
    category: "debug",
  },
  {
    id: "3",
    title: "Improve Performance",
    description: "Get suggestions to optimize your code",
    icon: <Lightbulb className="h-4 w-4" />,
    action: "improve",
    category: "improve",
  },
  {
    id: "4",
    title: "Search Documentation",
    description: "Find relevant documentation and examples",
    icon: <FileSearch className="h-4 w-4" />,
    action: "search",
    category: "search",
  },
]

export function AiChatModal({
  open,
  onOpenChange,
  onSendMessage,
  suggestions = defaultSuggestions,
  title = "AI Assistant",
  description = "How can I help you today?",
}: AiChatModalProps) {
  const [messages, setMessages] = React.useState<Message[]>([])
  const [input, setInput] = React.useState("")
  const [isLoading, setIsLoading] = React.useState(false)
  const [showSuggestions, setShowSuggestions] = React.useState(true)
  const scrollAreaRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (open) {
      inputRef.current?.focus()
    }
  }, [open])

  React.useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight
    }
  }, [messages])

  const handleSendMessage = async (content: string) => {
    if (!content.trim()) return

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content,
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMessage])
    setInput("")
    setIsLoading(true)
    setShowSuggestions(false)

    try {
      const response = onSendMessage 
        ? await onSendMessage(content)
        : "I'm here to help! This is a demo response. Connect me to an AI service to get real assistance."

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
        content: "Sorry, I encountered an error. Please try again.",
        timestamp: new Date(),
      }
      setMessages((prev) => [...prev, errorMessage])
    } finally {
      setIsLoading(false)
    }
  }

  const handleSuggestionClick = (suggestion: Suggestion) => {
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[400px] sm:w-[540px] p-0 flex flex-col">
        <SheetHeader className="px-6 py-4 border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              <SheetTitle>{title}</SheetTitle>
            </div>
          </div>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        <ScrollArea 
          ref={scrollAreaRef} 
          className="flex-1 px-6 py-4"
        >
          {showSuggestions && messages.length === 0 && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground mb-4">
                Quick suggestions to get started:
              </div>
              <div className="grid gap-3">
                {suggestions.map((suggestion) => (
                  <Card
                    key={suggestion.id}
                    className="cursor-pointer transition-all hover:shadow-md hover:border-primary/50"
                    onClick={() => handleSuggestionClick(suggestion)}
                  >
                    <CardHeader className="pb-3">
                      <div className="flex items-start gap-3">
                        <div className={cn(
                          "p-2 rounded-lg",
                          suggestion.category === "code" && "bg-blue-500/10 text-blue-500",
                          suggestion.category === "debug" && "bg-red-500/10 text-red-500",
                          suggestion.category === "improve" && "bg-purple-500/10 text-purple-500",
                          suggestion.category === "search" && "bg-green-500/10 text-green-500"
                        )}>
                          {suggestion.icon}
                        </div>
                        <div className="flex-1">
                          <CardTitle className="text-sm font-medium">
                            {suggestion.title}
                          </CardTitle>
                          <CardDescription className="text-xs mt-1">
                            {suggestion.description}
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                  </Card>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "flex gap-3",
                  message.role === "user" && "justify-end"
                )}
              >
                {message.role === "assistant" && (
                  <Avatar className="h-8 w-8">
                    <AvatarFallback>
                      <Bot className="h-4 w-4" />
                    </AvatarFallback>
                  </Avatar>
                )}
                <div
                  className={cn(
                    "rounded-lg px-3 py-2 max-w-[80%]",
                    message.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted"
                  )}
                >
                  <p className="text-sm">{message.content}</p>
                  <p className="text-xs opacity-70 mt-1">
                    {message.timestamp.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                {message.role === "user" && (
                  <Avatar className="h-8 w-8">
                    <AvatarFallback>
                      <User className="h-4 w-4" />
                    </AvatarFallback>
                  </Avatar>
                )}
              </div>
            ))}
            {isLoading && (
              <div className="flex gap-3">
                <Avatar className="h-8 w-8">
                  <AvatarFallback>
                    <Bot className="h-4 w-4" />
                  </AvatarFallback>
                </Avatar>
                <div className="bg-muted rounded-lg px-3 py-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="p-4">
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your message..."
              disabled={isLoading}
              className="flex-1"
            />
            <Button
              onClick={() => handleSendMessage(input)}
              disabled={isLoading || !input.trim()}
              size="icon"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}