import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

export function formatDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d)
}

export function formatDateTime(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d)
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat("en-US").format(num)
}

export function calculateDaysOverdue(dueDate: Date | string): number {
  const due = typeof dueDate === "string" ? new Date(dueDate) : dueDate
  const today = new Date()
  const diff = today.getTime() - due.getTime()
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)))
}

export function getAccountTypeColor(type: string): string {
  const colors: Record<string, string> = {
    ASSET: "bg-blue-100 text-blue-800",
    LIABILITY: "bg-yellow-100 text-yellow-800",
    EQUITY: "bg-purple-100 text-purple-800",
    REVENUE: "bg-green-100 text-green-800",
    EXPENSE: "bg-red-100 text-red-800",
  }
  return colors[type] || "bg-gray-100 text-gray-800"
}

export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    DRAFT: "bg-gray-100 text-gray-800",
    PENDING: "bg-yellow-100 text-yellow-800",
    APPROVED: "bg-blue-100 text-blue-800",
    POSTED: "bg-green-100 text-green-800",
    VOID: "bg-red-100 text-red-800",
    PAID: "bg-green-100 text-green-800",
    OVERDUE: "bg-red-100 text-red-800",
    CANCELLED: "bg-gray-100 text-gray-800",
  }
  return colors[status] || "bg-gray-100 text-gray-800"
}