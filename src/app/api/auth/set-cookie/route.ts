import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { token, maxAgeSeconds } = (await req.json()) as {
      token?: string;
      maxAgeSeconds?: number;
    };
    if (!token || typeof token !== "string") {
      return NextResponse.json({ error: "token is required" }, { status: 400 });
    }

    const res = new NextResponse(null, { status: 204 });
    res.cookies.set("aimer_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge:
        typeof maxAgeSeconds === "number" ? maxAgeSeconds : 60 * 60 * 24 * 7, // 7d
    });
    return res;
  } catch (_err) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
}
