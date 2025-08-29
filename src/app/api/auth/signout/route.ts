import { NextResponse } from "next/server";

export async function POST() {
  const res = new NextResponse(null, { status: 204 });
  res.cookies.set("aimer_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
