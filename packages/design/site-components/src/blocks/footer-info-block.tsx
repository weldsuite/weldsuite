"use client";

import React from "react";

interface FooterInfoBlockProps {
  children?: React.ReactNode;
}

const FooterInfoBlock = ({
  children,
}: FooterInfoBlockProps) => {
  return (
    <div className="w-full">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-muted-foreground flex flex-col items-center justify-between py-12 md:flex-row">
          {children}
        </div>
      </div>
    </div>
  );
};

export { FooterInfoBlock };
