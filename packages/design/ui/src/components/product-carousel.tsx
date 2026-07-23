'use client'

import { ChevronLeft, ChevronRight, Heart } from 'lucide-react'
import { useState, useRef } from 'react'
import { cn } from '../lib/utils'

interface Product {
  id: string
  name: string
  brand: string
  image: string
  price?: number
}

interface ProductCarouselProps {
  title: string
  products: Product[]
  className?: string
}

export function ProductCarousel({ title, products, className }: ProductCarouselProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [favorites, setFavorites] = useState<Set<string>>(new Set())

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollContainerRef.current) return
    const scrollAmount = 300
    scrollContainerRef.current.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth'
    })
  }

  const toggleFavorite = (productId: string) => {
    setFavorites(prev => {
      const newFavorites = new Set(prev)
      if (newFavorites.has(productId)) {
        newFavorites.delete(productId)
      } else {
        newFavorites.add(productId)
      }
      return newFavorites
    })
  }

  return (
    <div className={cn("relative w-full", className)}>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-medium">{title}</h2>
        <div className="flex gap-2">
          <button
            onClick={() => scroll('left')}
            className="p-2 rounded-full hover:bg-gray-100 transition-colors"
            aria-label="Previous products"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            onClick={() => scroll('right')}
            className="p-2 rounded-full hover:bg-gray-100 transition-colors"
            aria-label="Next products"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div 
        ref={scrollContainerRef}
        className="flex gap-4 overflow-x-auto scrollbar-hide scroll-smooth"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {products.map((product) => (
          <div
            key={product.id}
            className="flex-none w-[200px] group"
          >
            <div className="relative">
              <div className="aspect-square rounded-2xl bg-gray-100 overflow-hidden mb-3">
                <img
                  src={product.image}
                  alt={product.name}
                  className="w-full h-full object-cover"
                />
              </div>
              <button
                onClick={() => toggleFavorite(product.id)}
                className="absolute top-3 right-3 p-2 rounded-full bg-white/90 backdrop-blur-sm hover:bg-white transition-colors shadow-sm"
                aria-label={`Add ${product.name} to favorites`}
              >
                <Heart 
                  className={cn(
                    "h-4 w-4 transition-colors",
                    favorites.has(product.id) 
                      ? "fill-red-500 text-red-500" 
                      : "text-gray-600"
                  )}
                />
              </button>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-gray-900 line-clamp-1">
                {product.name}
              </p>
              {product.price && (
                <p className="text-sm text-gray-600">
                  ${product.price.toFixed(2)}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}