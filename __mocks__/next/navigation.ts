import mockRouter from "next-router-mock";

export * from "next-router-mock";

export function useRouter() {
  return mockRouter;
}

export function useSearchParams() {
  const url = new URL(mockRouter.asPath || "/", "http://localhost");
  return new URLSearchParams(url.search);
}

export function usePathname() {
  const url = new URL(mockRouter.asPath || "/", "http://localhost");
  return url.pathname;
}

export function redirect(url: string) {
  throw new Error(`next/navigation redirect(${url}) not implemented in tests`);
}

export function permanentRedirect(url: string) {
  throw new Error(
    `next/navigation permanentRedirect(${url}) not implemented in tests`,
  );
}
