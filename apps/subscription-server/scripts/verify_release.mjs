import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import YAML from "yaml";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const normalizedType = type => type.replaceAll("-", "").toLowerCase();

function ruleKey(type, payload, policy) {
  if (![type, payload, policy].every(value => typeof value === "string") || !type || !policy) return null;
  const kind = normalizedType(type);
  const insensitive = ["domain", "domainsuffix", "domainkeyword", "geosite", "geoip"];
  return JSON.stringify([kind, insensitive.includes(kind) ? payload.toLowerCase() : payload, policy]);
}

function configuredRuleKey(rule) {
  if (typeof rule !== "string") return null;
  const parts = rule.split(",").map(part => part.trim());
  if (parts[0] === "MATCH" && parts.length === 2) return ruleKey(parts[0], "", parts[1]);
  const supported = ["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "GEOSITE", "GEOIP", "IP-CIDR", "IP-CIDR6", "RULE-SET"];
  if (!supported.includes(parts[0]) || !parts[1] || parts.length < 3 ||
      parts.slice(3).some(flag => flag !== "no-resolve")) return null;
  return ruleKey(parts[0], parts[1], parts[2]);
}

// Offline evidence checking only: this function neither fetches nor modifies a subscription.
export function verifyRelease({ candidate, published, origin, proof, requireCompleteCoverage = false }) {
  const errors = [];
  const fail = code => { if (!errors.includes(code)) errors.push(code); };
  const result = { ok: false, errors, coverage_complete: false, verified_rule_count: 0 };
  try {
    result.candidate_sha256 = sha256(candidate);
    result.published_sha256 = sha256(published);
    result.origin_sha256 = origin === undefined ? null : sha256(origin);
  } catch {
    fail("invalid_artifact_input");
    return result;
  }
  result.matches_candidate = result.published_sha256 === result.candidate_sha256;
  result.matches_origin = origin === undefined ? null : result.published_sha256 === result.origin_sha256;
  result.proof_matches_candidate = proof?.source_sha256 === result.candidate_sha256;
  if (!result.matches_candidate) fail("published_candidate_mismatch");
  if (result.matches_origin === false) fail("published_origin_mismatch");
  if (!result.proof_matches_candidate) fail("routing_proof_hash_mismatch");

  let config;
  try {
    // YAML.parse emits warnings containing source lines before callers can redact them.
    const document = YAML.parseDocument(candidate.toString(), { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error("invalid_yaml");
    config = document.toJS({ maxAliasCount: 100 });
  }
  catch { fail("invalid_candidate_yaml"); return result; }
  if (!config || !Array.isArray(config.proxies) || !config.proxies.length ||
      !Array.isArray(config["proxy-groups"]) || !config["proxy-groups"].length ||
      !Array.isArray(config.rules) || !config.rules.length) {
    fail("invalid_candidate_config");
    return result;
  }
  result.nodes = config.proxies.length;
  result.groups = config["proxy-groups"].length;
  result.rules = config.rules.length;
  const ruleKeys = config.rules.map(configuredRuleKey);
  if (ruleKeys.includes(null) || new Set(ruleKeys).size !== ruleKeys.length) fail("unsupported_candidate_rules");

  if (!proof || typeof proof !== "object" || Array.isArray(proof) ||
      !Array.isArray(proof.results) || !proof.results.length) {
    fail("missing_routing_cases");
    return result;
  }
  if (["rules_unchanged", "nodes_unchanged", "all_policies_matched", "all_required_requests_passed"]
      .some(key => proof[key] !== true) || typeof proof.coverage_complete !== "boolean") fail("invalid_routing_summary");
  if (proof.node_count !== result.nodes || proof.policy_groups !== result.groups || proof.loaded_rules !== result.rules ||
      !config.proxies.some(proxy => proxy?.name === proof.test_node && typeof proof.test_node === "string")) {
    fail("routing_config_mismatch");
  }
  const seenCases = new Set();
  const verifiedRules = new Set();
  for (const item of proof.results) {
    if (!item || typeof item.case !== "string" || !item.case || seenCases.has(item.case)) {
      fail("invalid_routing_case");
      continue;
    }
    seenCases.add(item.case);
    const key = ruleKey(item.expected_rule, item.expected_payload, item.expected_policy);
    const httpPassed = item.http_received === true && Number.isInteger(item.http_status) &&
      item.http_status >= 100 && item.http_status < 500;
    if (!key || !ruleKeys.includes(key) || verifiedRules.has(key) ||
        item.passed !== true || item.policy_matched !== true || typeof item.requires_http !== "boolean" ||
        (item.requires_http && !httpPassed)) {
      fail("invalid_routing_case");
      continue;
    }
    verifiedRules.add(key);
  }
  result.verified_rule_count = verifiedRules.size;
  result.coverage_complete = verifiedRules.size === result.rules && !errors.includes("unsupported_candidate_rules");
  if (proof.coverage_complete !== result.coverage_complete) fail("routing_coverage_mismatch");
  if (requireCompleteCoverage && !result.coverage_complete) fail("incomplete_rule_coverage");
  result.ok = errors.length === 0;
  return result;
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      candidate: { type: "string" }, published: { type: "string" }, origin: { type: "string" },
      proof: { type: "string" }, "require-complete-coverage": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    }, allowPositionals: false }));
  } catch {
    console.log(JSON.stringify({ ok: false, errors: ["invalid_arguments"] }));
    return 2;
  }
  if (values.help) {
    console.log("Usage: node verify_release.mjs --candidate FILE --published FILE --proof FILE [--origin FILE] [--require-complete-coverage]");
    return 0;
  }
  if (![values.candidate, values.published, values.proof].every(Boolean)) {
    console.log(JSON.stringify({ ok: false, errors: ["missing_arguments"] }));
    return 2;
  }
  let result;
  try {
    result = verifyRelease({ candidate: readFileSync(values.candidate), published: readFileSync(values.published),
      origin: values.origin === undefined ? undefined : readFileSync(values.origin),
      proof: JSON.parse(readFileSync(values.proof, "utf8")), requireCompleteCoverage: values["require-complete-coverage"] });
  } catch {
    // Parser and filesystem messages can contain tokens, file paths or YAML fragments.
    result = { ok: false, errors: ["unreadable_or_invalid_input"] };
  }
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
