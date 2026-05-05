// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => {
  const map: Record<string, string> = {
    invalidPublicKey: "Invalid JWK JSON.",
    thumbprintTitle: "JWK Thumbprint",
    thumbprintInstruction: "Compare out-of-band.",
    thumbprintBase64Url: "base64url",
    thumbprintHex: "hex",
    thumbprintComputing: "Computing thumbprint...",
    thumbprintError: "Failed to compute thumbprint.",
    thumbprintConfirm: "I confirmed the thumbprint matches.",
    copy: "Copy",
    copied: "Copied",
  };
  // Stable translator reference so useEffect deps that include `t` don't
  // re-fire every render in the test environment.
  const translator = (key: string) => map[key] ?? key;
  return {
    useTranslations: vi.fn(() => translator),
  };
});

vi.mock("@/lib/api/admin-client", () => ({
  adminFetch: vi.fn(),
}));

import { adminFetch } from "@/lib/api/admin-client";
import { ApiError } from "@/lib/api/client";
import { JwkThumbprintConfirm } from "../jwk-thumbprint-confirm";

const mockedFetch = vi.mocked(adminFetch);

const VALID_JWK = JSON.stringify({
  kty: "EC",
  crv: "P-256",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
});
const VALID_THUMBPRINT = {
  base64url: "abcdef123456_basE-ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  hex: "00112233:44556677:8899aabb:ccddeeff:00112233:44556677:8899aabb:ccddeeff",
};

// Wrapper that mimics the parent dialog's gating logic: a Submit button that
// is disabled until both the JWK is valid and the operator has confirmed.
function Harness({
  initialJwk = "",
  onSubmitClick,
}: {
  initialJwk?: string;
  onSubmitClick?: () => void;
}) {
  const [jwk, setJwk] = useState(initialJwk);
  const [confirmed, setConfirmed] = useState(false);
  const [valid, setValid] = useState(false);
  return (
    <div>
      <textarea
        aria-label="jwk"
        value={jwk}
        onChange={(e) => {
          setJwk(e.target.value);
          setConfirmed(false);
          setValid(false);
        }}
      />
      <JwkThumbprintConfirm
        jwkText={jwk}
        confirmed={confirmed}
        onConfirmedChange={setConfirmed}
        onValidityChange={setValid}
      />
      <button
        type="button"
        disabled={!valid || !confirmed}
        onClick={onSubmitClick}
      >
        Submit
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  mockedFetch.mockReset();
});

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("JwkThumbprintConfirm", () => {
  it("shows both formats and gates Submit on the confirm checkbox", async () => {
    mockedFetch.mockResolvedValue(VALID_THUMBPRINT);

    const { getByRole, getByLabelText, findByText, getByText } = render(
      <Harness initialJwk={VALID_JWK} />,
    );

    const submit = getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    expect(await findByText(VALID_THUMBPRINT.base64url)).toBeTruthy();
    expect(getByText(VALID_THUMBPRINT.hex)).toBeTruthy();

    // Validity flowed up; checkbox still un-checked → Submit disabled.
    await waitFor(() => {
      expect(submit.disabled).toBe(true);
    });

    const checkbox = getByLabelText(
      "I confirmed the thumbprint matches.",
    ) as HTMLInputElement;
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(submit.disabled).toBe(false);
    });
  });

  it("clears confirmation, hides thumbprint, and re-disables Submit when the JWK changes", async () => {
    mockedFetch.mockResolvedValue(VALID_THUMBPRINT);

    const { getByRole, getByLabelText, findByText, queryByText } = render(
      <Harness initialJwk={VALID_JWK} />,
    );

    expect(await findByText(VALID_THUMBPRINT.base64url)).toBeTruthy();
    const checkbox = getByLabelText(
      "I confirmed the thumbprint matches.",
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    const submit = getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(submit.disabled).toBe(false);
    });

    // Edit textarea — must synchronously reset.
    const textarea = getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: `${VALID_JWK} ` },
    });

    // Stale thumbprint must NOT remain visible on the same render after edit.
    expect(queryByText(VALID_THUMBPRINT.base64url)).toBeNull();
    expect(submit.disabled).toBe(true);
  });

  it("shows an error and hides the confirm checkbox on invalid JWK", async () => {
    mockedFetch.mockRejectedValue(new ApiError("Invalid JWK", 400));

    const { findByText, queryByLabelText, getByRole } = render(
      <Harness initialJwk={JSON.stringify({ kty: "OCT-broken" })} />,
    );

    expect(await findByText("Invalid JWK")).toBeTruthy();
    expect(queryByLabelText("I confirmed the thumbprint matches.")).toBeNull();
    const submit = getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("shows a parse error for malformed JSON without calling the server", async () => {
    const { findByText, queryByLabelText } = render(
      <Harness initialJwk="{not json" />,
    );

    expect(await findByText("Invalid JWK JSON.")).toBeTruthy();
    expect(queryByLabelText("I confirmed the thumbprint matches.")).toBeNull();
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
