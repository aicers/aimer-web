-- Make pending_analysis_requests.lang nullable (issue #281).
--
-- aimer's `Mutation.analyzeEvent` SDL declares `lang: Language`
-- (nullable, not `Language!`). The BFF preserves caller-supplied
-- absence end-to-end so aimer applies its server-side default
-- (ENGLISH, per the SDL doc) rather than the BFF substituting its
-- own. The verified `analyze_params_token` claim is nullable on the
-- TypeScript side and the PAR row must carry the same shape so a
-- `/continue` GET after OIDC can pass `undefined` into runAnalyzeFlow.
--
-- Pre-existing rows are bounded by the 5-minute PAR TTL + 24h grace
-- window, so any in-flight row at deploy time will already have a
-- concrete `lang` value populated by the prior code; the DROP NOT
-- NULL is purely permissive for future rows.

ALTER TABLE pending_analysis_requests ALTER COLUMN lang DROP NOT NULL;
