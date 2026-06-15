<?php
// Qakbot dropper template (fixture sentinel) — a `.php` the allowlist must NEVER
// fetch. If the engine ever reads this file, the binary/script-skip guard has
// regressed. It deliberately contains a domain-shaped token that must not appear
// in the snapshot: payload.should-never-be-fetched.test
echo "zscaler fixture php — never parsed";
