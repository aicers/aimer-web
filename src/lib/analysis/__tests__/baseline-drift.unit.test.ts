import { describe, expect, it } from "vitest";
import { computeBaselineDrift } from "../baseline-drift";

describe("computeBaselineDrift", () => {
  it("first-bucket bootstrap: no prior events ⇒ both signals 0.0", () => {
    const d = computeBaselineDrift(
      [
        { category: "malware", count: 10 },
        { category: null, count: 3 },
      ],
      [],
    );
    expect(d.severity).toBe(0);
    expect(d.likelihood).toBe(0);
  });

  it("no change ⇒ severity 0, likelihood 0", () => {
    const same = [
      { category: "malware", count: 10 },
      { category: "recon", count: 5 },
    ];
    const d = computeBaselineDrift(same, same);
    expect(d.severity).toBe(0);
    expect(d.likelihood).toBe(0);
  });

  it("severity = largest abs count delta / prior total, clamped", () => {
    // prior total = 50; malware jumps 10 → 30 (delta 20); recon steady.
    const d = computeBaselineDrift(
      [
        { category: "malware", count: 30 },
        { category: "recon", count: 40 },
      ],
      [
        { category: "malware", count: 10 },
        { category: "recon", count: 40 },
      ],
    );
    expect(d.severity).toBeCloseTo(20 / 50, 10);
    // malware fractional delta = 20/10 = 2.0 > 0.3 ⇒ likelihood 1.0
    expect(d.likelihood).toBe(1.0);
  });

  it("clamps severity to 1.0 when a category dwarfs the prior total", () => {
    const d = computeBaselineDrift(
      [{ category: "exfil", count: 100 }],
      [{ category: "recon", count: 5 }],
    );
    expect(d.severity).toBe(1);
    expect(d.likelihood).toBe(1.0);
  });

  it("likelihood stays 0 when every delta is within the noise threshold", () => {
    // prior total 100; malware 100 → 110 (10% < 30%).
    const d = computeBaselineDrift(
      [{ category: "malware", count: 110 }],
      [{ category: "malware", count: 100 }],
    );
    expect(d.likelihood).toBe(0);
    expect(d.severity).toBeCloseTo(10 / 100, 10);
  });

  it("treats an emerging category (prior 0) as material drift", () => {
    const d = computeBaselineDrift(
      [
        { category: "malware", count: 50 },
        { category: "exfil", count: 5 },
      ],
      [{ category: "malware", count: 50 }],
    );
    // exfil fractional delta = (5-0)/max(0,1) = 5 > 0.3.
    expect(d.likelihood).toBe(1.0);
    const exfil = d.categoryDeltas.find((c) => c.category === "exfil");
    expect(exfil?.delta).toBe(5);
  });

  it("aggregates the null-category bucket and sorts nulls last", () => {
    const d = computeBaselineDrift(
      [
        { category: null, count: 4 },
        { category: "recon", count: 2 },
      ],
      [
        { category: null, count: 4 },
        { category: "recon", count: 2 },
      ],
    );
    expect(d.categoryDeltas.map((c) => c.category)).toEqual(["recon", null]);
  });
});
