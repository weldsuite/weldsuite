"use client";

interface FooterCopyrightTextBlockProps {
  text?: string;
  alignment?: 'left' | 'center' | 'right';
}

const FooterCopyrightTextBlock = ({
  text = "© Shadcnblocks.com 2024",
  alignment = "left",
}: FooterCopyrightTextBlockProps) => {
  return (
    <div
      className="text-muted-foreground text-sm"
      style={{ textAlign: alignment }}
    >
      {text}
    </div>
  );
};

export { FooterCopyrightTextBlock };
