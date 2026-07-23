'use client'

import { ChevronLeft, ChevronRight, Heart, ArrowRight } from 'lucide-react'
import { useState, useRef } from 'react'
import { cn } from '../lib/utils'

interface Product {
  id: string
  name: string
  brand?: string
  image: string
  price?: number
}

interface ProductRowProps {
  title: string
  brand?: string
  products: Product[]
  className?: string
  onViewAll?: () => void
}

export function ProductRow({ 
  title, 
  brand, 
  products, 
  className,
  onViewAll 
}: ProductRowProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [favorites, setFavorites] = useState<Set<string>>(new Set())
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(true)

  const checkScrollPosition = () => {
    if (!scrollContainerRef.current) return
    const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current
    setCanScrollLeft(scrollLeft > 0)
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 10)
  }

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollContainerRef.current) return
    const itemWidth = 232 // width of one product card including gap
    const scrollAmount = itemWidth * 5 // scroll by 5 items
    scrollContainerRef.current.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth'
    })
    setTimeout(checkScrollPosition, 300)
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
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <button 
          onClick={onViewAll}
          className="flex items-center gap-2 group hover:opacity-70 transition-opacity"
        >
          <h2 className="text-lg font-normal">
            {title} {brand && <span className="font-medium">{brand}</span>}
          </h2>
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>

      <div className="relative">
        {/* Navigation Arrows */}
        {canScrollLeft && (
          <button
            onClick={() => scroll('left')}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 p-2 bg-white/90 backdrop-blur-sm rounded-full shadow-lg hover:bg-white transition-all -translate-x-5"
            aria-label="Previous products"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        
        {canScrollRight && (
          <button
            onClick={() => scroll('right')}
            className="absolute right-0 top-1/2 -translate-y-1/2 z-10 p-2 bg-white/90 backdrop-blur-sm rounded-full shadow-lg hover:bg-white transition-all translate-x-5"
            aria-label="Next products"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        )}

        {/* Products Container */}
        <div 
          ref={scrollContainerRef}
          onScroll={checkScrollPosition}
          className="flex gap-3 overflow-x-auto scrollbar-hide"
          style={{ 
            scrollbarWidth: 'none', 
            msOverflowStyle: 'none',
            WebkitOverflowScrolling: 'touch'
          }}
        >
          {products.map((product) => (
            <div
              key={product.id}
              className="flex-none"
              style={{ width: '220px' }}
            >
              <div className="relative group">
                {/* Product Image Container */}
                <div className="relative aspect-[3/4] rounded-2xl overflow-hidden bg-gray-100">
                  <img
                    src={product.image}
                    alt={product.name}
                    className="w-full h-full object-cover"
                  />
                  
                  {/* Favorite Button */}
                  <button
                    onClick={() => toggleFavorite(product.id)}
                    className={cn(
                      "absolute bottom-3 right-3 p-2.5 rounded-full transition-all",
                      "bg-white/80 backdrop-blur-sm hover:bg-white shadow-sm",
                      favorites.has(product.id) && "bg-white"
                    )}
                    aria-label={`Add ${product.name} to favorites`}
                  >
                    <Heart 
                      className={cn(
                        "h-4 w-4 transition-colors",
                        favorites.has(product.id) 
                          ? "fill-red-500 text-red-500" 
                          : "text-gray-700"
                      )}
                    />
                  </button>
                </div>

                {/* Product Info - Optional */}
                {(product.name || product.price) && (
                  <div className="mt-3 space-y-1">
                    {product.name && (
                      <p className="text-sm text-gray-900 line-clamp-1">
                        {product.name}
                      </p>
                    )}
                    {product.price && (
                      <p className="text-sm font-medium text-gray-900">
                        ${product.price.toFixed(2)}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <style jsx>{`
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
  )
}