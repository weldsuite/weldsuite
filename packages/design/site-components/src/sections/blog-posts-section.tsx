"use client";

import React from 'react';
import { Calendar, User } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';

interface BlogPost {
  id: number;
  title: string;
  excerpt: string;
  image: string;
  author: string;
  date: string;
  category: string;
  link: string;
}

interface BlogPostsSectionProps {
  heading?: string;
  subheading?: string;
  postsToShow?: number;
  columns?: number;
  showExcerpt?: boolean;
  showDate?: boolean;
  showAuthor?: boolean;
  backgroundColor?: string;
  textColor?: string;
  paddingTop?: number;
  paddingBottom?: number;
  sectionId?: string;
  store?: any;
  posts?: BlogPost[];
}

// Mock blog posts
const mockPosts: BlogPost[] = [
  {
    id: 1,
    title: '5 Ways to Style Your Summer Wardrobe',
    excerpt: 'Discover fresh styling tips to elevate your summer look with versatile pieces from our new collection.',
    image: 'https://images.unsplash.com/photo-1490481651871-ab68de25d43d?w=800&h=600&fit=crop',
    author: 'Emma Wilson',
    date: 'June 15, 2024',
    category: 'Style Tips',
    link: '/blog/summer-wardrobe-styling'
  },
  {
    id: 2,
    title: 'Behind the Scenes: Our Manufacturing',
    excerpt: 'Take a look at how we create quality products while maintaining our commitment to sustainability.',
    image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=800&h=600&fit=crop',
    author: 'James Miller',
    date: 'June 10, 2024',
    category: 'Sustainability',
    link: '/blog/sustainable-manufacturing'
  },
  {
    id: 3,
    title: 'Fall Collection Preview: What to Expect',
    excerpt: 'Get an exclusive first look at our upcoming fall collection featuring cozy textures and rich colors.',
    image: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&h=600&fit=crop',
    author: 'Sophia Chen',
    date: 'June 5, 2024',
    category: 'New Arrivals',
    link: '/blog/fall-collection-preview'
  },
];

export function BlogPostsSection({
  heading = 'From the Blog',
  subheading = 'Latest stories and updates',
  postsToShow = 3,
  columns = 3,
  showExcerpt = true,
  showDate = true,
  showAuthor = true,
  backgroundColor = '#ffffff',
  textColor = '#000000',
  paddingTop = 80,
  paddingBottom = 80,
  sectionId,
  store,
  posts,
}: BlogPostsSectionProps) {
  // Use real posts if available, otherwise fall back to mock data
  const sourcePosts = posts && posts.length > 0 ? posts :
                      (store?.blogPosts && store.blogPosts.length > 0 ? store.blogPosts : mockPosts);

  const displayPosts = sourcePosts.slice(0, postsToShow);

  return (
    <section
      className="px-4 md:px-8"
      style={{
        backgroundColor,
        paddingTop: `${paddingTop}px`,
        paddingBottom: `${paddingBottom}px`
      }}
    >
      <div className="container mx-auto" style={{ maxWidth: '1400px' }}>
        {/* Header */}
        <div className="text-center mb-12">
          <h2
            className="text-4xl font-bold tracking-tight"
            style={{
              color: textColor
            }}
          >
            {heading}
          </h2>
        </div>

        {/* Blog Posts Grid */}
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `repeat(${Math.min(columns, 3)}, minmax(0, 1fr))`
          }}
        >
          {displayPosts.map((post: any, index: number) => {
            return (
              <article
                key={post.id}
                className="group"
              >
                <a href={post.link} className="block">
                  {/* Post Image */}
                  <div className="aspect-[4/3] overflow-hidden rounded-lg bg-gray-100 mb-6">
                    <img
                      src={post.image}
                      alt={post.title}
                      className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                    />
                  </div>

                  {/* Post Meta */}
                  <div className="flex items-center gap-4 mb-3 text-sm" style={{ color: textColor, opacity: 0.6 }}>
                    {showDate && (
                      <div className="flex items-center gap-1">
                        <Calendar className="w-4 h-4" />
                        <span>{post.date}</span>
                      </div>
                    )}
                    {showAuthor && (
                      <div className="flex items-center gap-1">
                        <User className="w-4 h-4" />
                        <span>{post.author}</span>
                      </div>
                    )}
                  </div>

                  {/* Post Title */}
                  <h3
                    className="text-2xl font-bold mb-3 group-hover:underline"
                    style={{
                      color: textColor
                    }}
                  >
                    {post.title}
                  </h3>

                  {/* Post Excerpt */}
                  {showExcerpt && (
                    <p
                      className="line-clamp-3"
                      style={{
                        color: textColor,
                        opacity: 0.7
                      }}
                    >
                      {post.excerpt}
                    </p>
                  )}

                  {/* Read More */}
                  <div className="mt-4">
                    <span
                      className="text-sm font-medium underline underline-offset-4 group-hover:no-underline"
                      style={{ color: textColor }}
                    >
                      Read more
                    </span>
                  </div>
                </a>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
