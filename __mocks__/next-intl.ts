// Mock next-intl for testing
export const useTranslations = () => {
  return (key: string, params?: Record<string, unknown>) => {
    // Simple key-to-text mapping for tests
    const messages: Record<string, string> = {
      "common.welcome": "Welcome to Aimer Web",
      "common.loading": "Loading…",
      "common.signingIn": "Signing in...",
      "common.signIn": "Sign In",
      "home.userSignIn": "User Sign In",
      "home.adminSignIn": "Admin Sign In",
      "signin.title":
        params?.mode === "admin" ? "Admin Sign In" : "User Sign In",
      "signin.idPlaceholder": "ID",
      "signin.passwordPlaceholder": "Password",
      "signin.idRequired": "ID is required",
      "signin.passwordMinLength": `Password must be at least ${(params as { minLength?: number })?.minLength || 3} characters`,
      "user.title": "User App",
      "user.welcome": "Welcome to the user area.",
      "admin.title": "Admin App",
      "admin.welcome": "Welcome to the admin area.",
      "language.english": "English",
      "language.korean": "한국어",
      "language.switchLanguage": "Switch Language",
    };
    return messages[key] || key;
  };
};

export const useLocale = () => "en";

export const getTranslations = async () => useTranslations();
