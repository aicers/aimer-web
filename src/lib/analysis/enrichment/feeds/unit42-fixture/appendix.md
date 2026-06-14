# CL-STA-0910 host artifacts (fixture)

The "indicators" in these narrative appendices are host artifacts, not network
IOCs, so the allowlist EXCLUDES `.md` from parsing. None of the values below
must ever reach the snapshot:

- Dropped file: `C:\Users\Public\loader.exe`
- Registry: `HKCU\Software\Unit42Fixture\Run`
- Loaded module: `not-a-real.dll`
- Mutex: `Global\unit42-fixture-mutex`
