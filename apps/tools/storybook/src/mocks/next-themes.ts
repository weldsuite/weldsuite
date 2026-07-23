export function useTheme() {
  return { theme: "light", setTheme: () => {}, resolvedTheme: "light" };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return children;
}
