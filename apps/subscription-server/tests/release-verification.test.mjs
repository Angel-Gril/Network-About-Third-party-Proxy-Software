import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";
import { verifyRelease } from "../scripts/verify_release.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const candidate = Buffer.from(YAML.stringify({
  secret: "synthetic-controller-secret",
  proxies: [{ name: "sample", type: "vless", server: "node.example.invalid", port: 443,
    uuid: "11111111-1111-4111-8111-111111111111", servername: "old.example.invalid" }],
  "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["sample"] }],
  rules: ["GEOSITE,github,PROXY", "MATCH,PROXY"],
}));

function proof() {
  return {
    source_sha256: sha256(candidate), test_node: "sample",
    rules_unchanged: true, nodes_unchanged: true,
    node_count: 1, policy_groups: 1, loaded_rules: 2,
    all_policies_matched: true, all_required_requests_passed: true, coverage_complete: true,
    results: [
      { case: "github", expected_rule: "GeoSite", expected_payload: "github", expected_policy: "PROXY",
        requires_http: true, http_status: 200, http_received: true, policy_matched: true, passed: true },
      { case: "fallback", expected_rule: "Match", expected_payload: "", expected_policy: "PROXY",
        requires_http: true, http_status: 204, http_received: true, policy_matched: true, passed: true },
    ],
  };
}

function verify(overrides = {}) {
  return verifyRelease({ candidate, published: candidate, origin: candidate, proof: proof(), ...overrides });
}

test("accepts only matching candidate, publication, origin and successful routing evidence", () => {
  const result = verify({ requireCompleteCoverage: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.matches_candidate, true);
  assert.equal(result.matches_origin, true);
  assert.equal(result.proof_matches_candidate, true);
  assert.equal(result.coverage_complete, true);
  assert.equal(result.verified_rule_count, 2);
  const serialized = JSON.stringify(result);
  for (const secret of ["synthetic-controller-secret", "node.example.invalid", "11111111-1111-4111-8111-111111111111"]) {
    assert.ok(!serialized.includes(secret));
  }
});

test("rejects rotated TLS parameters even if the origin matches the published file", () => {
  const rotated = Buffer.from(candidate.toString().replace("old.example.invalid", "new.example.invalid"));
  const result = verify({ published: rotated, origin: rotated });
  assert.equal(result.ok, false);
  assert.equal(result.matches_origin, true);
  assert.equal(result.matches_candidate, false);
  assert.ok(result.errors.includes("published_candidate_mismatch"));
});

test("cannot bind an old proof to a new candidate by changing the expected publication hash", () => {
  const rotated = Buffer.from(candidate.toString().replace("old.example.invalid", "new.example.invalid"));
  const result = verify({ candidate: rotated, published: rotated, origin: rotated });
  assert.equal(result.ok, false);
  assert.equal(result.matches_candidate, true);
  assert.equal(result.proof_matches_candidate, false);
  assert.ok(result.errors.includes("routing_proof_hash_mismatch"));
});

test("detects publication changing after the origin snapshot", () => {
  const result = verify({ origin: Buffer.from(candidate.toString() + "# later refresh\n") });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("published_origin_mismatch"));
});

test("leaves origin comparison explicitly unverified when no origin snapshot is supplied", () => {
  const result = verify({ origin: undefined });
  assert.equal(result.ok, true);
  assert.equal(result.matches_origin, null);
  assert.equal(result.origin_sha256, null);
});

test("does not accept failed or missing case evidence behind successful summary flags", () => {
  const changes = [
    p => { p.results = []; },
    p => { p.results[0].passed = false; },
    p => { p.results[0].policy_matched = false; },
    p => { p.results[0].http_received = false; },
    p => { p.results[0].http_status = 502; },
    p => { delete p.results[0].requires_http; },
    p => { p.all_policies_matched = false; },
    p => { p.all_required_requests_passed = false; },
    p => { p.rules_unchanged = false; },
    p => { p.nodes_unchanged = false; },
    p => { p.test_node = "absent"; },
  ];
  for (const change of changes) {
    const p = proof();
    change(p);
    assert.equal(verify({ proof: p }).ok, false, String(change));
  }
});

test("checks reported configuration counts instead of trusting an ok flag", () => {
  for (const key of ["node_count", "policy_groups", "loaded_rules"]) {
    const p = proof();
    p[key] += 1;
    assert.equal(verify({ proof: p }).ok, false, key);
  }
});

