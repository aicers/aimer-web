# Meta Threat Research (fixture)

A trimmed offline copy of `facebook/threat-research` used by the vendor-repo
engine tests so they run with no GitHub calls. Only `indicators/csv/**.csv`
files are allowlisted; this `.md` (and everything else below) is excluded and
must never be fetched: md-readme.should-never-be-fetched.test
