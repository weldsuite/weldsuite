"use client";

interface FooterEmailBlockProps {
  email?: string;
  alignment?: 'left' | 'center' | 'right';
}

const FooterEmailBlock = ({
  email = "example@shadcnblocks.com",
  alignment = "right",
}: FooterEmailBlockProps) => {
  return (
    <div
      className="text-muted-foreground text-sm ml-auto"
      style={{ textAlign: alignment }}
    >
      {email}
    </div>
  );
};

export { FooterEmailBlock };
