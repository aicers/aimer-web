"use client";

import { Tooltip as RadixTooltip } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

function TooltipProvider(
  props: React.ComponentProps<typeof RadixTooltip.Provider>,
) {
  return <RadixTooltip.Provider delayDuration={300} {...props} />;
}

function Tooltip(props: React.ComponentProps<typeof RadixTooltip.Root>) {
  return <RadixTooltip.Root {...props} />;
}

function TooltipTrigger(
  props: React.ComponentProps<typeof RadixTooltip.Trigger>,
) {
  return <RadixTooltip.Trigger {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof RadixTooltip.Content>) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-md",
          className,
        )}
        {...props}
      />
    </RadixTooltip.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
