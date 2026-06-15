# Volexity fixture sentinel — a `scripts/` tool (`.py`) the allowlist must
# NEVER fetch. If the engine reads this file, the script-skip guard regressed.
# It deliberately contains a domain-shaped token that must not reach the
# snapshot: script.should-never-be-fetched.test
print("volexity fixture script — never parsed")
