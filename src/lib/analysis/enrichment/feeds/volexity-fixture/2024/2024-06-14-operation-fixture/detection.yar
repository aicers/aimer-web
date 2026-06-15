/*
 * Volexity fixture sentinel — a YARA rule file (`.yar`) the allowlist must
 * NEVER fetch (rules are not IOCs). It deliberately contains a domain-shaped
 * token that must not reach the snapshot: yara.should-never-be-fetched.test
 */
rule volexity_fixture_sentinel
{
    strings:
        $a = "never parsed"
    condition:
        $a
}
