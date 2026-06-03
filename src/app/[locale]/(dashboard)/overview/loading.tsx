import { OverviewSkeleton } from "@/components/overview/overview-rows";

// Shown while the combined landing awaits the cross-customer fan-out (#391).
export default function Loading() {
  return <OverviewSkeleton rows={6} />;
}
