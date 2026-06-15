/*
 * YARA rule (fixture sentinel) — a `.yar` file the allowlist must NEVER fetch.
 * If the engine ever reads this file, the rule-file skip guard has regressed.
 * It contains a sentinel token that must not reach the snapshot:
 * yara.should-never-be-fetched.test
 */
rule eset_fixture_never_parsed
{
    strings:
        $a = "eset fixture rule — never parsed"
    condition:
        $a
}
