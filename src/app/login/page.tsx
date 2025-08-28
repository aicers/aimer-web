"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const schema = z.object({
  id: z.string().min(1, "ID is required"),
  pw: z.string().min(6, "Password must be at least 6 characters"),
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const searchParams = useSearchParams();
  const mode = searchParams.get("mode") ?? "user";

  const resolver = useMemo(() => zodResolver(schema), []);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver, mode: "onBlur" });

  const onSubmit = (data: FormValues) => {
    alert(`Login mode: ${mode}\nID: ${data.id}\nPW: ${data.pw}`);
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen p-6">
      <h1 className="text-2xl font-semibold mb-4">
        {mode === "admin" ? "Admin" : "User"} Login
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
          {isSubmitting ? "Logging in..." : "Login"}
        </Button>
      </form>
    </main>
  );
}
