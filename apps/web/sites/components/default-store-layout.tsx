"use client";

import { Button } from "@weldsuite/ui/components/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@weldsuite/ui/components/card";
import { Badge } from "@weldsuite/ui/components/badge";
import Image from "next/image";

interface DefaultStoreLayoutProps {
  store: {
    id: string;
    name: string;
    slug: string;
    description?: string;
    logo?: string;
    products: Array<{
      id: string;
      name: string;
      description?: string;
      price: number;
      compareAtPrice?: number;
      image?: string;
      category?: { id: string; name: string } | null;
    }>;
  } | null;
}

export default function DefaultStoreLayout({ store }: DefaultStoreLayoutProps) {
  if (!store) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Store not found</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              {store.logo && (
                <Image
                  src={store.logo}
                  alt={store.name}
                  width={40}
                  height={40}
                  className="rounded"
                />
              )}
              <h1 className="text-2xl font-bold">{store.name}</h1>
            </div>
            <nav className="flex gap-6">
              <a href="#products" className="hover:opacity-80">Products</a>
              <a href="#about" className="hover:opacity-80">About</a>
              <a href="#contact" className="hover:opacity-80">Contact</a>
            </nav>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-12">
        {store.description && (
          <section className="mb-12 text-center">
            <p className="text-lg opacity-80 max-w-2xl mx-auto">
              {store.description}
            </p>
          </section>
        )}

        <section id="products" className="mb-12">
          <h2 className="text-3xl font-bold mb-8 text-center">Our Products</h2>
          
          {store.products.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {store.products.map((product) => (
                <Card key={product.id} className="overflow-hidden">
                  {product.image && (
                    <div className="aspect-square relative">
                      <Image
                        src={product.image}
                        alt={product.name}
                        fill
                        className="object-cover"
                      />
                    </div>
                  )}
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      {product.name}
                      {product.category && (
                        <Badge variant="secondary">
                          {product.category.name}
                        </Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm opacity-70 mb-4">
                      {product.description}
                    </p>
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-2xl font-bold">
                          ${product.price.toString()}
                        </span>
                        {product.compareAtPrice && (
                          <span className="text-sm opacity-60 line-through ml-2">
                            ${product.compareAtPrice.toString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </CardContent>
                  <CardFooter>
                    <Button className="w-full">
                      Add to Cart
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-lg opacity-60">No products available yet.</p>
            </div>
          )}
        </section>

        <section id="about" className="mb-12 text-center">
          <h2 className="text-3xl font-bold mb-8">About Us</h2>
          <div className="max-w-2xl mx-auto">
            <p className="opacity-80">
              Welcome to {store.name}. We are dedicated to providing quality products and excellent service.
            </p>
          </div>
        </section>

      </main>

      <footer className="border-t">
        <div className="container mx-auto px-6 py-8 text-center">
          <p className="opacity-60">
            © {new Date().getFullYear()} {store.name}. All rights reserved.
          </p>
          <p className="text-sm opacity-40 mt-2">
            Powered by WeldSuite
          </p>
        </div>
      </footer>
    </div>
  );
}