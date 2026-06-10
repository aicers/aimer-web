// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GroupCostPreview, GroupEligibleMember } from "@/lib/api/types";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));

const t = (key: string) => key;
vi.mock("next-intl", () => ({
  useTranslations: () => t,
}));

import { CreateGroupDialog } from "../create-group-dialog";

const SEOUL_MEMBERS: GroupEligibleMember[] = [
  {
    id: "m1",
    name: "Member One",
    externalKey: "k1",
    timezone: "Asia/Seoul",
    role: "Manager",
    isAnalyst: false,
  },
  {
    id: "m2",
    name: "Member Two",
    externalKey: "k2",
    timezone: "Asia/Seoul",
    role: "Manager",
    isAnalyst: false,
  },
];

const THREE_SEOUL_MEMBERS: GroupEligibleMember[] = [
  ...SEOUL_MEMBERS,
  {
    id: "m3",
    name: "Member Three",
    externalKey: "k3",
    timezone: "Asia/Seoul",
    role: "Manager",
    isAnalyst: false,
  },
];

const PREVIEW: GroupCostPreview = {
  memberCount: 2,
  maxMembers: 10,
  overMemberCap: false,
  combinedRecentEventVolume: 1234,
  generationCadence: ["daily"],
  estimatedMonthlyTokens: 5000,
  estimatedMonthlyCostUsd: 1.5,
};

/** Route apiFetch: eligible GET, preview POST, create POST. */
function arrangeServer(opts?: {
  members?: GroupEligibleMember[];
  preview?: GroupCostPreview;
  createImpl?: () => Promise<unknown>;
}) {
  const members = opts?.members ?? SEOUL_MEMBERS;
  const preview = opts?.preview ?? PREVIEW;
  mockApiFetch.mockImplementation((url: string, req?: RequestInit) => {
    const method = req?.method ?? "GET";
    if (url === "/api/groups/eligible-members") {
      return Promise.resolve({ customers: members });
    }
    if (url === "/api/groups/preview" && method === "POST") {
      return Promise.resolve(preview);
    }
    if (url === "/api/groups" && method === "POST") {
      return opts?.createImpl ? opts.createImpl() : Promise.resolve({});
    }
    return Promise.resolve(undefined);
  });
}

