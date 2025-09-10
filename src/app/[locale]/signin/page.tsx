"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInRequest } from "@/lib/graphql";
import { friendlyError } from "@/lib/utils";

type FormValues = { id: string; pw: string };

function SignInInner() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const mode = (searchParams.get("mode") ?? "user") as "user" | "admin";
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const schema = useMemo(
    () =>
      z.object({
        id: z.string().min(1, t("signin.validation.idRequired")),
        pw: z.string().min(3, t("signin.validation.pwMin", { count: 3 })),
      }),
    [t],
  );

  const resolver = useMemo(() => zodResolver(schema), [schema]);
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
      await fetch("/api/auth/set-cookie", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: res.token }),
      });
      router.push(mode === "admin" ? "/admin" : "/user");
    } catch (err) {
      setFormError(friendlyError(err));
    }
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen p-6">
      <h1 className="text-2xl font-semibold mb-4">
        {t("signin.title", { mode })}
      </h1>
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="flex flex-col gap-2 w-64"
      >
        <div>
          <Input
            type="text"
            placeholder={t("signin.idPlaceholder")}
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
            placeholder={t("signin.passwordPlaceholder")}
            aria-invalid={!!errors.pw}
            {...register("pw")}
          />
          {errors.pw && (
            <p className="mt-1 text-sm text-red-600">{errors.pw.message}</p>
          )}
        </div>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? t("signin.submitting") : t("signin.submit")}
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
  const t = useTranslations();
  return (
    <Suspense fallback={<main className="p-6">{t("signin.loading")}</main>}>
      <SignInInner />
    </Suspense>
  );
}
