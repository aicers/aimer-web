// @vitest-environment jsdom
//
// #552 — the shared event row title (`{event time} · {kind display name}`,
// with fallbacks). Covers every rendering branch: time + kind, kind-null →
// time only, event_time-absent → static fallback, and the raw-kind fallback
// for a kind absent from the friendly-name map.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// `<Timestamp>` reads the active locale via `useLocale()`; render it outside a
// provider by supplying a fixed locale while keeping the rest of next-intl real.
vi.mock("next-intl", async () => {
  const actual = await vi.importActual<typeof import("next-intl")>("next-intl");
  return { ...actual, useLocale: () => "en" };
});

import { EventTitle } from "../event-title";

const AT = new Date("2026-05-20T00:00:00Z");

describe("EventTitle (#552)", () => {
  afterEach(() => cleanup());

  it("renders the time (as a <time> element) followed by the kind display name", () => {
    const { container } = render(
      <EventTitle eventTime={AT} kind="HttpThreat" fallbackLabel="Event" />,
    );
    // Friendly name from the ported map, not the raw `__typename`.
    expect(container.textContent).toContain("· HTTP Threat");
    // The time is the compact <Timestamp>, a real <time> element.
    expect(container.querySelector("time")).not.toBeNull();
    expect(container.textContent).not.toBe("Event");
  });

  it("renders the time only (no separator) when kind is null", () => {
    const { container } = render(
      <EventTitle eventTime={AT} kind={null} fallbackLabel="Event" />,
    );
    expect(container.querySelector("time")).not.toBeNull();
    expect(container.textContent).not.toContain("·");
  });

  it("falls back to the raw kind for a kind absent from the map", () => {
    const { container } = render(
      <EventTitle eventTime={AT} kind="SomeNewKind" fallbackLabel="Event" />,
    );
    expect(container.textContent).toContain("· SomeNewKind");
  });

  it("renders the static fallback (no <time>) when eventTime is null", () => {
    render(
      <EventTitle eventTime={null} kind="HttpThreat" fallbackLabel="Event" />,
    );
    expect(screen.getByText("Event")).toBeTruthy();
    expect(document.querySelector("time")).toBeNull();
  });
});
