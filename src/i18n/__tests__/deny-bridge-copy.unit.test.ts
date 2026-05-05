import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import ko from "../messages/ko.json";

// Issue #194: revised per-reason deny copy must give actionable, distinct
// recovery guidance and must not regress to the prior generic phrasing.

const enDeny = (en as { auth: { deny: Record<string, string> } }).auth.deny;
const koDeny = (ko as { auth: { deny: Record<string, string> } }).auth.deny;

describe("auth.deny scope-probing copy", () => {
  it("EN copy is distinct across the four scope-probing reasons", () => {
    const values = [
      enDeny.bridgeCustomerMismatch,
      enDeny.bridgeCustomerInactive,
      enDeny.bridgeEnvironmentInactive,
      enDeny.bridgeNoAccess,
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it("KO copy is distinct across the four scope-probing reasons", () => {
    const values = [
      koDeny.bridgeCustomerMismatch,
      koDeny.bridgeCustomerInactive,
      koDeny.bridgeEnvironmentInactive,
      koDeny.bridgeNoAccess,
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  // Regression guards: pin distinguishing keywords that would disappear
  // if the strings were reverted to the prior generic phrasing.

  it("bridgeCustomerMismatch points at operator/registration mismatch", () => {
    expect(enDeny.bridgeCustomerMismatch).toMatch(
      /customer scope sent from AICE does not match/,
    );
    expect(enDeny.bridgeCustomerMismatch).toMatch(/operator/);
    expect(koDeny.bridgeCustomerMismatch).toMatch(/일치하지 않습니다/);
    expect(koDeny.bridgeCustomerMismatch).toMatch(/운영자/);
  });

  it("bridgeCustomerInactive states the customer is not active", () => {
    expect(enDeny.bridgeCustomerInactive).toMatch(/not active/);
    expect(enDeny.bridgeCustomerInactive).toMatch(/reactivate/);
    expect(koDeny.bridgeCustomerInactive).toMatch(/활성 상태가 아닙니다/);
    expect(koDeny.bridgeCustomerInactive).toMatch(/재활성화/);
  });

  it("bridgeEnvironmentInactive states the environment is not active", () => {
    expect(enDeny.bridgeEnvironmentInactive).toMatch(/AICE environment/);
    expect(enDeny.bridgeEnvironmentInactive).toMatch(/not active/);
    expect(koDeny.bridgeEnvironmentInactive).toMatch(/AICE 환경/);
    expect(koDeny.bridgeEnvironmentInactive).toMatch(/활성 상태가 아닙니다/);
  });

  it("bridgeNoAccess names both recovery paths (Manager and System Administrator)", () => {
    expect(enDeny.bridgeNoAccess).toMatch(/Manager/);
    expect(enDeny.bridgeNoAccess).toMatch(/System Administrator/);
    expect(enDeny.bridgeNoAccess).toMatch(/analyst/);
    expect(koDeny.bridgeNoAccess).toMatch(/매니저/);
    expect(koDeny.bridgeNoAccess).toMatch(/시스템 관리자/);
    expect(koDeny.bridgeNoAccess).toMatch(/분석가/);
  });

  // Privacy: per #194 the user-facing copy must not leak the existence
  // or non-existence of specific customers / environments. Ensure no
  // placeholder for an external_key / customer name slipped in.
  it("does not include placeholders that would interpolate identifiers", () => {
    const values = [
      enDeny.bridgeCustomerMismatch,
      enDeny.bridgeCustomerInactive,
      enDeny.bridgeEnvironmentInactive,
      enDeny.bridgeNoAccess,
      koDeny.bridgeCustomerMismatch,
      koDeny.bridgeCustomerInactive,
      koDeny.bridgeEnvironmentInactive,
      koDeny.bridgeNoAccess,
    ];
    for (const v of values) {
      expect(v).not.toMatch(/\{[^}]+\}/);
      expect(v).not.toMatch(/external_key/);
    }
  });
});
