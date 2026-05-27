// Format guardrail for `schemas/mitre-attack.version`. Parallel to the
// `schemas/aimer.version` block in
// `src/lib/graphql/__tests__/contract.unit.test.ts`, but the regex
// **differs**: MITRE's actual Git tags carry a two-component
// `vMAJOR.MINOR` shape (`v19.1`, `v19.0`, `v18.1`, ...). The aimer
// regex would reject those, so an independent regex lives here. The
// divergence is documented in `docs/SCHEMAS.md` under "MITRE ATT&CK
// data".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const VERSION_PATH = join(process.cwd(), "schemas/mitre-attack.version");

// Tag branch accepts optional `v` prefix and an optional patch
// component. SHA branch is unchanged from the aimer pin policy.
const MITRE_VERSION_RE = /^v?\d+\.\d+(\.\d+)?$|^[0-9a-f]{7,40}$/;

describe("schemas/mitre-attack.version", () => {
  it("matches the MITRE-specific tag or commit-SHA shape", () => {
    const raw = readFileSync(VERSION_PATH, "utf-8");
    const trimmed = raw.trim();
    expect(
      MITRE_VERSION_RE.test(trimmed),
      `mitre-attack.version value ${JSON.stringify(trimmed)} does not match ${MITRE_VERSION_RE}`,
    ).toBe(true);
  });

  it("contains a single non-empty line", () => {
    const raw = readFileSync(VERSION_PATH, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it("regex sanity — accepts MITRE-style two-component tags and SHAs", () => {
    // MITRE's actual published tags (v19.1, 19.1) and the
    // unlikely-but-possible three-component (`v19.1.0`) form.
    expect(MITRE_VERSION_RE.test("v19.1")).toBe(true);
    expect(MITRE_VERSION_RE.test("19.1")).toBe(true);
    expect(MITRE_VERSION_RE.test("0.2.0")).toBe(true);
    expect(MITRE_VERSION_RE.test("v19.1.0")).toBe(true);
    // SHAs match the aimer policy (7-40 hex, lowercase).
    expect(MITRE_VERSION_RE.test("6c37199")).toBe(true);
    expect(MITRE_VERSION_RE.test("6c3719993d0401de199203ecc3f369544d9e091c")).toBe(
      true,
    );

    // Single-component is not a real MITRE tag.
    expect(MITRE_VERSION_RE.test("v19")).toBe(false);
    expect(MITRE_VERSION_RE.test("main")).toBe(false);
    expect(MITRE_VERSION_RE.test("")).toBe(false);
    // Below 7-char SHA minimum.
    expect(MITRE_VERSION_RE.test("6c3719")).toBe(false);
    // Above 40-char SHA maximum.
    expect(
      MITRE_VERSION_RE.test("6c3719993d0401de199203ecc3f369544d9e091cf"),
    ).toBe(false);
  });
});
