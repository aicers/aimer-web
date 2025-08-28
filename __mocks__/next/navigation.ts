import mockRouter from "next-router-mock";

export * from "next-router-mock";

export function useRouter() {
  return mockRouter;
}

export function useSearchParams() {
  const url = new URL(mockRouter.asPath || "/", "http://localhost");
  return new URLSearchParams(url.search);
}
