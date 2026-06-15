rule Huntress_Loader
{
    // Detection logic only — NOT atomic IOCs. The sentinel host below must never
    // be imported (this file matches no allowlist rule, so it is never fetched).
    meta:
        author = "fixture"
        reference = "never-fetched-host.example"
    strings:
        $a = "loader" ascii
        $ip = "10.10.10.10"
    condition:
        all of them
}
