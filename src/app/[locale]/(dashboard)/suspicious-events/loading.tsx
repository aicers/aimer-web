import { OverviewSkeleton } from "@/components/overview/overview-rows";

// Shown while the Suspicious Events overview awaits the cross-customer fan-out.
export default function Loading() {
  return <OverviewSkeleton />;
}
