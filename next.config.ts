import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Enables `forbidden()` / `unauthorized()` from `next/navigation` so a
    // permission- or bridge-denied read surface returns a real 403 status
    // (not a 200 page that merely looks like a 403). Required by the RFC
    // 0002 read-surface denial contract (#297 review round 4, item 1).
    authInterrupts: true,
  },
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
