import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

export default createMiddleware(routing);

export const config = {
  // Skip all paths that aren't pages that require i18n
  matcher: ["/", "/((?!api|_next|.*\\..*).*)"],
};
