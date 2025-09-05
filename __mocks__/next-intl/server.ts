// Mock next-intl/server for testing
export const getTranslations = async () => {
  const messages: Record<string, string> = {
    "common.welcome": "Welcome to Aimer Web",
    "common.loading": "Loading…",
    "common.signingIn": "Signing in...",
    "common.signIn": "Sign In",
    "home.userSignIn": "User Sign In",
    "home.adminSignIn": "Admin Sign In",
    "user.title": "User App",
    "user.welcome": "Welcome to the user area.",
    "admin.title": "Admin App",
    "admin.welcome": "Welcome to the admin area.",
  };

  return (key: string, params?: Record<string, unknown>) => {
    if (key === "signin.title") {
      return (params as { mode?: string })?.mode === "admin"
        ? "Admin Sign In"
        : "User Sign In";
    }
    if (key === "signin.passwordMinLength") {
      return `Password must be at least ${(params as { minLength?: number })?.minLength || 3} characters`;
    }
    return messages[key] || key;
  };
};
