import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

import { atomicWriteText } from "../atomic-file.js";
import { validateAgentId } from "../ids.js";

const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export class FederationError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "FederationError";
    this.exitCode = exitCode;
  }
}

export interface PeerRecord {
  domain: string;
  base_url: string;
  token_hash: string;
  previous_token_hash: string;
  outbound_token: string;
  pull_enabled: boolean;
  push_enabled: boolean;
  status: string;
  label: string;
  /** PEM bundle pinned when calling this peer; "" = system trust store. */
  ca_file: string;
}

const MAX_CA_FILE_BYTES = 1024 * 1024;

/** Validate a peer CA path: absolute, real regular file, bounded size. */
export function validateCaFile(caFile: string): string {
  const resolved = path.resolve(caFile.trim());
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new FederationError(`peer ca_file not found: ${resolved}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new FederationError(`peer ca_file must be a real file: ${resolved}`);
  }
  if (stat.size < 1 || stat.size > MAX_CA_FILE_BYTES) {
    throw new FederationError(
      `peer ca_file must be non-empty and at most ${MAX_CA_FILE_BYTES} bytes`,
    );
  }
  return resolved;
}

/**
 * Read the pinned CA for a peer at call time so rotating the file on disk does
 * not require re-adding the peer. Returns null when the peer uses system trust.
 */
export function loadPeerCa(peer: PeerRecord): Buffer | null {
  if (!peer.ca_file) return null;
  const resolved = validateCaFile(peer.ca_file);
  try {
    return fs.readFileSync(resolved);
  } catch {
    throw new FederationError(`peer ca_file could not be read: ${resolved}`);
  }
}

function peersPath(home: string) {
  return path.join(home, "auth", "federation_peers.json");
}
function outboundPath(home: string) {
  return path.join(home, "auth", "federation_outbound.json");
}
function configPath(home: string) {
  return path.join(home, "auth", "federation_config.json");
}

function ensurePrivateAuthDirectory(home: string): string {
  const directory = path.join(home, "auth");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new FederationError(`federation auth path must be a real directory: ${directory}`);
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  return directory;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function validateDomain(domain: string): string {
  const value = domain.trim().toLowerCase().replace(/^@/, "");
  if (!DOMAIN_RE.test(value) || value.includes("..")) {
    throw new FederationError(`invalid hub domain: ${JSON.stringify(domain)}`);
  }
  return value;
}

export function validateBaseUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new FederationError(`peer base_url invalid: ${baseUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new FederationError("peer base_url must be https:// (or http:// loopback lab)");
  }
  const host = (parsed.hostname || "").toLowerCase();
  if (parsed.protocol === "http:" && !LOOPBACK.has(host)) {
    throw new FederationError("peer base_url must be https:// (http only for loopback)");
  }
  if (parsed.username || parsed.password) {
    throw new FederationError("peer base_url must not embed credentials");
  }
  return base;
}

export function parseAgentDomain(agentId: string): { name: string; domain: string } {
  const id = validateAgentId(agentId);
  const at = id.lastIndexOf("@");
  return { name: id.slice(0, at), domain: id.slice(at + 1).toLowerCase() };
}

export function loadLocalDomain(home: string): string | null {
  const p = configPath(home);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { local_domain?: string };
    return raw.local_domain ? validateDomain(raw.local_domain) : null;
  } catch {
    return null;
  }
}

export function setLocalDomain(home: string, domain: string): string {
  const d = validateDomain(domain);
  const p = configPath(home);
  ensurePrivateAuthDirectory(home);
  atomicWriteText(
    p,
    JSON.stringify({ schema_version: 1, local_domain: d }, null, 2) + "\n",
    0o600,
  );
  return d;
}

function loadOutboundMap(home: string): Record<string, string> {
  const p = outboundPath(home);
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
      tokens?: Record<string, string>;
    };
    return raw.tokens && typeof raw.tokens === "object" ? { ...raw.tokens } : {};
  } catch {
    return {};
  }
}

function saveOutboundMap(home: string, tokens: Record<string, string>): void {
  const p = outboundPath(home);
  ensurePrivateAuthDirectory(home);
  atomicWriteText(
    p,
    JSON.stringify({ schema_version: 1, tokens }, null, 2) + "\n",
    0o600,
  );
}

export function loadPeers(home: string): PeerRecord[] {
  const p = peersPath(home);
  if (!fs.existsSync(p)) return [];
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
    peers?: Array<Record<string, unknown>>;
  };
  if (!raw.peers || !Array.isArray(raw.peers)) {
    throw new FederationError(`invalid federation peers: ${p}`);
  }
  const outbound = loadOutboundMap(home);
  return raw.peers.map((item) => {
    const domain = validateDomain(String(item.domain || ""));
    return {
      domain,
      base_url: String(item.base_url || "").replace(/\/$/, ""),
      token_hash: String(item.token_hash || ""),
      previous_token_hash: String(item.previous_token_hash || ""),
      outbound_token: outbound[domain] || "",
      pull_enabled: item.pull_enabled !== false,
      push_enabled: Boolean(item.push_enabled),
      status: String(item.status || "active"),
      label: String(item.label || ""),
      ca_file: String(item.ca_file || ""),
    };
  });
}

