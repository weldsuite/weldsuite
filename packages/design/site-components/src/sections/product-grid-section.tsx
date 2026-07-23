"use client";

import { Product, Category } from "@weldsuite/database";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@weldsuite/ui/components/card";
import { Button } from "@weldsuite/ui/components/button";
import { Badge } from "@weldsuite/ui/components/badge";
import Image from "next/image";

interface ProductGridSectionProps {
  title?: string;
  limit?: number;
  store?: any;
  settings?: any;
}

export default function ProductGridSection({ 
  title = "Featured Products",
  limit = 6,
  store,
  settings
}: ProductGridSectionProps) {
  const products = store?.products || [];
  const displayProducts = products.slice(0, limit);

  if (displayProducts.length === 0) {
    return (
      <section className="py-16 px-4 md:px-8">
        <div className="container mx-auto" style={{ maxWidth: '1280px' }}>
          <h2 className="text-3xl font-bold text-center mb-12">{title}</h2>
          <p className="text-center text-muted-foreground">No products available</p>
        </div>
      </section>
    );
  }

  return (
    <section className="py-16 px-4 md:px-8">
      <div className="container mx-auto" style={{ maxWidth: '1280px' }}>
        <h2 className="text-3xl font-bold text-center mb-12">{title}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {displayProducts.map((product: Product & { category: Category | null }) => (
            <Card key={product.id} className="overflow-hidden">
              {product.imageUrl && (
                <div className="aspect-square relative">
                  <Image
                    src={product.imageUrl}
                    alt={product.name}
                    fill
                    className="object-cover"
                  />
                </div>
              )}
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span className="truncate">{product.name}</span>
                  {product.category && (
                    <Badge variant="secondary" className="ml-2">
                      {product.category.name}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {product.description && (
                  <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
                    {product.description}
                  </p>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-2xl font-bold">
                    ${product.price.toString()}
                  </span>
                  {product.stock > 0 && (
                    <span className="text-sm text-muted-foreground">
                      {product.stock} in stock
                    </span>
                  )}
                </div>
              </CardContent>
              <CardFooter>
                <Button className="w-full">Add to Cart</Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}