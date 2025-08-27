'use client';
import { useRouter } from 'next/navigation';
// biome-ignore lint/correctness/noUnusedImports: needed for JSX
import React from 'react';

export default function HomePage() {
  const _router = useRouter();

  return (
    <main className="flex flex-col items-center justify-center min-h-screen gap-4 p-6">
      <h1 className="text-3xl font-bold">Welcome to Aimer Web</h1>
      <div className="flex gap-4">
        <button type="button">User Login</button>
        <button type="button">Admin Login</button>
      </div>
    </main>
  );
}
