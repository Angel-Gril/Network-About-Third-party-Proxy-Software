import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dnsQuestion, dnsAddresses, entryBinding, resolveFlyBirdEntries, usableEntryAddress } from "../src/flybird-entries.mjs";

const now = Date.parse("2026-01-02T12:00:00Z");
const ip = "2606:4700:4700::1111";
const nodes = [1, 2].map(i => ({ name: `Japan-${i}`, type: "anytls", server: "entry.example.invalid",
  port: 14000 + i, password: "synthetic-password", sni: `tls-${i}.example.invalid`,
  "client-fingerprint": "chrome", "ip-version": "ipv6-prefer", udp: true }));
const document = () => ({ ipv6: true, dns: { ipv6: true }, proxies: structuredClone(nodes),
  "proxy-groups": [{ name: "PROXY", type: "select", proxies: nodes.map(n => n.name) }], rules: ["MATCH,PROXY"] });
const failed = async () => { throw new Error("synthetic DNS failure"); };
function cached(age = 1000) {
  return { schemaVersion: 1, hosts: { "entry.example.invalid": {
    addresses: [ip], binding: entryBinding(nodes), observedAt: new Date(now - age).toISOString(), source: "operator-verified" } } };
}

test("preserves authentication, SNI, policy and cache observation time during an outage", async () => {
  const input = document(), state = cached(), before = structuredClone(state);
  const result = await resolveFlyBirdEntries(YAML.stringify(input), { now, state, lookup: failed });
  const actual = YAML.parse(result.yaml);
  assert.deepEqual(actual, { ...input, proxies: input.proxies.map(node => ({ ...node, server: ip })) });
  assert.deepEqual(state, before, "caller cache is not mutated");
  assert.equal(result.state.hosts[nodes[0].server].observedAt, state.hosts[nodes[0].server].observedAt);
  assert.equal(result.metadata.cachedHostCount, 1);
  assert.equal(result.metadata.ipv6OnlyHostCount, 1);
  assert.equal(result.metadata.changedServerCount, 2);
});

test("refuses missing, expired, future and mismatched recovery identities", async () => {
  for (const state of [{ schemaVersion: 1, hosts: {} }, cached(25 * 3600000), cached(-1000)]) {
    await assert.rejects(resolveFlyBirdEntries(YAML.stringify(document()), { now, state, lookup: failed }), /publication refused/);
  }
  for (const [field, value] of [["password", "another-account"], ["port", 24443], ["sni", "changed.example.invalid"], ["type", "trojan"]]) {
    const input = document(); input.proxies[0][field] = value;
    await assert.rejects(resolveFlyBirdEntries(YAML.stringify(input), { now, state: cached(), lookup: failed }), /publication refused/);
  }
});

test("uses actual DoH answers before public lookup and refreshes observation only on success", async () => {
  const input = document(); input.dns["proxy-server-nameserver"] = ["https://private-dns.example.invalid/query"];
  const result = await resolveFlyBirdEntries(YAML.stringify(input), { now, state: cached(),
    lookup: () => { assert.fail("public DNS must not override the private answer"); },
    dohLookup: async (_endpoint, host, type) => { assert.equal(host, nodes[0].server); return type === 28 ? [ip] : []; } });
  assert.equal(result.metadata.liveHostCount, 1);
  assert.equal(result.metadata.cachedHostCount, 0);
  assert.equal(result.state.hosts[nodes[0].server].observedAt, new Date(now).toISOString());
});

test("private-zone outages retain the verified mapping ahead of unrelated public answers", async () => {
  const input = document(); input.dns["proxy-server-nameserver"] = ["https://private.example.invalid/dns"];
  const result = await resolveFlyBirdEntries(YAML.stringify(input), { now, state: cached(), dohLookup: failed,
    lookup: () => assert.fail("do not overwrite a verified private mapping with a public resolver") });
  assert.equal(result.metadata.cachedHostCount, 1);
  assert.equal(YAML.parse(result.yaml).proxies[0].server, ip);
});

test("a private-zone outage rejects public candidates that fail node TLS validation", async () => {
  const input = document(); input.dns["proxy-server-nameserver"] = ["https://private.example.invalid/dns"];
  let calls = 0;
  await assert.rejects(resolveFlyBirdEntries(YAML.stringify(input), { now, dohLookup: failed,
    lookup: async () => { calls++; return [{ address: "93.184.216.34" }]; }, probeAddress: async () => false,
  }), /publication refused/);
  assert.equal(calls, 1);
});