function postCalls(url: string) {
  return mockApiFetch.mock.calls.filter(
    (c) => (c[0] as string) === url && (c[1] as RequestInit)?.method === "POST",
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

afterEach(() => cleanup());

async function openDialog() {
  fireEvent.click(screen.getByText("createButton"));
  await waitFor(() => expect(screen.getByText("Member One")).toBeDefined());
}

describe("CreateGroupDialog", () => {
  it("loads eligible members when opened", async () => {
    arrangeServer();
    render(<CreateGroupDialog onCreated={vi.fn()} />);
    await openDialog();
    expect(screen.getByLabelText(/Member One/)).toBeDefined();
    expect(screen.getByLabelText(/Member Two/)).toBeDefined();
    expect(mockApiFetch).toHaveBeenCalledWith("/api/groups/eligible-members");
  });

  it("auto-fills the timezone members agree on and runs the cost preview", async () => {
    arrangeServer();
    render(<CreateGroupDialog onCreated={vi.fn()} />);
    await openDialog();
    fireEvent.click(screen.getByLabelText(/Member One/));
    fireEvent.click(screen.getByLabelText(/Member Two/));
    // Both members share Asia/Seoul → the tz control auto-fills.
    const tz = screen.getByLabelText("timezoneLabel") as HTMLSelectElement;
    await waitFor(() => expect(tz.value).toBe("Asia/Seoul"));
    // The preview fires for the in-range selection.
    await waitFor(() =>
      expect(postCalls("/api/groups/preview").length).toBe(1),
    );
    expect(
      JSON.parse(postCalls("/api/groups/preview")[0][1].body as string),
    ).toEqual({ memberIds: ["m1", "m2"] });
  });

  it("pre-selects the recommended tz when members' zones diverge", async () => {
    arrangeServer({
      members: [
        SEOUL_MEMBERS[0],
        {
          ...SEOUL_MEMBERS[1],
          timezone: "America/New_York",
        },
      ],
      preview: { ...PREVIEW, recommendedTz: "Europe/London" },
    });
    render(<CreateGroupDialog onCreated={vi.fn()} />);
    await openDialog();
    fireEvent.click(screen.getByLabelText(/Member One/));
    fireEvent.click(screen.getByLabelText(/Member Two/));
    const tz = screen.getByLabelText("timezoneLabel") as HTMLSelectElement;
    // Zones diverge → no shared tz, so the preview's recommendation fills in.
    await waitFor(() => expect(tz.value).toBe("Europe/London"));
  });

  it("submits the trimmed name, sorted member ids, and chosen tz", async () => {
    const onCreated = vi.fn();
    arrangeServer();
    render(<CreateGroupDialog onCreated={onCreated} />);
    await openDialog();
    fireEvent.click(screen.getByLabelText(/Member One/));
    fireEvent.click(screen.getByLabelText(/Member Two/));
    fireEvent.change(screen.getByLabelText("nameLabel"), {
      target: { value: "  Acme  " },
    });
    const tz = screen.getByLabelText("timezoneLabel") as HTMLSelectElement;
    await waitFor(() => expect(tz.value).toBe("Asia/Seoul"));
    fireEvent.click(screen.getByText("createConfirm"));
    await waitFor(() => expect(postCalls("/api/groups").length).toBe(1));
    expect(JSON.parse(postCalls("/api/groups")[0][1].body as string)).toEqual({
      name: "Acme",
      memberIds: ["m1", "m2"],
      tz: "Asia/Seoul",
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it("keeps submit disabled until a valid name, range, and tz are set", async () => {
    arrangeServer();
    render(<CreateGroupDialog onCreated={vi.fn()} />);
    await openDialog();
    const submit = screen.getByText("createConfirm") as HTMLButtonElement;
    // Nothing selected yet.
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Member One/));
    fireEvent.click(screen.getByLabelText(/Member Two/));
    const tz = screen.getByLabelText("timezoneLabel") as HTMLSelectElement;
    await waitFor(() => expect(tz.value).toBe("Asia/Seoul"));
    // Range + tz satisfied, but the name is still empty.
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("nameLabel"), {
      target: { value: "Acme" },
    });
    await waitFor(() => expect(submit.disabled).toBe(false));
  });

  it("blocks submit until the cost preview resolves", async () => {
    // Hold the preview POST pending so the manager cannot confirm before the
    // cost preview has loaded (#512).
    let resolvePreview: (value: GroupCostPreview) => void = () => {};
    const previewPending = new Promise<GroupCostPreview>((resolve) => {
      resolvePreview = resolve;
    });
    mockApiFetch.mockImplementation((url: string, req?: RequestInit) => {
      const method = req?.method ?? "GET";
      if (url === "/api/groups/eligible-members") {
        return Promise.resolve({ customers: SEOUL_MEMBERS });
      }
      if (url === "/api/groups/preview" && method === "POST") {
        return previewPending;
      }
      if (url === "/api/groups" && method === "POST") {
        return Promise.resolve({});
      }
      return Promise.resolve(undefined);
    });
    render(<CreateGroupDialog onCreated={vi.fn()} />);
    await openDialog();
    fireEvent.click(screen.getByLabelText(/Member One/));
    fireEvent.click(screen.getByLabelText(/Member Two/));
    fireEvent.change(screen.getByLabelText("nameLabel"), {
      target: { value: "Acme" },
    });
    // Range, name, and (shared) tz are all valid, but the preview is still
    // loading, so submit stays disabled and clicking it posts nothing.
    const tz = screen.getByLabelText("timezoneLabel") as HTMLSelectElement;
    await waitFor(() => expect(tz.value).toBe("Asia/Seoul"));
    const submit = screen.getByText("createConfirm") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(postCalls("/api/groups").length).toBe(0);
    // Once the preview resolves, submit unlocks.
    resolvePreview(PREVIEW);
    await waitFor(() => expect(submit.disabled).toBe(false));
  });

  it("blocks submit when the cost preview fails to load", async () => {
    mockApiFetch.mockImplementation((url: string, req?: RequestInit) => {
      const method = req?.method ?? "GET";
      if (url === "/api/groups/eligible-members") {
        return Promise.resolve({ customers: SEOUL_MEMBERS });
      }
      if (url === "/api/groups/preview" && method === "POST") {
        return Promise.reject(new Error("preview_failed"));
      }
      if (url === "/api/groups" && method === "POST") {
        return Promise.resolve({});
      }
      return Promise.resolve(undefined);
    });
    render(<CreateGroupDialog onCreated={vi.fn()} />);
    await openDialog();
    fireEvent.click(screen.getByLabelText(/Member One/));
    fireEvent.click(screen.getByLabelText(/Member Two/));
    fireEvent.change(screen.getByLabelText("nameLabel"), {
      target: { value: "Acme" },
    });
    const tz = screen.getByLabelText("timezoneLabel") as HTMLSelectElement;
    await waitFor(() => expect(tz.value).toBe("Asia/Seoul"));
    // The preview request settled (rejected) and the unavailable note shows, but
    // with no successful preview submit stays disabled and posts nothing.
    await waitFor(() =>
      expect(screen.getByText("costPreviewUnavailable")).toBeDefined(),
    );
    const submit = screen.getByText("createConfirm") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(postCalls("/api/groups").length).toBe(0);
  });

  it("blocks submit on a stale preview when the selection changes mid-flight", async () => {
    // First preview (members A+B) resolves; the second (A+B+C) is held pending
    // so the still-loaded A+B preview cannot back a create for A+B+C (#512).
    let resolveSecondPreview: (value: GroupCostPreview) => void = () => {};
    const secondPreviewPending = new Promise<GroupCostPreview>((resolve) => {
      resolveSecondPreview = resolve;
    });
    let previewCalls = 0;
    mockApiFetch.mockImplementation((url: string, req?: RequestInit) => {
      const method = req?.method ?? "GET";
      if (url === "/api/groups/eligible-members") {
        return Promise.resolve({ customers: THREE_SEOUL_MEMBERS });
      }
      if (url === "/api/groups/preview" && method === "POST") {
        previewCalls += 1;
        return previewCalls === 1
          ? Promise.resolve(PREVIEW)
          : secondPreviewPending;
      }
      if (url === "/api/groups" && method === "POST") {
        return Promise.resolve({});
      }
      return Promise.resolve(undefined);
    });
    render(<CreateGroupDialog onCreated={vi.fn()} />);
    await openDialog();
    fireEvent.click(screen.getByLabelText(/Member One/));
    fireEvent.click(screen.getByLabelText(/Member Two/));
    fireEvent.change(screen.getByLabelText("nameLabel"), {
      target: { value: "Acme" },
    });
    // Preview for A+B resolved → submit is enabled.
    const submit = screen.getByText("createConfirm") as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));

    // Add a third member: the A+B preview is now stale and the A+B+C preview is
    // still pending, so submit must lock again and clicking it posts nothing.
    fireEvent.click(screen.getByLabelText(/Member Three/));
    await waitFor(() =>
      expect(postCalls("/api/groups/preview").length).toBe(2),
    );
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(postCalls("/api/groups").length).toBe(0);

    // Once the A+B+C preview resolves, submit unlocks and posts all three.
    resolveSecondPreview(PREVIEW);
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(postCalls("/api/groups").length).toBe(1));
    expect(JSON.parse(postCalls("/api/groups")[0][1].body as string)).toEqual({
      name: "Acme",
      memberIds: ["m1", "m2", "m3"],
      tz: "Asia/Seoul",
    });
  });

  it("maps a server error code to a localized message", async () => {
    arrangeServer({
      createImpl: () =>
        Promise.reject(
          Object.assign(new Error("member_not_operational"), {
            status: 422,
          }),
        ),
    });
    render(<CreateGroupDialog onCreated={vi.fn()} />);
    await openDialog();
    fireEvent.click(screen.getByLabelText(/Member One/));
    fireEvent.click(screen.getByLabelText(/Member Two/));
    fireEvent.change(screen.getByLabelText("nameLabel"), {
      target: { value: "Acme" },
    });
    const tz = screen.getByLabelText("timezoneLabel") as HTMLSelectElement;
    await waitFor(() => expect(tz.value).toBe("Asia/Seoul"));
    fireEvent.click(screen.getByText("createConfirm"));
    await waitFor(() =>
      expect(screen.getByText("errorMemberNotOperational")).toBeDefined(),
    );
  });
});
