/* YARA rule file — excluded by the allowlist (signatures/yara/), never fetched. */
rule meta_fixture_sentinel
{
    strings:
        $a = "yara-rule.should-never-be-fetched.test"
    condition:
        $a
}
