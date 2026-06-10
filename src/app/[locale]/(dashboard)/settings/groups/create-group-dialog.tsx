"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { ApiError, apiFetch } from "@/lib/api/client";
import type { GroupCostPreview, GroupEligibleMember } from "@/lib/api/types";

const GROUP_MIN_MEMBERS = 2;
const GROUP_MAX_MEMBERS = 10;

/** IANA zones offered in the timezone control (the runtime's own DB). */
function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  if (typeof intl.supportedValuesOf === "function") {
    return intl.supportedValuesOf("timeZone");
  }
  return [];
}

interface CreateGroupDialogProps {
  onCreated: () => void | Promise<void>;
}

export function CreateGroupDialog({ onCreated }: CreateGroupDialogProps) {
  const t = useTranslations("groupSettings");
  const tCommon = useTranslations("common");

  const timeZones = useMemo(() => supportedTimeZones(), []);

  const [open, setOpen] = useState(false);
  const [eligible, setEligible] = useState<GroupEligibleMember[] | null>(null);
  const [eligibleError, setEligibleError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tz, setTz] = useState("");
  const [tzTouched, setTzTouched] = useState(false);

  const [preview, setPreview] = useState<GroupCostPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setSelected(new Set());
    setName("");
    setDescription("");
    setTz("");
    setTzTouched(false);
    setPreview(null);
    setSubmitError(null);
  }, []);

  // Load the eligible member set when the dialog opens (operational customers
  // the caller manages, with their timezone). A pure UX pre-filter; the create
  // route re-validates authoritatively.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setEligible(null);
    setEligibleError(null);
    (async () => {
      try {
        const data = await apiFetch<{ customers: GroupEligibleMember[] }>(
          "/api/groups/eligible-members",
        );
        if (!cancelled) setEligible(data.customers);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          window.location.href = "/api/auth/sign-in";
          return;
        }
        setEligibleError(t("eligibleError"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  const selectedIds = useMemo(() => [...selected].sort(), [selected]);
  const count = selectedIds.length;
  const overCap = count > GROUP_MAX_MEMBERS;
  const withinRange = count >= GROUP_MIN_MEMBERS && count <= GROUP_MAX_MEMBERS;

  // The timezone members agree on (when they share one), else null — drives the
  // auto-fill. When they diverge the preview's `recommendedTz` is used instead.
  const sharedTz = useMemo(() => {
    if (!eligible || count === 0) return null;
    const tzs = new Set(
      eligible.filter((m) => selected.has(m.id)).map((m) => m.timezone),
    );
    return tzs.size === 1 ? [...tzs][0] : null;
  }, [eligible, selected, count]);

  // Preview the cost + tz recommendation whenever the (valid-range) member set
  // changes. Over-cap is annotated server-side, so still call when withinRange.
  useEffect(() => {
    if (!open || !withinRange) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    (async () => {
      try {
        const data = await apiFetch<GroupCostPreview>("/api/groups/preview", {
          method: "POST",
          body: JSON.stringify({ memberIds: selectedIds }),
        });
        if (!cancelled) setPreview(data);
      } catch {
        if (!cancelled) setPreview(null);
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, withinRange, selectedIds]);

  // Auto-fill the tz until the user edits it: the shared member tz when members
  // agree, else the preview recommendation. Editable afterward.
  const autoTz = sharedTz ?? preview?.recommendedTz ?? "";
  useEffect(() => {
    if (!tzTouched) setTz(autoTz);
  }, [autoTz, tzTouched]);

  function toggleMember(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function mapSubmitError(code: string): string {
    switch (code) {
      case "too_many_members":
        return t("errorTooManyMembers", { max: GROUP_MAX_MEMBERS });
      case "too_few_members":
        return t("errorTooFewMembers", { min: GROUP_MIN_MEMBERS });
      case "member_not_operational":
        return t("errorMemberNotOperational");
      case "member_not_found":
        return t("errorMemberNotFound");
      case "name_required":
        return t("errorNameRequired");
      case "invalid_timezone":
        return t("errorInvalidTimezone");
      default:
        return t("createError");
    }
  }

  const canSubmit =
    !submitting && withinRange && name.trim().length > 0 && tz.length > 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await apiFetch("/api/groups", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          memberIds: selectedIds,
          tz,
        }),
      });
      setOpen(false);
      resetForm();
      await onCreated();
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      setSubmitError(mapSubmitError(code));
    } finally {
      setSubmitting(false);
    }
  }

  const costUnavailable = preview?.overMemberCap || !preview;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetForm();
      }}
    >
      <DialogTrigger asChild>
        <Button>{t("createButton")}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription>{t("createDescription")}</DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-5">
            <div>
              <label
                htmlFor="group-name"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                {t("nameLabel")}
              </label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
              />
            </div>

            <div>
              <label
                htmlFor="group-description"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                {t("descriptionLabel")}
              </label>
              <Input
                id="group-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t("descriptionPlaceholder")}
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">
                  {t("membersLabel")}
                </span>
                <span
                  className={
                    overCap
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {t("membersSelected", {
                    count,
                    min: GROUP_MIN_MEMBERS,
                    max: GROUP_MAX_MEMBERS,
                  })}
                </span>
              </div>

              {eligibleError && (
                <p className="text-sm text-destructive">{eligibleError}</p>
              )}
              {!eligible && !eligibleError && (
                <p className="text-sm text-muted-foreground">
                  {tCommon("loading")}
                </p>
              )}
              {eligible && eligible.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("noEligibleMembers")}
                </p>
              )}
              {eligible && eligible.length > 0 && (
                <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {eligible.map((m) => (
                    <li key={m.id}>
                      <label className="flex items-center gap-2 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={selected.has(m.id)}
                          onChange={() => toggleMember(m.id)}
                          className="h-4 w-4 shrink-0 rounded border-border"
                        />
                        <span className="truncate">{m.name}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          {m.timezone}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {overCap && (
                <p className="mt-1 text-xs text-destructive">
                  {t("overCapHint", { max: GROUP_MAX_MEMBERS })}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="group-tz"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                {t("timezoneLabel")}
              </label>
              <Select
                id="group-tz"
                value={tz}
                onChange={(e) => {
                  setTz(e.target.value);
                  setTzTouched(true);
                }}
              >
                <option value="">{t("timezonePlaceholder")}</option>
                {timeZones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                {sharedTz
                  ? t("timezoneAutoHint")
                  : preview?.recommendedTz
                    ? t("timezoneRecommendedHint", {
                        tz: preview.recommendedTz,
                      })
                    : t("timezoneHelp")}
              </p>
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3">
              <h3 className="text-sm font-medium text-foreground">
                {t("costPreviewTitle")}
              </h3>
              {!withinRange ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("costPreviewSelectMembers", {
                    min: GROUP_MIN_MEMBERS,
                    max: GROUP_MAX_MEMBERS,
                  })}
                </p>
              ) : previewLoading ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {tCommon("loading")}
                </p>
              ) : costUnavailable ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("costPreviewUnavailable")}
                </p>
              ) : (
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">
                    {t("costRecentEvents")}
                  </dt>
                  <dd className="text-right text-foreground">
                    {preview?.combinedRecentEventVolume?.toLocaleString() ??
                      "—"}
                  </dd>
                  <dt className="text-muted-foreground">
                    {t("costMonthlyTokens")}
                  </dt>
                  <dd className="text-right text-foreground">
                    {preview?.estimatedMonthlyTokens?.toLocaleString() ?? "—"}
                  </dd>
                  <dt className="text-muted-foreground">
                    {t("costMonthlyUsd")}
                  </dt>
                  <dd className="text-right text-foreground">
                    {preview?.estimatedMonthlyCostUsd != null
                      ? `$${preview.estimatedMonthlyCostUsd.toFixed(2)}`
                      : "—"}
                  </dd>
                </dl>
              )}
            </div>

            {submitError && (
              <p className="text-sm text-destructive">{submitError}</p>
            )}
          </div>

          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setOpen(false);
                resetForm();
              }}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {t("createConfirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
