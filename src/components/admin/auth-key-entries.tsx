"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { adminFetch } from "@/lib/api/admin-client";
import { ApiError } from "@/lib/api/client";

// ---------------------------------------------------------------------------
// Shared write-only secret (Auth-Key) entry list + dialog (#651)
// ---------------------------------------------------------------------------
//
// Extracted from the inline pattern #650 grew on the Threat Feeds page so BOTH
// `/admin/ti-feeds` (URLhaus Auth-Key + optional GitHub token) and
// `/admin/cve-feeds` (optional NVD API key) drive their secret entries from one
// component instead of duplicating the entry UI. Each entry is write-only and
// status-driven: the set/unset display comes from a `isAuthKeySet(keyName)`
// presence check (never the value); there is no clear/delete action (no API
// removes a stored secret today). The differing request body field name between
// the two endpoints (`authKey` vs `apiKey`) is the `valueField` prop.

/** One write-only secret entry's labels (all already localized by the caller). */
export interface AuthKeyEntry {
  /** `feed_source_secret.key_name` this entry sets (e.g. `urlhaus`, `nvd`). */
  keyName: string;
  title: string;
  description: string;
  placeholder: string;
  setMessage: string;
  unsetMessage: string;
  setButton: string;
  replaceButton: string;
  savedMessage: string;
  errorMessage: string;
}

export function AuthKeyEntries({
  entries,
  isAuthKeySet,
  endpoint,
  valueField,
  onSaved,
  showToast,
}: {
  entries: AuthKeyEntry[];
  /** Whether a given key is currently stored (presence only — never the value). */
  isAuthKeySet: (keyName: string) => boolean;
  /** The `PUT` endpoint the secret is written to. */
  endpoint: string;
  /** JSON body field carrying the secret value (`authKey` for TI, `apiKey` for NVD). */
  valueField: string;
  /** Refresh the status after a successful save. */
  onSaved: () => void | Promise<void>;
  showToast: (message: string, type: "success" | "error") => void;
}) {
  const tCommon = useTranslations("common");

  // The entry whose set/replace dialog is open (null = closed), mirroring the
  // original `activeAuthKeyName` state.
  const [activeKeyName, setActiveKeyName] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const activeEntry = entries.find((e) => e.keyName === activeKeyName) ?? null;

  const handleSave = async () => {
    if (!activeEntry || value.length === 0) return;
    setSaving(true);
    try {
      await adminFetch(endpoint, {
        method: "PUT",
        body: JSON.stringify({
          keyName: activeEntry.keyName,
          [valueField]: value,
        }),
      });
      setActiveKeyName(null);
      setValue("");
      showToast(activeEntry.savedMessage, "success");
      await onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = "/api/admin-auth/sign-in";
        return;
      }
      showToast(
        err instanceof ApiError ? err.message : activeEntry.errorMessage,
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="space-y-3">
        {entries.map((entry) => {
          const keySet = isAuthKeySet(entry.keyName);
          return (
            <div
              key={entry.keyName}
              className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium text-foreground">
                  {entry.title}
                </p>
                <p className="text-xs text-muted-foreground">
                  {keySet ? entry.setMessage : entry.unsetMessage}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setActiveKeyName(entry.keyName)}
              >
                {keySet ? entry.replaceButton : entry.setButton}
              </Button>
            </div>
          );
        })}
      </div>

      <Dialog
        open={activeEntry !== null}
        onOpenChange={(open) => {
          if (!open) {
            setActiveKeyName(null);
            setValue("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{activeEntry?.title}</DialogTitle>
            <DialogDescription>{activeEntry?.description}</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <input
              type="password"
              aria-label={activeEntry?.title}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={activeEntry?.placeholder}
              className="block w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={saving}>
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button
              type="button"
              disabled={saving || value.length === 0}
              onClick={handleSave}
            >
              {saving ? tCommon("loading") : tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