function savePeersFile(home: string, peers: PeerRecord[]): void {
  const p = peersPath(home);
  ensurePrivateAuthDirectory(home);
  const payload = {
    schema_version: 1,
    peers: peers.map((peer) => ({
      domain: peer.domain,
      base_url: peer.base_url,
      token_hash: peer.token_hash,
      previous_token_hash: peer.previous_token_hash,
      pull_enabled: peer.pull_enabled,
      push_enabled: peer.push_enabled,
      status: peer.status,
      label: peer.label,
      ca_file: peer.ca_file,
    })),
  };
  atomicWriteText(p, JSON.stringify(payload, null, 2) + "\n", 0o600);
}

/** Add peer; returns plaintext inbound token for the peer to use when calling us. */
export function addPeer(
  home: string,
  opts: {
    domain: string;
    base_url: string;
    push_enabled?: boolean;
    pull_enabled?: boolean;
    label?: string;
    /** Token we use when calling them (their inbound). */
    outbound_token?: string;
    /** PEM bundle pinned when calling this peer over https. */
    ca_file?: string;
  },
): { inbound_token: string; peer: PeerRecord } {
  const domain = validateDomain(opts.domain);
  const base_url = validateBaseUrl(opts.base_url);
  const ca_file = opts.ca_file ? validateCaFile(opts.ca_file) : "";
  const inbound = generateToken();
  const peers = loadPeers(home).filter((p) => p.domain !== domain);
  const peer: PeerRecord = {
    domain,
    base_url,
    token_hash: hashToken(inbound),
    previous_token_hash: "",
    outbound_token: opts.outbound_token || "",
    pull_enabled: opts.pull_enabled !== false,
    push_enabled: Boolean(opts.push_enabled),
    status: "active",
    label: opts.label || "",
    ca_file,
  };
  peers.push(peer);
  savePeersFile(home, peers);
  if (opts.outbound_token) {
    const map = loadOutboundMap(home);
    map[domain] = opts.outbound_token;
    saveOutboundMap(home, map);
  }
  return { inbound_token: inbound, peer: { ...peer, outbound_token: opts.outbound_token || "" } };
}

export function setPeerOutboundToken(home: string, domain: string, token: string): void {
  const d = validateDomain(domain);
  const map = loadOutboundMap(home);
  map[d] = token;
  saveOutboundMap(home, map);
}

/** Pin (or clear with "") the CA used when calling an existing peer. */
export function setPeerCaFile(home: string, domain: string, caFile: string): PeerRecord {
  const d = validateDomain(domain);
  const resolved = caFile.trim() ? validateCaFile(caFile) : "";
  const peers = loadPeers(home);
  const peer = peers.find((p) => p.domain === d);
  if (!peer) throw new FederationError(`no peer for domain ${d}`);
  peer.ca_file = resolved;
  savePeersFile(home, peers);
  return peer;
}

export function getPeer(home: string, domain: string): PeerRecord | null {
  const d = validateDomain(domain);
  return loadPeers(home).find((p) => p.domain === d) ?? null;
}

export function isForeignRecipient(home: string, agentId: string): boolean {
  const local = loadLocalDomain(home);
  if (!local) return false;
  const { domain } = parseAgentDomain(agentId);
  return domain !== local && domain !== "local";
}

export function requirePeerForDomain(home: string, domain: string): PeerRecord {
  const peer = getPeer(home, domain);
  if (!peer || peer.status !== "active") {
    throw new FederationError(`no active peer for domain ${domain}`);
  }
  return peer;
}

export function authenticatePeer(home: string, authorization: string | null | undefined): string {
  if (!authorization || !authorization.toLowerCase().startsWith("bearer ")) {
    throw new FederationError("missing peer bearer", 2);
  }
  const token = authorization.slice(7).trim();
  if (!token) throw new FederationError("missing peer bearer", 2);
  const dig = Buffer.from(hashToken(token), "utf8");
  for (const peer of loadPeers(home)) {
    for (const h of [peer.token_hash, peer.previous_token_hash]) {
      if (!h) continue;
      const rec = Buffer.from(h, "utf8");
      if (rec.length === dig.length && timingSafeEqual(rec, dig)) {
        return peer.domain;
      }
    }
  }
  throw new FederationError("unknown peer bearer", 2);
}
