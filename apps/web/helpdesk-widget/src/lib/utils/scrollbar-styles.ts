export const subtleScrollbarStyles = {
  scrollbarWidth: 'none' as const,
};

export const subtleScrollbarCSS = `
  .subtle-scrollbar::-webkit-scrollbar {
    width: 4px;
    background: none !important;
    background-color: transparent !important;
  }
  .subtle-scrollbar::-webkit-scrollbar-track {
    background: none !important;
    background-color: transparent !important;
  }
  .subtle-scrollbar::-webkit-scrollbar-track-piece {
    background: none !important;
    background-color: transparent !important;
  }
  .subtle-scrollbar::-webkit-scrollbar-thumb {
    background-color: rgba(156, 163, 175, 0.25);
    border-radius: 2px;
  }
  .subtle-scrollbar::-webkit-scrollbar-thumb:hover {
    background-color: rgba(156, 163, 175, 0.4);
  }
  .subtle-scrollbar::-webkit-scrollbar-corner {
    background: none !important;
    background-color: transparent !important;
  }
  .subtle-scrollbar::-webkit-scrollbar-button {
    display: none;
  }
`;
