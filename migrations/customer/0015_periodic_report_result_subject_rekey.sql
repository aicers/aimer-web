-- RFC 0004 (#503) — re-key `periodic_report_result` onto subject
-- identity.
--
-- This table lives in each customer/subject database (not the auth DB),
-- so the periodic re-key spans both migration trees. The PK and the
-- `periodic_report_result_bucket_idx` index follow the column rename
-- automatically. Only `periodic_report_result` is re-keyed here — the
-- neighbouring story/event result tables defined in
-- `0007_analysis_result_tables.sql` stay `customer_id`-keyed (#503
-- scope line).
--
-- For a customer, `subject_id == customer_id` (same UUID), so existing
-- rows keep working under the new key with no data change. Forward-only;
-- never edit an applied migration (checksum-guarded — migrations/README.md).

ALTER TABLE periodic_report_result
    RENAME COLUMN customer_id TO subject_id;
