import Link from "next/link";
// biome-ignore lint/correctness/noUnusedImports: needed for JSX
import React from "react";

export default function HomePage() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-4 p-6">
      <h1 className="text-3xl font-bold">Welcome to Aimer Web</h1>
      <div className="flex gap-4">
        <Link className="underline" href="/login?mode=user">
          User Login
        </Link>
        <Link className="underline" href="/login?mode=admin">
          Admin Login
        </Link>
      </div>
    </main>
  );
}
