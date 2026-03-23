import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthContext } from "./cookies";

function getSecret(): string {
  const secret = process.env.CSRF_SECRET;
  if (!secret) {
    throw new Error("CSRF_SECRET environment variable must be set");
  }
  return secret;
}

export function generateCsrf(params: {
  ctx: AuthContext;
  sid: string;
  iat: number;
}): string {
  const data = `${params.ctx}:${params.sid}:${params.iat}`;
  return createHmac("sha256", getSecret()).update(data).digest("hex");
}

export function validateCsrf(params: {
  token: string;
  ctx: AuthContext;
  sid: string;
  iat: number;
}): boolean {
  const expected = generateCsrf({
    ctx: params.ctx,
    sid: params.sid,
    iat: params.iat,
  });

  const tokenBuf = Buffer.from(params.token, "utf-8");
  const expectedBuf = Buffer.from(expected, "utf-8");

  if (tokenBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(tokenBuf, expectedBuf);
}
