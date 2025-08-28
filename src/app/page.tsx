import Link from "next/link";
// biome-ignore lint/correctness/noUnusedImports: needed for JSX
import React from "react";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-4 p-6">
      <h1 className="text-3xl font-bold">Welcome to Aimer Web</h1>
      <div className="flex gap-4">
        <Button asChild>
          <Link href="/signin?mode=user">User Sign In</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/signin?mode=admin">Admin Sign In</Link>
        </Button>
      </div>
    </main>
  );
}
