"use client";

import { Dialog } from "radix-ui";
import type * as React from "react";

import { SIDEBAR_WIDTH_EXPANDED } from "@/components/layout-constants";
import { cn } from "@/lib/utils";

function Sheet(props: React.ComponentProps<typeof Dialog.Root>) {
  return <Dialog.Root {...props} />;
}

function SheetTrigger(props: React.ComponentProps<typeof Dialog.Trigger>) {
  return <Dialog.Trigger {...props} />;
}

function SheetClose(props: React.ComponentProps<typeof Dialog.Close>) {
  return <Dialog.Close {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof Dialog.Overlay>) {
  return (
    <Dialog.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:hidden",
        className,
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "left",
  ...props
}: React.ComponentProps<typeof Dialog.Content> & {
  side?: "left" | "right";
}) {
  return (
    <Dialog.Portal>
      <SheetOverlay />
      <Dialog.Content
        className={cn(
          `fixed inset-y-0 z-50 flex ${SIDEBAR_WIDTH_EXPANDED} flex-col bg-[var(--sidebar-bg)] shadow-lg data-[state=closed]:hidden`,
          side === "left" ? "left-0" : "right-0",
          className,
        )}
        {...props}
      >
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  );
}

export { Sheet, SheetClose, SheetContent, SheetOverlay, SheetTrigger };
