import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { prepareSubscription } from "../src/validate-subscription.mjs";

const identity = {
  type: "vless", port: 14443, uuid: "11111111-1111-4111-8111-111111111111",
  network: "tcp", tls: true, flow: "xtls-rprx-vision", "skip-cert-verify": true, udp: true,
};
const config = (overrides = {}) => YAML.stringify({
  proxies: [{ ...identity, name: "one", server: "retired.example.invalid", servername: "fresh-sni", ...overrides }],
  "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["one"] }],
  rules: ["MATCH,PROXY"],
});
const lookup = async (host) => {
  if (host === "retired.example.invalid") throw Object.assign(new Error("missing"), { code: "ENOTFOUND" });
  return [{ address: "203.0.113.8", family: 4 }];
};

test("recovers only the unreachable server field using a matching last-good VLESS entry", async () => {
  const previousYaml = config({ server: "working.example.invalid", servername: "old-sni" });
  const result = await prepareSubscription(config(), { previousYaml, allowServerRecovery: true, lookup });
  const parsed = YAML.parse(result.yaml);
  assert.equal(parsed.proxies[0].server, "working.example.invalid");
  assert.equal(parsed.proxies[0].servername, "fresh-sni");
  assert.equal(parsed.proxies[0].uuid, identity.uuid);
  assert.equal(result.proxyCount, 1);
  assert.equal(result.recoveredServerCount, 1);
  assert.deepEqual(parsed.rules, ["MATCH,PROXY"]);
});

test("does not reuse another account, port or transport as an entry fallback", async () => {
  for (const mismatch of [{ uuid: "22222222-2222-4222-8222-222222222222" }, { port: 24443 }, { network: "ws" }]) {
    await assert.rejects(prepareSubscription(config(), {
      previousYaml: config({ server: "working.example.invalid", ...mismatch }), allowServerRecovery: true, lookup,
    }), /entry|DNS/i);
  }
});

test("rejects an unresolved upstream when no verified fallback exists", async () => {
  await assert.rejects(prepareSubscription(config(), { lookup }), /entry|DNS/i);
});

test("does not replace a reachable upstream hostname", async () => {
  const result = await prepareSubscription(config({ server: "new.example.invalid" }), {
    previousYaml: config({ server: "old.example.invalid" }), allowServerRecovery: true, lookup,
  });
  assert.equal(YAML.parse(result.yaml).proxies[0].server, "new.example.invalid");
  assert.equal(result.recoveredServerCount, 0);
});

test("rejects synthetic fake-IP DNS answers and benchmark literal addresses", async () => {
  const fakeLookup = async () => [{ address: "198.18.1.24", family: 4 }];
  await assert.rejects(prepareSubscription(config(), { lookup: fakeLookup }), /entry|DNS/i);
  await assert.rejects(prepareSubscription(config({ server: "198.19.0.3" }), { lookup }), /entry|DNS/i);
});

test("accepts reachable VLESS WebSocket configurations without entry recovery", async () => {
  const result = await prepareSubscription(config({ server: "203.0.113.8", network: "ws", flow: "" }), { lookup });
  assert.equal(result.proxyCount, 1);
  assert.equal(result.recoveredServerCount, 0);
});

test("accepts an unresolved FlyBird entry only through multiple reachable HTTPS proxy resolvers", async () => {
  const routed = YAML.parse(config());
  routed.dns = { "proxy-server-nameserver": [
    "https://resolver-one.example.invalid/api-v2",
    "https://resolver-two.example.invalid/api-v2",
  ] };
  const result = await prepareSubscription(YAML.stringify(routed), {
    allowProxyResolver: true,
    lookup: async host => {
      if (host === "retired.example.invalid") throw Object.assign(new Error("missing"), { code:"ENOTFOUND" });
      return [{ address:"203.0.113.8", family:4 }];
    },
  });
  assert.equal(result.proxyCount, 1);
  assert.equal(result.delegatedHostCount, 1);
  assert.equal(YAML.parse(result.yaml).proxies[0].server, "retired.example.invalid");
});

test("does not delegate DNS to one resolver, non-HTTPS resolvers or unavailable resolver hosts", async () => {
  for (const resolvers of [
    ["https://one.example.invalid/api-v2"],
    ["http://one.example.invalid/api-v2", "https://two.example.invalid/api-v2"],
    ["https://one.example.invalid/api-v2", "https://missing.example.invalid/api-v2"],
  ]) {
    const routed=YAML.parse(config());routed.dns={"proxy-server-nameserver":resolvers};
    await assert.rejects(prepareSubscription(YAML.stringify(routed), {
      allowProxyResolver:true,
      lookup:async host => {
        if (host === "retired.example.invalid" || host === "missing.example.invalid") {
          throw Object.assign(new Error("missing"),{code:"ENOTFOUND"});
        }
        return [{address:"203.0.113.8",family:4}];
      },
    }), /DNS validation/);
  }
});
