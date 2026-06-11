// Friendly display names for upstream event kinds (#552).
//
// The stored `event_analysis_result.kind` is the raw upstream `__typename`
// (e.g. `HttpThreat`, `BlocklistHttp`) — the same value aice-web-next holds.
// To keep aimer-web's row labels identical to aice-web-next's, this map is a
// VERBATIM PORT of `EVENT_KIND_FRIENDLY_NAMES` in aice-web-next's
// `src/components/events/event-display-helpers.ts`. Keep the two copies in
// sync: when aice-web-next adds, removes, or renames a kind, mirror it here.
//
// English-only by design (matching aice-web-next #746): localizing the ~40
// kind names per language is explicitly out of scope, so this map is shared
// across every locale. Store the raw `kind` in the DB; map to the friendly
// name only at render, and fall back to the raw `kind` for any value absent
// from the map (kinds aice-web-next has not curated, or a non-`__typename`
// manual value).
export const EVENT_KIND_FRIENDLY_NAMES: Record<string, string> = {
  BlocklistBootp: "Blocklist BOOTP",
  BlocklistConn: "Blocklist Connection",
  BlocklistDceRpc: "Blocklist DCE/RPC",
  BlocklistDhcp: "Blocklist DHCP",
  BlocklistDns: "Blocklist DNS",
  BlocklistFtp: "Blocklist FTP",
  BlocklistHttp: "Blocklist HTTP",
  BlocklistKerberos: "Blocklist Kerberos",
  BlocklistLdap: "Blocklist LDAP",
  BlocklistMalformedDns: "Blocklist Malformed DNS",
  BlocklistMqtt: "Blocklist MQTT",
  BlocklistNfs: "Blocklist NFS",
  BlocklistNtlm: "Blocklist NTLM",
  BlocklistRadius: "Blocklist RADIUS",
  BlocklistRdp: "Blocklist RDP",
  BlocklistSmb: "Blocklist SMB",
  BlocklistSmtp: "Blocklist SMTP",
  BlocklistSsh: "Blocklist SSH",
  BlocklistTls: "Blocklist TLS",
  CryptocurrencyMiningPool: "Cryptocurrency Mining Pool",
  DnsCovertChannel: "DNS Covert Channel",
  DomainGenerationAlgorithm: "Domain Generation Algorithm",
  ExternalDdos: "External DDoS",
  ExtraThreat: "Extra Threat",
  FtpBruteForce: "FTP Brute Force",
  FtpPlainText: "FTP Plain Text",
  HttpThreat: "HTTP Threat",
  LdapBruteForce: "LDAP Brute Force",
  LdapPlainText: "LDAP Plain Text",
  LockyRansomware: "Locky Ransomware",
  MultiHostPortScan: "Multi-Host Port Scan",
  NetworkThreat: "Network Threat",
  NonBrowser: "Non-Browser",
  PortScan: "Port Scan",
  RdpBruteForce: "RDP Brute Force",
  RepeatedHttpSessions: "Repeated HTTP Sessions",
  SuspiciousTlsTraffic: "Suspicious TLS Traffic",
  TorConnection: "Tor Connection",
  TorConnectionConn: "Tor Connection (Conn)",
  UnusualDestinationPattern: "Unusual Destination Pattern",
  WindowsThreat: "Windows Threat",
};

/**
 * The friendly display name for a stored upstream `kind`, falling back to the
 * raw `kind` for any value absent from {@link EVENT_KIND_FRIENDLY_NAMES}
 * (matches aice-web-next exactly). Returns `null` when `kind` is null so
 * callers render the time-only title.
 */
export function eventKindDisplayName(kind: string | null): string | null {
  if (kind === null) return null;
  return EVENT_KIND_FRIENDLY_NAMES[kind] ?? kind;
}
