"use client";

interface TextSectionProps {
  title?: string;
  content?: string;
  align?: 'left' | 'center' | 'right';
  store?: any;
  settings?: any;
}

export default function TextSection({
  title,
  content = "Add your text content here",
  align = 'center',
  store,
  settings
}: TextSectionProps) {
  const textAlign = align === 'left' ? 'text-left' : align === 'right' ? 'text-right' : 'text-center';
  
  return (
    <section className="py-12 px-4">
      <div className={`container mx-auto max-w-4xl ${textAlign}`}>
        {title && (
          <h2 className="text-3xl font-bold mb-6">{title}</h2>
        )}
        <div 
          className="prose prose-lg max-w-none"
          dangerouslySetInnerHTML={{ __html: content }}
        />
      </div>
    </section>
  );
}