test("a configured private DoH does not block TLS-validated public fallback and caching", async () => {
  const input = document(); input.dns["proxy-server-nameserver"] = ["https://private.example.invalid/dns"];
  const checked = [];
  const result = await resolveFlyBirdEntries(YAML.stringify(input), { now, dohLookup: failed, addressMode: "hosts", requireIPv4: true,
    lookup: async () => [{ address: "198.18.2.3" }, { address: "93.184.216.34" }],
    probeAddress: async (address, host, proxies) => { checked.push(address); assert.equal(host, nodes[0].server);
      assert.deepEqual(proxies, nodes); return true; },
  });
  assert.deepEqual(checked, ["93.184.216.34"]);
  assert.deepEqual(YAML.parse(result.yaml).proxies, nodes);
  assert.deepEqual(result.state.hosts[nodes[0].server].addresses, ["93.184.216.34"]);
  assert.equal(result.state.hosts[nodes[0].server].source, "public-dns-tls-validated");
  assert.equal(result.metadata.publicFallbackHostCount, 1);
  assert.equal(result.metadata.tlsValidatedPublicAddressCount, 1);
});

test("explicit public resolvers can recover a failed system lookup without retrying rejected IPs", async () => {
  const input = document(); input.dns["proxy-server-nameserver"] = ["https://private.example.invalid/dns"];
  input.dns["default-nameserver"] = ["https://9.9.9.9/dns-query", "https://1.1.1.1/dns-query"];
  const checked = [];
  const result = await resolveFlyBirdEntries(YAML.stringify(input), { now, dohLookup: failed,
    lookup: async () => [{ address: "93.184.216.35" }],
    publicDohLookup: async (endpoint, _host, type) => type === 1
      ? endpoint.includes("9.9.9.9") ? ["93.184.216.35"] : ["93.184.216.34"] : [],
    probeAddress: async address => { checked.push(address); return address === "93.184.216.34"; },
  });
  assert.deepEqual(checked, ["93.184.216.35", "93.184.216.34"]);
  assert.equal(result.metadata.publicFallbackHostCount, 1);
});

test("host-map output preserves both address families and every original node field", async () => {
  const input = document(); input.hosts = { "other.example.invalid": "93.184.216.35" };
  const result = await resolveFlyBirdEntries(YAML.stringify(input), { now, addressMode: "hosts", requireIPv4: true,
    lookup: async () => [{ address: "93.184.216.34" }, { address: ip }],
  });
  const parsed = YAML.parse(result.yaml);
  assert.deepEqual(parsed.proxies, input.proxies);
  assert.deepEqual(parsed.hosts, { ...input.hosts, [nodes[0].server]: ["93.184.216.34", ip] });
  assert.equal(parsed.dns["use-hosts"], true);
  assert.equal(parsed.dns.ipv6, true);
  assert.equal(result.metadata.addressMode, "hosts");
  assert.equal(result.metadata.changedServerCount, 0);
});

test("invalid host-map output cannot bypass address validation", async () => {
  const input = document(); input.hosts = [];
  await assert.rejects(resolveFlyBirdEntries(YAML.stringify(input), { addressMode: "hosts" }), /hosts mapping/);
  await assert.rejects(resolveFlyBirdEntries(YAML.stringify(document()), { addressMode: "unknown" }), /address mode/);
});

test("preserves implicit TLS hostname when replacing a server with an IP", async () => {
  const input = document(); delete input.proxies[0].sni;
  const result = await resolveFlyBirdEntries(YAML.stringify(input), { now, lookup: async () => [{ address: "93.184.216.34" }, { address: ip }] });
  const parsed = YAML.parse(result.yaml);
  assert.equal(parsed.proxies[0].sni, nodes[0].server);
  assert.equal(parsed.proxies[0].server, "93.184.216.34");
  assert.equal(parsed.proxies[0]["skip-cert-verify"], undefined);
});

test("rejects synthetic, local and documentation addresses, including expanded IPv6", async () => {
  for (const value of ["198.18.1.2", "198.19.1.2", "2001:2::1", "2001:0002::1", "2001:db8::1", "192.0.2.2", "10.0.0.1", "127.0.0.1", "fdfe:dcba::1", "::ffff:93.184.216.34"]) {
    assert.equal(usableEntryAddress(value), false, value);
  }
  assert.equal(usableEntryAddress("192.0.78.24"), true);
  await assert.rejects(resolveFlyBirdEntries(YAML.stringify(document()), { now, lookup: async () => [{ address: "198.18.2.3" }] }), /publication refused/);
});

test("does not return a partially rewritten subscription or modify state", async () => {
  const input = document(); input.proxies[1].server = "new.example.invalid";
  const state = cached(), before = structuredClone(state);
  await assert.rejects(resolveFlyBirdEntries(YAML.stringify(input), { now, state, lookup: failed }), /publication refused/);
  assert.deepEqual(state, before);
});

