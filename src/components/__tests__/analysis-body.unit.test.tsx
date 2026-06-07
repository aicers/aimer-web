// @vitest-environment jsdom
//
// Shared Markdown body renderer (#382). Backs the event analysis, story
// analysis, and periodic report pages. Verifies:
//   - Markdown structure (headings, lists, inline code) renders as real
//     elements rather than literal `#` / `-` / backtick characters
//   - `<<UNVERIFIED_*>>` markers survive as highlighted badges, including
//     when they sit inside Markdown block structure (a list item)
//   - the empty-section `—` fallback is preserved
//   - raw HTML in the text is not injected as live DOM

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisBody, AnalysisMarkdown } from "../analysis-body";

afterEach(() => cleanup());

describe("AnalysisBody", () => {
  it("renders Markdown headings, lists, and inline code as elements", () => {
    const md = [
      "# Threat analysis",
      "",
      "## Summary",
      "",
      "- first finding",
      "- second finding",
      "",
      "Inspect the `/login` endpoint.",
    ].join("\n");
    render(<AnalysisBody text={md} testid="analysis-body" />);

    const body = screen.getByTestId("analysis-body");
    expect(body.querySelector("h1")?.textContent).toBe("Threat analysis");
    expect(body.querySelector("h2")?.textContent).toBe("Summary");
    expect(body.querySelectorAll("ul li")).toHaveLength(2);
    expect(body.querySelector("code")?.textContent).toBe("/login");
    // The raw Markdown punctuation must not survive as literal text.
    expect(body.textContent).not.toContain("# Threat");
    expect(body.textContent).not.toContain("- first");
  });

  it("highlights an `<<UNVERIFIED_*>>` marker as a badge inside a list item", () => {
    const md = "- contacted <<UNVERIFIED_IP_001>> twice";
    render(<AnalysisBody text={md} testid="analysis-body" />);

    const marker = screen.getByTestId("unverified-marker");
    expect(marker.textContent).toBe("<<UNVERIFIED_IP_001>>");
    // The marker is split out without breaking the surrounding list item.
    const li = screen.getByTestId("analysis-body").querySelector("li");
    expect(li?.textContent).toBe("contacted <<UNVERIFIED_IP_001>> twice");
    expect(li?.contains(marker)).toBe(true);
  });

  it("renders the empty fallback for a blank section", () => {
    render(<AnalysisBody text="   " testid="section" emptyFallback="—" />);
    expect(screen.getByTestId("section").textContent).toBe("—");
  });

  it("weaves a per-unit citation chip inline into the final paragraph (#449)", () => {
    render(
      <div data-testid="unit">
        <AnalysisMarkdown
          text="A grounded claim."
          citation={<span data-testid="chip">cite</span>}
        />
      </div>,
    );
    const chip = screen.getByTestId("chip");
    // The chip must sit INSIDE the sentence's paragraph (inline after the
    // text), not as a block sibling below it (#449 review round 1).
    const p = screen.getByTestId("unit").querySelector("p");
    expect(p?.contains(chip)).toBe(true);
    expect(p?.textContent).toBe("A grounded claim.cite");
  });

  it("renders no citation chip when none is supplied", () => {
    render(
      <div data-testid="unit">
        <AnalysisMarkdown text="Uncited prose." />
      </div>,
    );
    expect(screen.queryByTestId("chip")).toBeNull();
    expect(screen.getByTestId("unit").querySelector("p")?.textContent).toBe(
      "Uncited prose.",
    );
  });

  it("does not inject raw HTML as live DOM", () => {
    const md = "before <img src=x onerror=alert(1)> after";
    render(<AnalysisBody text={md} testid="analysis-body" />);
    const body = screen.getByTestId("analysis-body");
    // The `<img>` must not become a real element — raw HTML is disabled.
    expect(body.querySelector("img")).toBeNull();
  });
});
