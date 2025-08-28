"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode") ?? "user";
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    alert(`Login mode: ${mode}\nID: ${id}\nPW: ${pw}`);
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen p-6">
      <h1 className="text-2xl font-semibold mb-4">
        {mode === "admin" ? "Admin" : "User"} Login
      </h1>
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 w-64">
        <input
          className="border p-2 rounded"
          type="text"
          placeholder="ID"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <input
          className="border p-2 rounded"
          type="password"
          placeholder="Password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <button className="bg-blue-600 text-white p-2 rounded" type="submit">
          Login
        </button>
      </form>
    </main>
  );
}
