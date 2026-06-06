import { describe, expect, it } from "vitest";
import {
  analystReasonToDenyKey,
  mapTerminalReason,
} from "../analyst-invitations";

// ---------------------------------------------------------------------------
// Pure helpers from the analyst invitation acceptance path (#268).
// ---------------------------------------------------------------------------

describe("mapTerminalReason", () => {
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 60_000);

  it("maps accepted → already_consumed", () => {
    expect(mapTerminalReason({ status: "accepted", expires_at: future })).toBe(
      "already_consumed",
    );
  });

  it("maps revoked → revoked", () => {
    expect(mapTerminalReason({ status: "revoked", expires_at: future })).toBe(
      "revoked",
    );
  });

  it("maps expired → expired", () => {
    expect(mapTerminalReason({ status: "expired", expires_at: past })).toBe(
      "expired",
    );
  });

  it("maps a pending-but-past-expiry row → expired", () => {
    // Such a row only reaches the mapper because the resolver already
    // excluded the live pending + unexpired case.
    expect(mapTerminalReason({ status: "pending", expires_at: past })).toBe(
      "expired",
    );
  });
});

describe("analystReasonToDenyKey", () => {
  it("maps retryable reasons onto the member-side keys", () => {
    expect(analystReasonToDenyKey("email_mismatch")).toBe(
      "invitation_email_mismatch",
    );
    expect(analystReasonToDenyKey("email_verified_false")).toBe(
      "invitation_email_not_verified",
    );
  });

  it("folds every analyst-only terminal state onto the generic key", () => {
    expect(analystReasonToDenyKey("expired")).toBe("invitation_expired");
    expect(analystReasonToDenyKey("already_consumed")).toBe(
      "invitation_expired",
    );
    expect(analystReasonToDenyKey("revoked")).toBe("invitation_expired");
    expect(analystReasonToDenyKey("not_found")).toBe("invitation_expired");
  });
});
