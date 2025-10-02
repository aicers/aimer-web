"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Suspense, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInRequest } from "@/lib/graphql";
import { friendlyError, getRoleFromToken } from "@/lib/utils";

type FormValues = { id: string; pw: string };

function SignInInner() {
  const t = useTranslations();
  const router = useRouter();
  const locale = useLocale();
  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

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
    formState: { errors, isSubmitting, isValid },
  } = useForm<FormValues>({
    resolver,
    mode: "onChange",
    reValidateMode: "onChange",
    defaultValues: { id: "", pw: "" },
  });

  const onSubmit = async (data: FormValues) => {
    setFormError(null);
    try {
      const res = await signInRequest({ username: data.id, password: data.pw });
      if (!res?.token) throw new Error("Invalid response: missing token");
      const role = getRoleFromToken(res.token);
      if (role !== "administrator" && role !== "user") {
        router.push(`/${locale}/signin/error`);
        return;
      }
      await fetch("/api/auth/set-cookie", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: res.token }),
      });
      router.push(`/${locale}/${role === "administrator" ? "admin" : "user"}`);
    } catch (err) {
      setFormError(friendlyError(err));
    }
  };

  const isDisabled = isSubmitting || !isValid;

  return (
    <main className="min-h-screen bg-[#F5F6F7] px-4 py-16 flex items-center justify-center">
      <section className="w-full max-w-[448px] rounded-xl bg-white px-9 pb-9 pt-9 shadow-sm">
        <header className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold text-[#212428] tracking-tight">
            {t("signin.brand")}
          </h1>
          <p className="text-base font-medium text-[#474C55]">
            {t("signin.subtitle")}
          </p>
        </header>
        <form
          className="mt-6 flex flex-col gap-6"
          onSubmit={handleSubmit(onSubmit)}
        >
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1.5">
                <label
                  className="text-sm font-medium text-[#212428]"
                  htmlFor="signin-id"
                >
                  {t("signin.labels.id")}
                </label>
                <Input
                  id="signin-id"
                  type="text"
                  placeholder={t("signin.idPlaceholder")}
                  aria-invalid={!!errors.id}
                  autoComplete="username"
                  className="h-9 rounded-lg border-none bg-[rgba(97,105,116,0.08)] px-3 text-sm text-[#212428] shadow-none placeholder:text-[#616974] focus-visible:ring-2 focus-visible:ring-[#0D5FD8]"
                  {...register("id")}
                />
                {errors.id && (
                  <p className="text-sm text-red-600">{errors.id.message}</p>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <label
                    className="flex-1 text-sm font-medium text-[#212428]"
                    htmlFor="signin-password"
                  >
                    {t("signin.labels.password")}
                  </label>
                  <button
                    type="button"
                    className="text-sm font-normal text-[#0D5FD8] hover:underline"
                  >
                    {t("signin.forgotPassword")}
                  </button>
                </div>
                <Input
                  id="signin-password"
                  type={showPassword ? "text" : "password"}
                  placeholder={t("signin.passwordPlaceholder")}
                  aria-invalid={!!errors.pw}
                  autoComplete="current-password"
                  className="h-9 rounded-lg border-none bg-[rgba(97,105,116,0.08)] px-3 text-sm text-[#212428] shadow-none placeholder:text-[#616974] focus-visible:ring-2 focus-visible:ring-[#0D5FD8]"
                  {...register("pw")}
                />
                {errors.pw && (
                  <p className="text-sm text-red-600">{errors.pw.message}</p>
                )}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-[#474C55]">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border border-[#616974] text-[#0D5FD8] focus:ring-[#0D5FD8]"
                checked={showPassword}
                onChange={(event) => setShowPassword(event.target.checked)}
              />
              {t("signin.toggle.showPassword")}
            </label>
          </div>
          {formError && (
            <p className="text-sm text-red-600" role="alert">
              {formError}
            </p>
          )}
          <Button
            type="submit"
            disabled={isDisabled}
            className="h-9 w-full rounded-lg bg-[#0D5FD8] text-sm font-medium text-white disabled:bg-[#C5E4F7] disabled:text-white disabled:opacity-100 disabled:hover:bg-[#C5E4F7]"
          >
            {isSubmitting ? t("signin.submitting") : t("signin.submit")}
          </Button>
        </form>
      </section>
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
