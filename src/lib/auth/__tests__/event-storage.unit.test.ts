import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockEncryptPayload = vi.fn();
const mockClientQuery = vi.fn();
const mockClientConnect = vi.fn();
const mockClientEnd = vi.fn();

vi.mock("../../crypto/envelope", () => ({
  encryptPayload: (...args: unknown[]) => mockEncryptPayload(...args),
}));

vi.mock("../../db/customer-db", () => ({
  customerTransitKeyName: (id: string) => `customer-${id}`,
  customerDbUrl: (_tpl: string, id: string) =>
    `postgres://localhost/customer_${id}`,
  getCustomerRuntimeTemplateUrl: () => "postgres://localhost/template1",
}));

vi.mock("pg", () => {
  const ClientCtor = vi.fn(function (this: Record<string, unknown>) {
    this.query = mockClientQuery;
    this.connect = mockClientConnect;
    this.end = mockClientEnd;
  });
  return { Client: ClientCtor };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storeApprovedEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEncryptPayload.mockResolvedValue({
      ciphertext: Buffer.from("re-encrypted"),
      wrappedDek: "vault:v1:customer-key",
    });
    mockClientConnect.mockResolvedValue(undefined);
    mockClientQuery.mockResolvedValue({
      rows: [{ id: "event-id-1" }],
    });
    mockClientEnd.mockResolvedValue(undefined);
  });

  async function callStore(overrides?: Record<string, unknown>) {
    const { storeApprovedEvents } = await import("../event-storage");
    return storeApprovedEvents({
      customerId: "cust-1",
      aiceId: "aice-1",
      eventCount: 5,
      schemaVersion: "1.0",
      source: "manual",
      connectionId: null,
      ingestedBy: "acct-1",
      plaintext: Buffer.from("decrypted-data"),
      payloadHash: "abc123",
      ...overrides,
    });
  }

  it("re-encrypts with customer-specific Transit key", async () => {
    const eventId = await callStore();
    expect(eventId).toBe("event-id-1");

    expect(mockEncryptPayload).toHaveBeenCalledWith(
      Buffer.from("decrypted-data"),
      "customer-cust-1",
    );
  });

  it("uses a single Client connection (not Pool)", async () => {
    await callStore();
    expect(mockClientConnect).toHaveBeenCalledOnce();
  });

  it("inserts into customer database with correct values", async () => {
    await callStore();

    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO detection_events"),
      [
        "aice-1",
        Buffer.from("re-encrypted"),
        "vault:v1:customer-key",
        5,
        "1.0",
        "abc123",
        "manual",
        null,
        "acct-1",
      ],
    );
  });

  it("stores bridge source and connection_id when provided", async () => {
    await callStore({
      source: "bridge",
      connectionId: "conn-1",
    });

    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO detection_events"),
      expect.arrayContaining(["bridge", "conn-1"]),
    );
  });

  it("closes the client after insert", async () => {
    await callStore();
    expect(mockClientEnd).toHaveBeenCalled();
  });

  it("closes the client on insert failure", async () => {
    mockClientQuery.mockRejectedValue(new Error("db error"));

    await expect(callStore()).rejects.toThrow("db error");
    expect(mockClientEnd).toHaveBeenCalled();
  });

  it("does not connect to customer DB on encryption failure", async () => {
    mockEncryptPayload.mockRejectedValue(new Error("transit error"));

    await expect(callStore()).rejects.toThrow("transit error");
    expect(mockClientConnect).not.toHaveBeenCalled();
  });
});
