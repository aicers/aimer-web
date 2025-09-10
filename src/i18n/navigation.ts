import { createSharedPathnamesNavigation } from "next-intl/navigation";

export const locales = ["en", "ko"] as const;

export const { Link, usePathname, useRouter } = createSharedPathnamesNavigation(
  { locales },
);
