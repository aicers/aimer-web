"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

interface InviteDialogProps {
  onInvite: (email: string, role: string) => Promise<void>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteDialog({ onInvite }: InviteDialogProps) {
  const t = useTranslations("members");
  const tCommon = useTranslations("common");
  const tValidation = useTranslations("validation");

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("User");
  const [sending, setSending] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);

    if (!email.trim()) {
      setEmailError(tValidation("required"));
      return;
    }
    if (!EMAIL_RE.test(email)) {
      setEmailError(tValidation("invalidEmail"));
      return;
    }

    setSending(true);
    try {
      await onInvite(email.trim(), role);
      setEmail("");
      setRole("User");
      setOpen(false);
    } catch {
      // Error toast is handled by the parent
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">{t("invite")}</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("invite")}</DialogTitle>
            <DialogDescription>{t("inviteDescription")}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div>
              <label
                htmlFor="invite-email"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                {t("inviteEmail")}
              </label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailError(null);
                }}
                placeholder="user@example.com"
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailError ? "invite-email-error" : undefined}
              />
              {emailError && (
                <p
                  id="invite-email-error"
                  className="mt-1 text-xs text-destructive"
                >
                  {emailError}
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="invite-role"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                {t("inviteRole")}
              </label>
              <Select
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="User">{t("roleUser")}</option>
                <option value="Manager">{t("roleManager")}</option>
              </Select>
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              disabled={sending}
              onClick={() => setOpen(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={sending}>
              {t("inviteSend")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
