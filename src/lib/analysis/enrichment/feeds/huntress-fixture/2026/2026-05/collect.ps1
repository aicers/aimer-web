# Helper script — NOT an atomic IOC source. The sentinel address below must
# never reach the snapshot (this file matches no allowlist rule, so it is never
# fetched).
$target = "203.0.113.200"
Write-Output "would contact $target / script-sentinel.example"
