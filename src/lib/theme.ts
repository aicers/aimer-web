export const THEMES = ["gray-light", "gray-dark"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "gray-light";
export const themeConfig = {
  attribute: "data-theme",
  defaultTheme: DEFAULT_THEME,
  themes: THEMES as unknown as string[],
  enableSystem: true,
  disableTransitionOnChange: true,
} as const;
