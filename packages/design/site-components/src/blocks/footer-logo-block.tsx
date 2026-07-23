"use client";

interface FooterLogoBlockProps {
  text?: string;
  maxHeight?: string;
  clipBottom?: boolean;
  fontSize?: string;
  fontWeight?: string;
  alignment?: 'left' | 'center' | 'right';
}

const FooterLogoBlock = ({
  text = "Shadcnblocks.com",
  maxHeight = "160px",
  clipBottom = true,
  fontSize = "12rem",
  fontWeight = "900",
  alignment = "left",
}: FooterLogoBlockProps) => {
  return (
    <div className="w-full">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div
          className={clipBottom ? "overflow-hidden" : ""}
          style={{ maxHeight: clipBottom ? maxHeight : undefined }}
        >
          <div
            className="font-bold tracking-tighter leading-none"
            style={{
              fontSize,
              fontWeight,
              textAlign: alignment,
            }}
          >
            {text}
          </div>
        </div>
      </div>
    </div>
  );
};

export { FooterLogoBlock };
