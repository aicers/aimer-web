rule Snake_Loader {
    meta:
        description = "Sigma/YARA-style rule file (fixture) — skipped, not an IOC source"
    strings:
        $a = "snake_loader"
        $b = { 6A 40 68 00 30 00 00 }
    condition:
        $a and $b
}
