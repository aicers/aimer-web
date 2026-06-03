// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The registrar reads its own path from `usePathname`; tests drive it
// through a ref so a single render can register multiple paths.
let currentPath = "/en/customers/c1/analysis/story/s1";
vi.mock("next/navigation", () => ({
  usePathname: () => currentPath,
}));

import {
  BreadcrumbLabelProvider,
  BreadcrumbLabelRegistrar,
  useBreadcrumbLabels,
} from "../breadcrumb-label-store";

// Exposes the current label map so assertions can read what registrars
// have written.
function captureLabels(sink: { current: ReadonlyMap<string, string> }) {
  function Probe() {
    sink.current = useBreadcrumbLabels();
    return null;
  }
  return Probe;
}

describe("BreadcrumbLabelStore", () => {
  it("exposes an empty map when nothing is registered", () => {
    const sink = { current: new Map<string, string>() };
    const Probe = captureLabels(sink);

    render(
      <BreadcrumbLabelProvider>
        <Probe />
      </BreadcrumbLabelProvider>,
    );

    expect(sink.current.size).toBe(0);
  });

  it("registers a label for the current path while mounted", () => {
    const sink = { current: new Map<string, string>() };
    const Probe = captureLabels(sink);
    currentPath = "/en/customers/c1/analysis/story/s1";

    render(
      <BreadcrumbLabelProvider>
        <Probe />
        <BreadcrumbLabelRegistrar label="Threat Story · s1" />
      </BreadcrumbLabelProvider>,
    );

    expect(sink.current.get("/en/customers/c1/analysis/story/s1")).toBe(
      "Threat Story · s1",
    );
  });

  it("clears the label on unmount", () => {
    const sink = { current: new Map<string, string>() };
    const Probe = captureLabels(sink);
    currentPath = "/en/customers/c1/analysis/story/s1";

    const { rerender } = render(
      <BreadcrumbLabelProvider>
        <Probe />
        <BreadcrumbLabelRegistrar label="Threat Story · s1" />
      </BreadcrumbLabelProvider>,
    );
    expect(sink.current.size).toBe(1);

    // Re-render without the registrar (e.g. navigating away) — its cleanup
    // removes the entry.
    rerender(
      <BreadcrumbLabelProvider>
        <Probe />
      </BreadcrumbLabelProvider>,
    );

    expect(sink.current.size).toBe(0);
  });

  it("updates the stored label when the label prop changes", () => {
    const sink = { current: new Map<string, string>() };
    const Probe = captureLabels(sink);
    currentPath = "/en/customers/c1/analysis/story/s1";

    const { rerender } = render(
      <BreadcrumbLabelProvider>
        <Probe />
        <BreadcrumbLabelRegistrar label="old" />
      </BreadcrumbLabelProvider>,
    );
    expect(sink.current.get("/en/customers/c1/analysis/story/s1")).toBe("old");

    rerender(
      <BreadcrumbLabelProvider>
        <Probe />
        <BreadcrumbLabelRegistrar label="new" />
      </BreadcrumbLabelProvider>,
    );

    expect(sink.current.get("/en/customers/c1/analysis/story/s1")).toBe("new");
  });

  it("keeps the same map reference when re-registering an identical label", () => {
    const seen: Array<ReadonlyMap<string, string>> = [];
    function Probe() {
      seen.push(useBreadcrumbLabels());
      return null;
    }
    currentPath = "/en/customers/c1/analysis/story/s1";

    const { rerender } = render(
      <BreadcrumbLabelProvider>
        <Probe />
        <BreadcrumbLabelRegistrar label="same" />
      </BreadcrumbLabelProvider>,
    );

    const afterFirst = seen[seen.length - 1];

    act(() => {
      rerender(
        <BreadcrumbLabelProvider>
          <Probe />
          <BreadcrumbLabelRegistrar label="same" />
        </BreadcrumbLabelProvider>,
      );
    });

    // The dedup guard in `register` returns the previous map unchanged, so
    // no needless map allocation/propagation occurs for an unchanged label.
    expect(seen[seen.length - 1]).toBe(afterFirst);
  });
});
