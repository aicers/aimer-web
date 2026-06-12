import type { NextRequest } from "next/server";
import { importRawFeedPayload } from "@/lib/analysis/enrichment/feed-import";
import {
  assertParseableUpload,
  buildManualUploadPayload,
  FeedUploadError,
  MAX_FEED_UPLOAD_BYTES,
  manualUploadModeActive,
} from "@/lib/analysis/enrichment/feed-upload";
import { assertAuthorized } from "@/lib/auth/authorization";
import { HttpError } from "@/lib/auth/errors";
import { verifyCsrf, verifyOrigin, withAuth } from "@/lib/auth/guards";
import { getAuthPool, getFeedPool } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// POST /api/admin/ti-feed/upload — import an operator-provided Tier-1 feed
// ---------------------------------------------------------------------------

export const POST = withAuth(
  async (req: NextRequest, auth) => {
    if (!manualUploadModeActive()) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const originErr = verifyOrigin(req);
    if (originErr) return originErr;

    const csrfErr = verifyCsrf(req, {
      ctx: "admin",
      sid: auth.sessionId,
      iat: auth.iat,
    });
    if (csrfErr) return csrfErr;

    const authPool = getAuthPool();
    const client = await authPool.connect();
    try {
      await assertAuthorized(client, "admin", auth.accountId, "ti-feed:write");
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json(
          { error: err.message },
          { status: err.statusCode },
        );
      }
      throw err;
    } finally {
      client.release();
    }

    // Reject an over-limit body up front, before `formData()` reads and
    // buffers the whole multipart payload into memory. `Content-Length` can
    // be absent or spoofed, so the per-part `File.size` check below remains
    // the authoritative guard; this just avoids buffering an honestly-declared
    // oversized upload.
    const declaredLength = Number(req.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_FEED_UPLOAD_BYTES
    ) {
      return Response.json(
        { error: "Uploaded file exceeds the maximum allowed size" },
        { status: 413 },
      );
    }

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return Response.json(
        { error: "Invalid multipart body" },
        { status: 400 },
      );
    }

    const sourcePolicyId = formData.get("sourcePolicyId");
    const file = formData.get("file");

    if (typeof sourcePolicyId !== "string" || sourcePolicyId.length === 0) {
      return Response.json(
        { error: "sourcePolicyId is required" },
        { status: 400 },
      );
    }
    if (!(file instanceof File)) {
      return Response.json({ error: "file is required" }, { status: 400 });
    }
    if (file.size > MAX_FEED_UPLOAD_BYTES) {
      return Response.json(
        { error: "Uploaded file exceeds the maximum allowed size" },
        { status: 413 },
      );
    }

    const content = await file.text();

    let payload: ReturnType<typeof buildManualUploadPayload>;
    try {
      payload = buildManualUploadPayload({
        sourcePolicyId,
        filename: file.name || "upload",
        content,
        uploadedAt: new Date().toISOString(),
      });
      assertParseableUpload(payload);
    } catch (err) {
      if (err instanceof FeedUploadError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }

    const { rowCount, feedHash } = await importRawFeedPayload(
      getFeedPool(),
      payload,
    );
    return Response.json({ rowCount, feedHash });
  },
  { ctx: "admin" },
);
