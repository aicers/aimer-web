// Server-side loader for the customer hub page
// (`/[locale]/subjects/{customerId}`) — WS3 (#392).
//
// The hub is the entry point that gives every customer-scoped leaf a
// navigable home: it links to that customer's reports, threat stories, and
// suspicious events. Before this page existed those leaves were reachable
// only by knowing the ID (orphan URLs).
//
// Permission policy:
//   - reports section          → `reports:read`
//   - threat-stories section   → `analyses:read`
//   - suspicious-events section → `analyses:read`
// Each section renders only when its permission is present (partial
// permission shows the permitted subset). The hub itself 404s only when the
// caller is not a member of the customer at all; an in-scope bridge session
// is a 403 (these surfaces are not readable under a bridge).

import "server-only";

import { resolveCustomerReadAccess } from "./customer-read-access";

export interface CustomerHubSections {
  reports: boolean;
  threatStories: boolean;
  suspiciousEvents: boolean;
}

export type CustomerHubPageOutcome =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "ok"; sections: CustomerHubSections };

export interface CustomerHubPageInput {
  customerId: string;
}

export async function loadCustomerHubPage(
  input: CustomerHubPageInput,
): Promise<CustomerHubPageOutcome> {
  const access = await resolveCustomerReadAccess(input.customerId);
  if (access.kind === "unauthorized") return { kind: "unauthorized" };
  if (access.kind === "forbidden") return { kind: "forbidden" };

  const analyses = access.permissions.has("analyses:read");
  return {
    kind: "ok",
    sections: {
      reports: access.permissions.has("reports:read"),
      threatStories: analyses,
      suspiciousEvents: analyses,
    },
  };
}
