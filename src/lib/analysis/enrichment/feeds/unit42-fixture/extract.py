# IDAPython helper (fixture sentinel) — a `.py` script the allowlist must NEVER
# fetch. If the engine ever reads this file, the binary/script-skip guard has
# regressed. It deliberately contains a domain-shaped token that must not appear
# in the snapshot: c2.should-never-be-fetched.test
print("unit42 fixture script — never parsed")
