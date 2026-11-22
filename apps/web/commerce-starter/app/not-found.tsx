import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex max-w-xl flex-col items-start gap-4">
      <h1 className="text-3xl font-semibold">We can&apos;t find that page</h1>
      <p>The product or page may have moved, or isn&apos;t for sale any more.</p>
      <Link href="/products" className="btn btn-primary">
        Browse products
      </Link>
    </div>
  );
}