test("rate limits stop the resolver batch rather than trying other endpoints or renewing cache", async () => {
  const input = document(); input.dns["proxy-server-nameserver"] = ["https://one.example.invalid/dns", "https://two.example.invalid/dns"];
  const calls = [];
  await assert.rejects(resolveFlyBirdEntries(YAML.stringify(input), { now, state: cached(),
    dohLookup: async endpoint => { calls.push(endpoint); throw Object.assign(new Error("limited"), { code: "UPSTREAM_RATE_LIMIT" }); },
    lookup: () => assert.fail("must not continue after provider throttling"),
  }), /rate limited/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(value => value.includes("one.example.invalid")));
});

test("invalid cache age cannot accidentally disable expiration", async () => {
  for (const maxAgeMs of [NaN, Infinity, -1, 8 * 86400000]) {
    await assert.rejects(resolveFlyBirdEntries(YAML.stringify(document()), { now, state: cached(), lookup: failed, maxAgeMs }), /cache age/);
  }
});

test("IPv6-only recovery cannot pass the IPv4 publication gate", async () => {
  await assert.rejects(resolveFlyBirdEntries(YAML.stringify(document()), {
    now, state: cached(), lookup: failed, requireIPv4: true,
  }), /no validated IPv4/);
  const result = await resolveFlyBirdEntries(YAML.stringify(document()), {
    now, lookup: async () => [{ address: "93.184.216.34" }, { address: ip }], requireIPv4: true,
  });
  assert.equal(YAML.parse(result.yaml).proxies[0].server, "93.184.216.34");
  const literal = document(); literal.proxies = [{ ...literal.proxies[0], server: ip }];
  await assert.rejects(resolveFlyBirdEntries(YAML.stringify(literal), { requireIPv4: true }), /no validated IPv4/);
  const mobile = await resolveFlyBirdEntries(YAML.stringify(literal), { requireIPv4: false });
  assert.equal(mobile.metadata.ipv6OnlyHostCount, 1);
  assert.equal(mobile.metadata.upstreamLiteralHostCount, 1);
});

test("CLI failure leaves existing output, cache and metadata untouched", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "entry-cli-"));
  try {
    const input = document(); input.proxies[0].server = "198.18.1.2";
    const files = Object.fromEntries(["input", "output", "state", "metadata"].map(key => [key, path.join(root, key)]));
    await fs.writeFile(files.input, YAML.stringify(input));
    const original = { output: "old-output", state: JSON.stringify({ schemaVersion: 1, hosts: {} }), metadata: "old-metadata" };
    for (const key of ["output", "state", "metadata"]) await fs.writeFile(files[key], original[key]);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/flybird-entries.mjs", import.meta.url)),
      "--in", files.input, "--out", files.output, "--state", files.state, "--metadata", files.metadata], { encoding: "utf8" });
    assert.equal(result.status, 1);
    for (const key of ["output", "state", "metadata"]) assert.equal(await fs.readFile(files[key], "utf8"), original[key]);
    assert.equal((await fs.readdir(root)).length, 4);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("CLI default IPv4 policy refuses an IPv6-only source before replacing files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "entry-ipv4-gate-"));
  try {
    const input = document(); input.proxies = [{ ...input.proxies[0], server: ip }];
    const file = name => path.join(root, name);
    await fs.writeFile(file("input"), YAML.stringify(input));
    await fs.writeFile(file("state"), JSON.stringify({ schemaVersion: 1, hosts: {} }));
    await fs.writeFile(file("output"), "keep-output");
    await fs.writeFile(file("metadata"), "keep-metadata");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/flybird-entries.mjs", import.meta.url)),
      "--in", file("input"), "--out", file("output"), "--state", file("state"), "--metadata", file("metadata")], { encoding: "utf8" });
    assert.equal(result.status, 4);
    assert.match(result.stderr, /no validated IPv4/);
    assert.equal(await fs.readFile(file("output"), "utf8"), "keep-output");
    assert.equal(await fs.readFile(file("metadata"), "utf8"), "keep-metadata");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("validates DNS question and compression boundaries rather than resolver hostname reachability", () => {
  const question = dnsQuestion("entry.example.invalid", 1);
  const response = Buffer.from(question); response.writeUInt16BE(0x8180, 2); response.writeUInt16BE(1, 6);
  const record = Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34]);
  const packet = Buffer.concat([response, record]);
  assert.deepEqual(dnsAddresses(packet, "entry.example.invalid", 1), ["93.184.216.34"]);
  assert.throws(() => dnsAddresses(packet, "another.example.invalid", 1), /mismatch/);
  assert.throws(() => dnsAddresses(packet.subarray(0, -1), "entry.example.invalid", 1), /Truncated/);
  const nx = Buffer.from(packet); nx[3] = 0x83;
  assert.throws(() => dnsAddresses(nx, "entry.example.invalid", 1), /rejected/);
  const cycle = Buffer.from(packet); cycle[12] = 0xc0; cycle[13] = 12;
  assert.throws(() => dnsAddresses(cycle, "entry.example.invalid", 1), /Invalid DNS name/);
});
