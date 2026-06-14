// @vitest-environment jsdom
//
// RFC 0003 / RFC 0005 — IOC evidence section render (#591): the verdict
// banner's four render states and the feed-source citations across the three
// evidence classes. The translator is stubbed to echo keys so assertions key
// off the i18n key, not the rendered copy.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IocEnrichment,
  IocEvidenceItem,
} from "@/lib/analysis/ioc-evidence";
import { IocEvidenceSection } from "../ioc-evidence-section";

// `<Timestamp>` reads the active locale via next-intl; stub it so the section
// renders outside a provider.
vi.mock("@/components/timestamp", () => ({
  Timestamp: ({ at }: { at: Date }) => <span>{at.toISOString()}</span>,
}));

const translate = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;
// biome-ignore lint/suspicious/noExplicitAny: test translator stub
const t = translate as any;

afterEach(cleanup);

function item(extras: Partial<IocEvidenceItem> = {}): IocEvidenceItem {
  return {
    indicator: "203.0.113.7",
    indicatorRedacted: false,
    sourceAiceId: "aice-a",
    memberEventKey: "10",
    sourceLabel: "abuse.ch Feodo Tracker",
    sourcePolicyId: "abuse.ch/feodo",
    hitType: "deterministic_ioc",
    floorEligible: true,
    evidenceClass: "floor_supporting",
    coverageStatus: "complete",
    sourceVersion: "2026-06-01",
    feedHash: "deadbeef",
    checkedAt: new Date("2026-06-10T00:00:00Z"),
    ...extras,
  };
}

describe("IocEvidenceSection — verdict banner", () => {
  it.each([
    [{ verdict: null, evidence: [] }, "not_run", "ioc.notRunBadge"],
    [
      {
        verdict: { knownIocHit: true, coverageStatus: "complete" },
        evidence: [],
      },
      "hit",
      "ioc.hitBadge",
    ],
    [
      {
        verdict: { knownIocHit: false, coverageStatus: "complete" },
        evidence: [],
      },
      "clean_complete",
      "ioc.cleanCompleteBadge",
    ],
    [
      {
        verdict: { knownIocHit: false, coverageStatus: "unknown" },
        evidence: [],
      },
      "clean_incomplete",
      "ioc.cleanIncompleteBadge",
    ],
  ] as Array<
    [IocEnrichment, string, string]
  >)("renders the %s state distinctly", (enrichment, state, badgeKey) => {
    const { getByTestId } = render(
      <IocEvidenceSection enrichment={enrichment} t={t} />,
    );
    const banner = getByTestId("ioc-verdict");
    expect(banner.getAttribute("data-ioc-state")).toBe(state);
    expect(banner.textContent).toContain(badgeKey);
  });

  it("renders no citations list when there is no evidence", () => {
    const { queryByTestId } = render(
      <IocEvidenceSection enrichment={{ verdict: null, evidence: [] }} t={t} />,
    );
    expect(queryByTestId("ioc-citations")).toBeNull();
  });
});

describe("IocEvidenceSection — feed-source citations", () => {
  it("renders all three evidence classes, floor-supporting first", () => {
    const enrichment: IocEnrichment = {
      verdict: { knownIocHit: true, coverageStatus: "complete" },
      evidence: [
        item({ evidenceClass: "promoted_soft", hitType: "soft_reputation" }),
        item({ evidenceClass: "floor_supporting" }),
        item({ evidenceClass: "floor_ineligible_deterministic" }),
      ],
    };
    const { getAllByTestId } = render(
      <IocEvidenceSection enrichment={enrichment} t={t} />,
    );
    const rows = getAllByTestId("ioc-evidence-row");
    expect(rows.map((r) => r.getAttribute("data-evidence-class"))).toEqual([
      "floor_supporting",
      "floor_ineligible_deterministic",
      "promoted_soft",
    ]);
  });

  it("shows provenance (source label, version, feed hash) on a citation", () => {
    const { getByTestId } = render(
      <IocEvidenceSection
        enrichment={{
          verdict: { knownIocHit: true, coverageStatus: "complete" },
          evidence: [item()],
        }}
        t={t}
      />,
    );
    const label = getByTestId("ioc-source-label").textContent ?? "";
    expect(label).toContain("abuse.ch Feodo Tracker");
    const row = getByTestId("ioc-evidence-row");
    expect(row.textContent).toContain("2026-06-01");
    expect(row.textContent).toContain("deadbeef");
  });

  it("shows a raw external indicator directly", () => {
    const { getByTestId } = render(
      <IocEvidenceSection
        enrichment={{
          verdict: { knownIocHit: true, coverageStatus: "complete" },
          evidence: [
            item({ indicator: "203.0.113.7", indicatorRedacted: false }),
          ],
        }}
        t={t}
      />,
    );
    const indicator = getByTestId("ioc-indicator");
    expect(indicator.textContent).toBe("203.0.113.7");
    expect(indicator.getAttribute("data-redacted")).toBeNull();
  });

  it("flags a token-only (undecryptable) indicator as redacted", () => {
    const { getByTestId } = render(
      <IocEvidenceSection
        enrichment={{
          verdict: { knownIocHit: true, coverageStatus: "complete" },
          evidence: [
            item({
              indicator: "<<REDACTED_IP_001>>",
              indicatorRedacted: true,
            }),
          ],
        }}
        t={t}
      />,
    );
    const indicator = getByTestId("ioc-indicator");
    expect(indicator.textContent).toBe("<<REDACTED_IP_001>>");
    expect(indicator.getAttribute("data-redacted")).toBe("true");
  });
});
