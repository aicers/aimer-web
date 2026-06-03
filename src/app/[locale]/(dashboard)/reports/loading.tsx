import { OverviewSkeleton } from "@/components/overview/overview-rows";

// Shown while the Reports overview awaits the cross-customer fan-out (#391).
export default function Loading() {
  return <OverviewSkeleton />;
}
