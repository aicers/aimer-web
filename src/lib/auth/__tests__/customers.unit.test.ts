import { describe, expect, it } from "vitest";
import { validateCustomerFields } from "../customers";
import { HttpError } from "../errors";

describe("validateCustomerFields", () => {
  describe("name", () => {
    it("trims and accepts valid name", () => {
      const out = validateCustomerFields({ name: "  Acme  " });
      expect(out.name).toBe("Acme");
    });

    it("rejects empty after trim", () => {
      expect(() => validateCustomerFields({ name: "   " })).toThrow(
        new HttpError("name_required", 400),
      );
    });

    it("rejects non-string when present", () => {
      expect(() => validateCustomerFields({ name: 123 })).toThrow(
        /name must be a string/,
      );
    });

    it("rejects when name exceeds 256 chars", () => {
      expect(() => validateCustomerFields({ name: "x".repeat(257) })).toThrow(
        new HttpError("name_too_long", 400),
      );
    });

    it("rejects control characters", () => {
      const v = `Acme${String.fromCharCode(7)}`;
      expect(() => validateCustomerFields({ name: v })).toThrow(
        new HttpError("name_invalid_characters", 400),
      );
    });

    it("requires name when requireAll set", () => {
      expect(() =>
        validateCustomerFields({ externalKey: "x" }, { requireAll: true }),
      ).toThrow(new HttpError("name_required", 400));
    });

    it("skips name when undefined and requireAll false", () => {
      const out = validateCustomerFields({ externalKey: "x" });
      expect(out.name).toBeUndefined();
    });
  });

  describe("externalKey", () => {
    it("trims and accepts valid value", () => {
      const out = validateCustomerFields({ externalKey: "  acme-001  " });
      expect(out.externalKey).toBe("acme-001");
    });

    it("rejects empty after trim", () => {
      expect(() => validateCustomerFields({ externalKey: "   " })).toThrow(
        new HttpError("external_key_required", 400),
      );
    });

    it("rejects non-string", () => {
      expect(() => validateCustomerFields({ externalKey: 42 })).toThrow(
        /externalKey must be a string/,
      );
    });

    it("rejects values longer than 256 chars", () => {
      expect(() =>
        validateCustomerFields({ externalKey: "x".repeat(257) }),
      ).toThrow(new HttpError("external_key_too_long", 400));
    });

    it("accepts exactly 256 chars", () => {
      const out = validateCustomerFields({ externalKey: "x".repeat(256) });
      expect(out.externalKey?.length).toBe(256);
    });

    it("rejects control characters", () => {
      const ctrl = `acme${String.fromCharCode(0)}`;
      expect(() => validateCustomerFields({ externalKey: ctrl })).toThrow(
        new HttpError("external_key_invalid_characters", 400),
      );
    });

    it("rejects DEL (0x7F)", () => {
      const ctrl = `acme${String.fromCharCode(0x7f)}`;
      expect(() => validateCustomerFields({ externalKey: ctrl })).toThrow(
        new HttpError("external_key_invalid_characters", 400),
      );
    });
  });

  describe("description", () => {
    it("trims string", () => {
      const out = validateCustomerFields({ description: "  hi  " });
      expect(out.description).toBe("hi");
    });

    it("converts empty-after-trim to null", () => {
      const out = validateCustomerFields({ description: "  " });
      expect(out.description).toBeNull();
    });

    it("accepts explicit null", () => {
      const out = validateCustomerFields({ description: null });
      expect(out.description).toBeNull();
    });

    it("rejects non-string non-null", () => {
      expect(() => validateCustomerFields({ description: 5 })).toThrow(
        /description must be a string/,
      );
    });

    it("rejects control characters", () => {
      const v = `desc${String.fromCharCode(2)}`;
      expect(() => validateCustomerFields({ description: v })).toThrow(
        new HttpError("description_invalid_characters", 400),
      );
    });
  });
});
