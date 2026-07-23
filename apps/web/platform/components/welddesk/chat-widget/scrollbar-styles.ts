export const subtleScrollbarStyles = {
  scrollbarWidth: 'thin' as const,
  scrollbarColor: 'rgba(156, 163, 175, 0.2) transparent',
  WebkitScrollbarWidth: '4px'
};

export const subtleScrollbarCSS = `
  .subtle-scrollbar::-webkit-scrollbar {
    width: 4px;
    height: 4px;
  }
  .subtle-scrollbar::-webkit-scrollbar-track {
    background: transparent;
  }
  .subtle-scrollbar::-webkit-scrollbar-thumb {
    background-color: rgba(156, 163, 175, 0.2);
    border-radius: 2px;
  }
  .subtle-scrollbar::-webkit-scrollbar-thumb:hover {
    background-color: rgba(156, 163, 175, 0.4);
  }
`;