test("rejects results for a different rule or policy", () => {
  for (const key of ["expected_rule", "expected_payload", "expected_policy"]) {
    const p = proof();
    p.results[0][key] = "different";
    assert.equal(verify({ proof: p }).ok, false, key);
  }
});

test("duplicate cases cannot stand in for untested rules", () => {
  const p = proof();
  p.results[1] = { ...p.results[0] };
  assert.equal(verify({ proof: p }).ok, false);
  p.results[1].case = "another-label-for-the-same-rule";
  assert.equal(verify({ proof: p }).ok, false);
});

test("distinguishes selected rule checks from complete rule coverage", () => {
  const p = proof();
  p.results.pop();
  p.coverage_complete = false;
  const partial = verify({ proof: p });
  assert.equal(partial.ok, true);
  assert.equal(partial.coverage_complete, false);
  assert.equal(partial.verified_rule_count, 1);
  const full = verify({ proof: p, requireCompleteCoverage: true });
  assert.equal(full.ok, false);
  assert.ok(full.errors.includes("incomplete_rule_coverage"));
  p.coverage_complete = true;
  assert.equal(verify({ proof: p }).ok, false);
});

test("rejects missing proof, invalid YAML and duplicate YAML keys without leaking input", () => {
  for (const p of [null, {}, [], { source_sha256: sha256(candidate) }]) {
    assert.equal(verify({ proof: p }).ok, false);
  }
  for (const text of ["<html>synthetic-secret</html>", "proxies: [synthetic-secret", "proxies: []\nproxies: []\n",
    candidate.toString() + "\n---\nsecret: synthetic-secret\n"]) {
    const bytes = Buffer.from(text);
    const result = verify({ candidate: bytes, published: bytes, origin: bytes });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
  }
});

const cli = fileURLToPath(new URL("../scripts/verify_release.mjs", import.meta.url));
test("CLI rejects mismatched artifacts and prints only the redacted verification result", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-verification-"));
  try {
    const files = Object.fromEntries(["candidate", "published", "origin", "proof"].map(key => [key, join(directory, key)]));
    for (const key of ["candidate", "published", "origin"]) writeFileSync(files[key], candidate);
    writeFileSync(files.proof, JSON.stringify(proof()));
    const args = Object.entries(files).flatMap(([key, value]) => ["--" + key, value]);
    let result = spawnSync(process.execPath, [cli, ...args, "--require-complete-coverage"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, true);
    const changed = candidate.toString().replace("old.example.invalid", "new.example.invalid");
    writeFileSync(files.published, changed);
    result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes("synthetic-controller-secret"));
    assert.equal(readFileSync(files.published, "utf8"), changed);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI input errors do not echo private paths or malformed proof contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-input-"));
  try {
    const config = join(directory, "config.yaml");
    const invalidProof = join(directory, "proof.json");
    writeFileSync(config, candidate);
    writeFileSync(invalidProof, '{"synthetic-private-value":');
    for (const p of [invalidProof, join(directory, "absent-private-file")]) {
      const result = spawnSync(process.execPath, [cli, "--candidate", config, "--published", config, "--proof", p], { encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).ok, false);
      assert.equal(result.stderr, "");
      assert.ok(!result.stdout.includes(directory));
      assert.ok(!result.stdout.includes("synthetic-private-value"));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI rejects YAML parser warnings without echoing tagged secrets", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-warning-"));
  try {
    const config = join(directory, "config.yaml");
    const proofFile = join(directory, "proof.json");
    const tagged = candidate.toString().replace("secret: synthetic-controller-secret",
      "secret: !synthetic-private-tag synthetic-secret-value");
    assert.ok(tagged.includes("!synthetic-private-tag"));
    writeFileSync(config, tagged);
    writeFileSync(proofFile, JSON.stringify({ ...proof(), source_sha256: sha256(tagged) }));
    const result = spawnSync(process.execPath, [cli, "--candidate", config, "--published", config,
      "--proof", proofFile], { encoding: "utf8" });
    assert.equal(result.stderr, "");
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).errors.includes("invalid_candidate_yaml"));
    assert.ok(!result.stdout.includes("synthetic-secret-value"));
    assert.ok(!result.stdout.includes(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
