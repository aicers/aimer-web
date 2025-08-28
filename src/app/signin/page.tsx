"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter, useSearchParams } from "next/navigation";
// biome-ignore lint/correctness/noUnusedImports: needed for JSX
import React, { Suspense, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInRequest } from "@/lib/graphql";

const schema = z.object({
  id: z.string().min(1, "ID is required"),
  pw: z.string().min(3, "Password must be at least 3 characters"),
});

type FormValues = z.infer<typeof schema>;

function SignInInner() {
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode") ?? "user";
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const resolver = useMemo(() => zodResolver(schema), []);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver, mode: "onBlur" });

  const onSubmit = async (data: FormValues) => {
    setFormError(null);
    try {
      const res = await signInRequest({ username: data.id, password: data.pw });
      if (!res?.token) throw new Error("Invalid response: missing token");
      if (typeof window !== "undefined") {
        window.localStorage.setItem("aimer_token", res.token);
      }
      router.push(mode === "admin" ? "/admin" : "/user");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sign-in failed";
      setFormError(message);
    }
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen p-6">
      <h1 className="text-2xl font-semibold mb-4">
        {mode === "admin" ? "Admin" : "User"} Sign In
      </h1>
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="flex flex-col gap-2 w-64"
      >
        <div>
          <Input
            type="text"
            placeholder="ID"
            aria-invalid={!!errors.id}
            {...register("id")}
          />
          {errors.id && (
            <p className="mt-1 text-sm text-red-600">{errors.id.message}</p>
          )}
        </div>
        <div>
          <Input
            type="password"
            placeholder="Password"
            aria-invalid={!!errors.pw}
            {...register("pw")}
          />
          {errors.pw && (
            <p className="mt-1 text-sm text-red-600">{errors.pw.message}</p>
          )}
        </div>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Signing in..." : "Sign In"}
        </Button>
      </form>
      {formError && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {formError}
        </p>
      )}
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<main className="p-6">Loading…</main>}>
      <SignInInner />
    </Suspense>
  );
}
