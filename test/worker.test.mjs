import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildDistributionLinks,
  buildMetaRulesAssetUrl,
  convertClashYamlToLinks,
  convertProxyToLink,
  decryptCredentialToken,
  encryptCredentialToken,
  enhanceMihomoConfig,
  extractProxiesBlock,
  extractProxyDicts,
  handleRequest,
  linksToBase64Subscription,
  scheduled,
} from "../src/worker.js";

const clashYaml = [
  "mixed-port: 7890",
  "allow-lan: true",
  "",
  "proxies:",
  '  - {"name":"HK 1","type":"vless","server":"example.com","port":443,"uuid":"11111111-1111-1111-1111-111111111111","tls":true,"flow":"xtls-rprx-vision","skip-cert-verify":true,"servername":"sni.example","network":"tcp"}',
  '  - {"name":"SS 1","type":"ss","server":"ss.example.com","port":8388,"cipher":"aes-128-gcm","password":"pass"}',
  "proxy-groups:",
  "  - name: AUTO",
  "rules:",
  "  - MATCH,AUTO",
].join("\n");

test("worker source does not reference Node-only Buffer globals", () => {
  const source = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");

  assert.equal(/\bBuffer\b/.test(source), false);
});

test("launcher always uses the local account PowerShell exporter", () => {
  const source = readFileSync(new URL("../run_export_fb_all.bat", import.meta.url), "utf8");

  assert.match(source, /export_fb_all\.ps1/);
  assert.doesNotMatch(source, /export_fb_all\.py/);
  assert.ok(source.indexOf("where pwsh") < source.indexOf("where powershell"));
});

test("PowerShell exporter logs in, downloads, and decrypts on the local machine", () => {
  const source = readFileSync(new URL("../export_fb_all.ps1", import.meta.url), "utf8");

  assert.match(source, /\[string\]\$Email/);
  assert.match(source, /\[string\]\$Password/);
  assert.match(source, /https:\/\/fbesa\.apiv2\.a047\.com\/api\/v1/);
  assert.match(source, /flutter\.api_base_url/);
  assert.match(source, /FLYBIRD_API_BASE_URL/);
  assert.match(source, /api_base_source/);
  assert.match(source, /passport\/auth\/login/);
  assert.match(source, /user\/getSubscribe/);
  assert.match(source, /NetFlow\/v3\.0\.3 clash-verge Platform\/windows/);
  assert.match(source, /x-auth-token/);
  assert.match(source, /Invoke-WebRequest/);
  assert.match(source, /NoProxy/);
  assert.match(source, /Decrypt-FlyingBirdProfile/);
  assert.match(source, /Apply-ClashRoutingTemplate/);
  assert.match(source, /routing_provider_count/);
  assert.doesNotMatch(
    source,
    /ProfilePath|Get-LocalFlyingBirdProfilePath|FlyingBird\\FlyingBird\\profiles/,
  );
});

test("PowerShell exporter rejects decryptable subscriptions with no resolvable proxy hosts", () => {
  const exporter = readFileSync(new URL("../export_fb_all.ps1", import.meta.url), "utf8");
  const validation = readFileSync(new URL("../subscription_validation.ps1", import.meta.url), "utf8");

  assert.match(exporter, /Set-FlyingBirdSubscriptionMetaFlag/);
  assert.match(exporter, /ResolvableServerCount -eq 0/);
  assert.match(exporter, /Wait-ClashProxyServerResolution/);
  assert.match(validation, /flag=meta/);
  assert.match(validation, /Get-ClashProxyServerResolutionSummary/);
  assert.match(validation, /GetHostAddresses/);
  assert.match(validation, /Start-Sleep/);
});

test("routing template uses compact MetaCubeX MRS providers", () => {
  const source = readFileSync(new URL("../routing_template.yaml", import.meta.url), "utf8");
  const lines = source.split(/\r?\n/);
  const providersStart = lines.indexOf("rule-providers:");
  const rulesStart = lines.indexOf("rules:");
  const providerCount = lines
    .slice(providersStart + 1, rulesStart)
    .filter((line) => /^  [a-z0-9-]+:\s*$/.test(line)).length;
  const ruleCount = lines.slice(rulesStart + 1).filter((line) => /^-\s+/.test(line)).length;
  const providerPaths = lines
    .slice(providersStart + 1, rulesStart)
    .filter((line) => /^\s+path:\s+/.test(line))
    .map((line) => line.trim());

  assert.match(source, /MetaCubeX\/meta-rules-dat/);
  assert.match(source, /format: mrs/);
  assert.match(source, /__ALL_NODES__/);
  assert.match(source, /name: 🛑 全球拦截[\s\S]*?proxies:\s*\n  - REJECT\s*\n  - DIRECT/);
  assert.equal(new Set(providerPaths).size, providerPaths.length);
  assert.equal(providerCount, 27);
  assert.equal(ruleCount, 55);
  assert.match(source, /sniffer:\s*\n  enable: true/);
  assert.match(source, /fallback:\s*\n  - ['"]https:\/\/1\.1\.1\.1\/dns-query#♻️ 自动选择['"]/);
  assert.match(source, /DOMAIN-SUFFIX,github\.com,💻 开发服务/);
  assert.ok(source.indexOf("DOMAIN-SUFFIX,github.com") < source.indexOf("RULE-SET,non-cn-domain"));
  for (const provider of [
    "github-domain",
    "google-domain",
    "google-ip",
    "youtube-domain",
    "netflix-domain",
    "netflix-ip",
    "disney-domain",
    "hbo-domain",
    "spotify-domain",
    "bilibili-domain",
    "bahamut-domain",
    "paypal-domain",
    "game-download-domain",
    "games-non-cn-domain",
  ]) {
    assert.match(source, new RegExp(`^  ${provider}:`, "m"));
    assert.match(source, new RegExp(`^- RULE-SET,${provider},`, "m"));
  }
  assert.ok(source.indexOf("RULE-SET,game-download-domain") < source.indexOf("RULE-SET,games-non-cn-domain"));
  assert.ok(source.indexOf("RULE-SET,google-domain") < source.indexOf("RULE-SET,non-cn-domain"));
  for (const provider of ["youtube", "netflix", "disney", "hbo", "spotify", "bahamut"]) {
    assert.match(source, new RegExp(`RULE-SET,${provider}-domain,🌍 国外媒体`));
  }
  assert.match(source, /RULE-SET,bilibili-domain,🌏 国内媒体/);
  assert.ok(source.length < 20_000);
});

test("Python compatibility entry delegates account arguments to PowerShell", () => {
  const source = readFileSync(new URL("../export_fb_all.py", import.meta.url), "utf8");

  assert.match(source, /export_fb_all\.ps1/);
  assert.match(source, /--email/);
  assert.match(source, /--password/);
  assert.match(source, /--routing-template/);
  assert.ok(source.indexOf('shutil.which("pwsh")') < source.indexOf('shutil.which("powershell")'));
  assert.doesNotMatch(source, /--profile|ProfilePath|urllib/);
});

class MemoryKV {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    return this.map.get(key) || null;
  }

  async put(key, value) {
    this.map.set(key, value);
  }

  async list(options = {}) {
    const prefix = options.prefix || "";
    return {
      keys: [...this.map.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name })),
    };
  }
}

function installFetchMock(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("extractProxiesBlock returns only the proxies section", () => {
  assert.deepEqual(extractProxiesBlock(clashYaml), [
    "proxies:",
    '  - {"name":"HK 1","type":"vless","server":"example.com","port":443,"uuid":"11111111-1111-1111-1111-111111111111","tls":true,"flow":"xtls-rprx-vision","skip-cert-verify":true,"servername":"sni.example","network":"tcp"}',
    '  - {"name":"SS 1","type":"ss","server":"ss.example.com","port":8388,"cipher":"aes-128-gcm","password":"pass"}',
  ]);
});

test("extractProxyDicts parses JSON-style Clash proxy lines", () => {
  const proxies = extractProxyDicts(extractProxiesBlock(clashYaml));

  assert.equal(proxies.length, 2);
  assert.equal(proxies[0].type, "vless");
  assert.equal(proxies[1].name, "SS 1");
});

test("convertProxyToLink converts vless nodes with transport parameters", () => {
  const link = convertProxyToLink({
    name: "HK 1",
    type: "vless",
    server: "example.com",
    port: 443,
    uuid: "11111111-1111-1111-1111-111111111111",
    tls: true,
    flow: "xtls-rprx-vision",
    "skip-cert-verify": true,
    servername: "sni.example",
    network: "tcp",
  });

  assert.equal(
    link,
    "vless://11111111-1111-1111-1111-111111111111@example.com:443?type=tcp&security=tls&encryption=none&flow=xtls-rprx-vision&sni=sni.example&allowInsecure=1#HK%201",
  );
});

test("convertClashYamlToLinks returns plain links and base64 subscription body", () => {
  const links = convertClashYamlToLinks(clashYaml);

  assert.equal(links.length, 2);
  assert.match(links[0], /^vless:\/\//);
  assert.equal(
    linksToBase64Subscription(links),
    Buffer.from(links.join("\n"), "utf8").toString("base64"),
  );
});

test("credential tokens round-trip with LINK_SECRET", async () => {
  const token = await encryptCredentialToken(
    { email: "user@example.com", password: "secret-password" },
    "test-link-secret",
  );
  const decoded = await decryptCredentialToken(token, "test-link-secret");

  assert.equal(decoded.email, "user@example.com");
  assert.equal(decoded.password, "secret-password");
  assert.equal(typeof decoded.createdAt, "string");
});

test("buildDistributionLinks creates CF subscription URLs", () => {
  const links = buildDistributionLinks("https://worker.example", {
    accessKey: "abc",
    credentialToken: "cred-token",
  });

  assert.equal(
    links.clash,
    "https://worker.example/sub?key=abc&cred=cred-token",
  );
  assert.equal(
    links.clashFull,
    "https://worker.example/sub/clash?key=abc&cred=cred-token",
  );
  assert.equal(
    links.v2rayn,
    "https://worker.example/sub/base64?key=abc&cred=cred-token",
  );
});

test("buildDistributionLinks can create direct token subscription URLs", () => {
  const links = buildDistributionLinks("https://worker.example", {
    accessKey: "abc",
    subscriptionToken: "token-1",
  });

  assert.equal(
    links.clash,
    "https://worker.example/sub?key=abc&token=token-1",
  );
  assert.equal(
    links.v2rayn,
    "https://worker.example/sub/base64?key=abc&token=token-1",
  );
});

test("enhanceMihomoConfig injects MetaCubeX GeoX auto-update and split rules", () => {
  const enhanced = enhanceMihomoConfig(clashYaml, "https://worker.example");

  assert.match(enhanced, /geodata-mode: true/);
  assert.match(enhanced, /geo-auto-update: true/);
  assert.match(enhanced, /geo-update-interval: 24/);
  assert.match(
    enhanced,
    /geoip: "https:\/\/worker\.example\/rules\/geoip\.dat"/,
  );
  assert.match(
    enhanced,
    /geosite: "https:\/\/worker\.example\/rules\/geosite\.dat"/,
  );
  assert.match(enhanced, /proxy-groups:/);
  assert.match(enhanced, /name: "节点选择"/);
  assert.match(enhanced, /rules:/);
  assert.match(enhanced, /GEOSITE,telegram,电报消息/);
  assert.match(enhanced, /GEOSITE,cn,DIRECT/);
  assert.match(enhanced, /MATCH,漏网之鱼/);
});

test("enhanceMihomoConfig can disable mihomo GeoX auto-update per generated link", () => {
  const enhanced = enhanceMihomoConfig(clashYaml, "https://worker.example", {
    geoAutoUpdate: false,
    geoUpdateInterval: 6,
  });

  assert.match(enhanced, /geo-auto-update: false/);
  assert.match(enhanced, /geo-update-interval: 6/);
});

test("enhanceMihomoConfig does not inject client fingerprint into VLESS Vision nodes", () => {
  const enhanced = enhanceMihomoConfig(clashYaml, "https://worker.example");

  assert.equal(enhanced.includes("client-fingerprint"), false);
});

test("buildMetaRulesAssetUrl maps supported assets to MetaCubeX latest releases", () => {
  assert.equal(
    buildMetaRulesAssetUrl("geoip.dat"),
    "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat",
  );
  assert.equal(
    buildMetaRulesAssetUrl("geosite-lite.dat"),
    "https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite-lite.dat",
  );
  assert.throws(() => buildMetaRulesAssetUrl("bad.bin"), /Unsupported rules asset/);
});

test("GET /sub returns enhanced mihomo config from fixed worker credentials", async () => {
  const calls = [];
  const restoreFetch = installFetchMock(async (url, init) => {
    const value = String(url);
    calls.push({ url: value, headers: init?.headers || {} });
    if (value.includes("/passport/auth/login")) {
      return new Response(
        JSON.stringify({
          status: "success",
          data: { token: "token-1", auth_data: "auth-1" },
        }),
        { status: 200 },
      );
    }
    if (value.includes("/client/subscribe")) {
      return new Response(clashYaml, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  try {
    const response = await handleRequest(
      new Request("https://worker.example/sub?key=abc"),
      {
        ACCESS_KEY: "abc",
        FLYBIRD_EMAIL: "user@example.com",
        FLYBIRD_PASSWORD: "secret",
      },
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(
      calls[0].url,
      "https://fbesa.apiv2.a047.com/api/v1/passport/auth/login",
    );
    assert.equal(calls[0].headers["x-client-platform"], "windows");
    assert.equal(calls[0].headers["x-app-package-name"], "atlas");
    assert.equal(response.headers.get("Content-Type"), "text/yaml; charset=utf-8");
    assert.match(body, /geo-auto-update: true/);
    assert.match(body, /geoip: "https:\/\/worker\.example\/rules\/geoip\.dat"/);
    assert.match(body, /proxy-groups:/);
    assert.match(body, /rules:/);
  } finally {
    restoreFetch();
  }
});

test("GET /sub can pull upstream Clash config directly from token query", async () => {
  const calls = [];
  const subscribeHeaders = [];
  const restoreFetch = installFetchMock(async (url, init) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("/client/subscribe")) {
      subscribeHeaders.push(init.headers);
      return new Response(clashYaml, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  try {
    const response = await handleRequest(
      new Request("https://worker.example/sub?key=abc&token=token-1"),
      { ACCESS_KEY: "abc" },
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "text/yaml; charset=utf-8");
    assert.equal(
      calls[0],
      "https://fbesa.apiv2.a047.com/api/v1/client/subscribe?token=token-1",
    );
    assert.equal(calls.some((value) => value.includes("/passport/auth/login")), false);
    assert.equal(
      subscribeHeaders[0]["User-Agent"],
      "NetFlow/v3.0.3 clash-verge Platform/windows",
    );
    assert.equal(subscribeHeaders[0]["x-client-platform"], "windows");
    assert.match(body, /geo-auto-update: true/);
    assert.match(body, /proxy-groups:/);
  } finally {
    restoreFetch();
  }
});

test("GET /sub reports upstream WAF HTML instead of trying to parse it as a subscription", async () => {
  const restoreFetch = installFetchMock(async (url) => {
    const value = String(url);
    if (value.includes("/client/subscribe")) {
      return new Response("<!doctype html><title>Verification</title>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  });

  try {
    const response = await handleRequest(
      new Request("https://worker.example/sub?key=abc&token=token-1"),
      { ACCESS_KEY: "abc" },
    );
    const body = await response.text();

    assert.equal(response.status, 502);
    assert.match(body, /upstream returned html/i);
  } finally {
    restoreFetch();
  }
});

test("GET /sub falls back across known subscription domains when one returns WAF HTML", async () => {
  const calls = [];
  const restoreFetch = installFetchMock(async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.startsWith("https://fbesa.apiv2.a047.com/")) {
      return new Response("<!doctype html><title>Verification</title>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (value.startsWith("https://fbapid.web.ak005.com/")) {
      return new Response(clashYaml, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  try {
    const response = await handleRequest(
      new Request("https://worker.example/sub?key=abc&token=token-1"),
      { ACCESS_KEY: "abc" },
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      "https://fbesa.apiv2.a047.com/api/v1/client/subscribe?token=token-1",
      "https://fbapid.web.ak005.com/api/v1/client/subscribe?flag=meta&token=token-1",
    ]);
    assert.match(body, /proxy-groups:/);
  } finally {
    restoreFetch();
  }
});

test("POST /api/token-links preserves a full subscription URL inside encrypted credentials", async () => {
  const createResponse = await handleRequest(
    new Request("https://worker.example/api/token-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "https://fresh.example.com/api/v1/client/subscribe?token=token-1",
        accessKey: "abc",
        storeProfile: false,
      }),
    }),
    {
      ACCESS_KEY: "abc",
      LINK_SECRET: "test-link-secret",
    },
  );
  const created = await createResponse.json();
  const calls = [];
  const restoreFetch = installFetchMock(async (url) => {
    const value = String(url);
    calls.push(value);
    if (value === "https://fresh.example.com/api/v1/client/subscribe?token=token-1") {
      return new Response(clashYaml, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  try {
    const response = await handleRequest(
      new Request(created.links.clash),
      {
        ACCESS_KEY: "abc",
        LINK_SECRET: "test-link-secret",
      },
    );
    const body = await response.text();

    assert.equal(createResponse.status, 200);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      "https://fresh.example.com/api/v1/client/subscribe?token=token-1",
    ]);
    assert.match(body, /proxy-groups:/);
  } finally {
    restoreFetch();
  }
});

test("POST /api/links keeps credentials in encrypted cred URL when KV profile storage is off", async () => {
  const restoreFetch = installFetchMock(async (url) => {
    const value = String(url);
    if (value.includes("/passport/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "token-1", auth_data: "auth-1" },
      });
    }
    if (value.includes("/user/getSubscribe")) {
      return Response.json({
        status: "success",
        data: {
          subscribe_url: "https://fresh.example.com/api/v1/client/subscribe?token=token-1",
          subscription_url: "https://fresh.example.com/api/v1/client/subscribe?token=token-1",
        },
      });
    }
    if (value === "https://fresh.example.com/api/v1/client/subscribe?token=token-1") {
      return new Response(clashYaml, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  try {
    const response = await handleRequest(
      new Request("https://worker.example/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "user@example.com",
          password: "secret",
          accessKey: "abc",
          storeProfile: false,
        }),
      }),
      {
        ACCESS_KEY: "abc",
        LINK_SECRET: "test-link-secret",
      },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.match(body.links.clash, /^https:\/\/worker\.example\/sub\?key=abc&cred=/);
    const credentialToken = new URL(body.links.clash).searchParams.get("cred");
    const credentials = await decryptCredentialToken(
      credentialToken,
      "test-link-secret",
    );
    assert.equal(credentials.token, "token-1");
    assert.equal(
      credentials.subscriptionUrl,
      "https://fresh.example.com/api/v1/client/subscribe?token=token-1",
    );
    assert.equal(credentials.email, undefined);
    assert.equal(credentials.password, undefined);
    assert.equal(body.profile?.stored, false);
  } finally {
    restoreFetch();
  }
});

test("POST /api/token-links keeps token encrypted in cred URL when KV profile storage is off", async () => {
  const response = await handleRequest(
    new Request("https://worker.example/api/token-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "token-1",
        accessKey: "abc",
        storeProfile: false,
      }),
    }),
    {
      ACCESS_KEY: "abc",
      LINK_SECRET: "test-link-secret",
    },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.match(body.links.clash, /^https:\/\/worker\.example\/sub\?key=abc&cred=/);
  assert.equal(body.links.clash.includes("token-1"), false);
  assert.equal(body.profile?.stored, false);
  assert.equal(body.tokenSource, "token");
});

test("POST /api/links stores encrypted frontend credentials in KV when scheduled profile sync is enabled", async () => {
  const kv = new MemoryKV();
  const restoreFetch = installFetchMock(async (url) => {
    const value = String(url);
    if (value.includes("/passport/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "token-1", auth_data: "auth-1" },
      });
    }
    if (value.includes("/user/getSubscribe")) {
      return Response.json({
        status: "success",
        data: {
          subscribe_url: "https://fresh.example.com/api/v1/client/subscribe?token=token-1",
          subscription_url: "https://fresh.example.com/api/v1/client/subscribe?token=token-1",
        },
      });
    }
    if (value === "https://fresh.example.com/api/v1/client/subscribe?token=token-1") {
      return new Response(clashYaml, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  try {
    const response = await handleRequest(
      new Request("https://worker.example/api/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "user@example.com",
          password: "secret",
          accessKey: "abc",
          storeProfile: true,
          enableProfileSync: true,
          geoAutoUpdate: false,
          geoUpdateInterval: 12,
        }),
      }),
      {
        ACCESS_KEY: "abc",
        LINK_SECRET: "test-link-secret",
        SUB_CACHE: kv,
      },
    );
    const body = await response.json();
    const profileKeys = await kv.list({ prefix: "profile:" });
    const profileText = await kv.get(profileKeys.keys[0].name);
    const profile = JSON.parse(profileText);

    assert.equal(response.status, 200);
    assert.equal(body.profile.stored, true);
    assert.match(body.links.clash, /^https:\/\/worker\.example\/p\/[a-z0-9-]+\/sub\?key=abc$/);
    assert.equal(profile.options.enableProfileSync, true);
    assert.equal(profile.options.geoAutoUpdate, false);
    assert.equal(profile.options.geoUpdateInterval, 12);
    assert.equal(profileText.includes("token-1"), false);
    assert.equal(profileText.includes("secret"), false);
    assert.equal(profileText.includes("user@example.com"), false);
  } finally {
    restoreFetch();
  }
});

test("POST /api/token-links stores encrypted token in KV when scheduled profile sync is enabled", async () => {
  const kv = new MemoryKV();

  const response = await handleRequest(
    new Request("https://worker.example/api/token-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "token-1",
        accessKey: "abc",
        storeProfile: true,
        enableProfileSync: true,
        geoAutoUpdate: false,
        geoUpdateInterval: 12,
      }),
    }),
    {
      ACCESS_KEY: "abc",
      LINK_SECRET: "test-link-secret",
      SUB_CACHE: kv,
    },
  );
  const body = await response.json();
  const profileKeys = await kv.list({ prefix: "profile:" });
  const profileText = await kv.get(profileKeys.keys[0].name);
  const profile = JSON.parse(profileText);

  assert.equal(response.status, 200);
  assert.equal(body.profile.stored, true);
  assert.match(body.links.clash, /^https:\/\/worker\.example\/p\/[a-z0-9-]+\/sub\?key=abc$/);
  assert.equal(profile.options.enableProfileSync, true);
  assert.equal(profile.options.geoAutoUpdate, false);
  assert.equal(profile.options.geoUpdateInterval, 12);
  assert.equal(profileText.includes("token-1"), false);
});

test("POST /api/cache creates a cache-only profile whose primary link serves raw YAML without upstream fetch", async () => {
  const kv = new MemoryKV();

  const createResponse = await handleRequest(
    new Request("https://worker.example/api/cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessKey: "abc",
        clashYaml,
        geoAutoUpdate: false,
        geoUpdateInterval: 12,
      }),
    }),
    {
      ACCESS_KEY: "abc",
      SUB_CACHE: kv,
    },
  );
  const created = await createResponse.json();
  const restoreFetch = installFetchMock(async () => {
    throw new Error("cache-only profile must not fetch upstream");
  });

  try {
    const subResponse = await handleRequest(
      new Request(created.links.clash),
      {
        ACCESS_KEY: "abc",
        SUB_CACHE: kv,
      },
    );
    const subBody = await subResponse.text();
    const rawResponse = await handleRequest(
      new Request(created.links.rawClash),
      {
        ACCESS_KEY: "abc",
        SUB_CACHE: kv,
      },
    );
    const rawBody = await rawResponse.text();

    assert.equal(createResponse.status, 200);
    assert.equal(created.profile.stored, true);
    assert.equal(created.profile.cacheOnly, true);
    assert.match(created.links.clash, /^https:\/\/worker\.example\/p\/[a-z0-9-]+\/sub\/raw\?key=abc$/);
    assert.match(created.links.clashFull, /^https:\/\/worker\.example\/p\/[a-z0-9-]+\/sub\/clash\?key=abc$/);
    assert.equal(subResponse.status, 200);
    assert.equal(subResponse.headers.get("X-Subscription-Cache"), "HIT");
    assert.equal(subBody, clashYaml);
    assert.match(subBody, /proxy-groups:/);
    assert.equal(rawResponse.status, 200);
    assert.equal(rawBody, clashYaml);
  } finally {
    restoreFetch();
  }
});

test("scheduled sync refreshes saved profile cache only when profile cron switch is enabled", async () => {
  const kv = new MemoryKV();
  const credentialToken = await encryptCredentialToken(
    { email: "user@example.com", password: "secret" },
    "test-link-secret",
  );
  await kv.put(
    "profile:test-profile",
    JSON.stringify({
      id: "test-profile",
      credentialToken,
      baseUrl: "https://worker.example",
      options: {
        enableProfileSync: true,
        geoAutoUpdate: true,
        geoUpdateInterval: 24,
      },
    }),
  );

  let subscribeCalls = 0;
  const restoreFetch = installFetchMock(async (url) => {
    const value = String(url);
    if (value.includes("/passport/auth/login")) {
      return Response.json({
        status: "success",
        data: { token: "token-1", auth_data: "auth-1" },
      });
    }
    if (value.includes("/client/subscribe")) {
      subscribeCalls += 1;
      return new Response(clashYaml, { status: 200 });
    }
    return new Response("rules", { status: 200 });
  });

  try {
    const waitUntil = [];
    await scheduled(
      {},
      {
        LINK_SECRET: "test-link-secret",
        SUB_CACHE: kv,
        ENABLE_RULES_CRON: "false",
        ENABLE_PROFILE_CRON: "true",
      },
      { waitUntil: (promise) => waitUntil.push(promise) },
    );
    await Promise.all(waitUntil);

    const profile = JSON.parse(await kv.get("profile:test-profile"));
    assert.equal(subscribeCalls, 1);
    assert.match(profile.cache.enhancedClash, /geo-auto-update: true/);
    assert.equal(profile.cache.nodeCount, 2);

    const disabledWaits = [];
    await scheduled(
      {},
      {
        LINK_SECRET: "test-link-secret",
        SUB_CACHE: kv,
        ENABLE_RULES_CRON: "false",
        ENABLE_PROFILE_CRON: "false",
      },
      { waitUntil: (promise) => disabledWaits.push(promise) },
    );
    await Promise.all(disabledWaits);

    assert.equal(subscribeCalls, 1);
  } finally {
    restoreFetch();
  }
});

test("scheduled sync refreshes saved token profile cache without login", async () => {
  const kv = new MemoryKV();
  const credentialToken = await encryptCredentialToken(
    { token: "token-1" },
    "test-link-secret",
  );
  await kv.put(
    "profile:test-profile",
    JSON.stringify({
      id: "test-profile",
      credentialToken,
      baseUrl: "https://worker.example",
      options: {
        enableProfileSync: true,
        geoAutoUpdate: true,
        geoUpdateInterval: 24,
      },
    }),
  );

  let subscribeCalls = 0;
  const calls = [];
  const restoreFetch = installFetchMock(async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes("/client/subscribe")) {
      subscribeCalls += 1;
      return new Response(clashYaml, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });

  try {
    const waitUntil = [];
    await scheduled(
      {},
      {
        LINK_SECRET: "test-link-secret",
        SUB_CACHE: kv,
        ENABLE_RULES_CRON: "false",
        ENABLE_PROFILE_CRON: "true",
      },
      { waitUntil: (promise) => waitUntil.push(promise) },
    );
    await Promise.all(waitUntil);

    const profile = JSON.parse(await kv.get("profile:test-profile"));
    assert.equal(subscribeCalls, 1);
    assert.equal(calls.some((value) => value.includes("/passport/auth/login")), false);
    assert.match(profile.cache.enhancedClash, /geo-auto-update: true/);
    assert.equal(profile.cache.nodeCount, 2);
  } finally {
    restoreFetch();
  }
});

const invalidProxyConfigs = [
  "proxies:\n",
  'proxies:\n  - {"name":"Truncated",\n',
  'proxies:\n  - {"name":"Missing connection fields"}\n',
  clashYaml.replace("proxy-groups:", "  - malformed-node\nproxy-groups:"),
];

test("manual cache updates reject invalid proxies and preserve the last-good subscription", async () => {
  const env = { ACCESS_KEY: "abc", SUB_CACHE: new MemoryKV() };
  const upload = (yaml) => handleRequest(new Request("https://worker.example/api/cache", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey: "abc", profileId: "last-good", clashYaml: yaml }),
  }), env);
  const created = await upload(clashYaml);
  assert.equal(created.status, 200);
  const { links } = await created.json();

  for (const invalid of invalidProxyConfigs) {
    const rejected = await upload(invalid);
    assert.equal(rejected.status, 422);
    const subscription = await handleRequest(new Request(links.rawClash), env);
    assert.equal(subscription.status, 200);
    assert.equal(await subscription.text(), clashYaml);
  }
});

test("profile requests and scheduled refresh preserve the last-good subscription after invalid upstream data", async () => {
  const env = {
    ACCESS_KEY: "abc", LINK_SECRET: "test-link-secret", SUB_CACHE: new MemoryKV(),
    ENABLE_RULES_CRON: "false", ENABLE_PROFILE_CRON: "true",
  };
  const created = await handleRequest(new Request("https://worker.example/api/token-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessKey: "abc", token: "synthetic-token", storeProfile: true, enableProfileSync: true }),
  }), env);
  assert.equal(created.status, 200);
  const { links } = await created.json();
  let upstream = clashYaml;
  const restoreFetch = installFetchMock(async () => upstream === null
    ? new Response("Unavailable", { status: 503 })
    : new Response(upstream));
  const refresh = async () => {
    const pending = [];
    await scheduled({}, env, { waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
  };
  try {
    await refresh();
    for (const invalid of invalidProxyConfigs) {
      upstream = invalid;
      const liveSubscription = await handleRequest(new Request(links.rawClash), env);
      assert.equal(liveSubscription.status, 200);
      assert.equal(liveSubscription.headers.get("X-Subscription-Cache"), "HIT");
      assert.equal(await liveSubscription.text(), clashYaml);
      await refresh();
      upstream = null;
      const subscription = await handleRequest(new Request(links.rawClash), env);
      assert.equal(subscription.status, 200);
      assert.equal(subscription.headers.get("X-Subscription-Cache"), "HIT");
      assert.equal(await subscription.text(), clashYaml);
    }
  } finally {
    restoreFetch();
  }
});

test("authenticated upstream errors never expose response bodies or parser input", async (t) => {
  const marker = "SENTINEL";
  const cases = [
    ["login HTTP error", "login", () => new Response(marker, { status: 503 })],
    ["login rejection", "login", () => Response.json({ status: "error", message: marker })],
    ["invalid login JSON", "login", () => new Response(`${marker} is not JSON`)],
    ["subscription info HTTP error", "getSubscribe", () => new Response(marker, { status: 503 })],
    ["subscription info rejection", "getSubscribe", () => Response.json({ status: "error", message: marker })],
    ["invalid subscription info JSON", "getSubscribe", () => new Response(`${marker} is not JSON`)],
    ["subscription HTTP error", "subscribe", () => new Response(marker, { status: 503 })],
  ];
  for (const [name, stage, failure] of cases) {
    await t.test(name, async () => {
      const restoreFetch = installFetchMock(async (url) => {
        const endpoint = new URL(url).pathname.split("/").at(-1);
        if (endpoint === stage) return failure();
        if (endpoint === "login") return Response.json({ status: "success", data: { token: "token-1", auth_data: "auth-1" } });
        if (endpoint === "getSubscribe") return Response.json({ status: "success", data: {} });
        throw new Error("Unexpected synthetic API request");
      });
      try {
        const response = await handleRequest(new Request("https://worker.example/api/links", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessKey: "abc", email: "owner@example.invalid", password: "synthetic-password" }),
        }), { ACCESS_KEY: "abc", LINK_SECRET: "test-link-secret" });
        assert.ok(response.status >= 400);
        assert.equal((await response.text()).includes(marker), false);
      } finally {
        restoreFetch();
      }
    });
  }
});

test("scheduled refresh errors store sanitized diagnostics and preserve the last-good cache", async () => {
  const marker = "SENTINEL";
  const env = {
    ACCESS_KEY: "abc", LINK_SECRET: "test-link-secret", SUB_CACHE: new MemoryKV(),
    ENABLE_RULES_CRON: "false", ENABLE_PROFILE_CRON: "true",
  };
  await env.SUB_CACHE.put("profile:safe-errors", JSON.stringify({
    id: "safe-errors", baseUrl: "https://worker.example", options: { enableProfileSync: true },
    credentialToken: await encryptCredentialToken({ email: "owner@example.invalid", password: "synthetic-password" }, env.LINK_SECRET),
  }));
  let failingStage = "";
  const restoreFetch = installFetchMock(async (url) => {
    if (new URL(url).pathname.endsWith("/login")) {
      if (failingStage === "login") return new Response(`${marker} is not JSON`);
      return Response.json({ status: "success", data: { token: "token-1", auth_data: "auth-1" } });
    }
    return failingStage === "subscribe" ? new Response(marker, { status: 503 }) : new Response(clashYaml);
  });
  const refresh = async () => {
    const pending = [];
    await scheduled({}, env, { waitUntil: (promise) => pending.push(promise) });
    await Promise.all(pending);
  };
  try {
    await refresh();
    for (const stage of ["login", "subscribe"]) {
      failingStage = stage;
      await refresh();
      const record = JSON.parse(await env.SUB_CACHE.get("profile:safe-errors"));
      assert.ok(record.lastError);
      assert.equal(record.lastError.includes(marker), false);
      const subscription = await handleRequest(new Request("https://worker.example/p/safe-errors/sub/raw?key=abc"), env);
      assert.equal(subscription.status, 200);
      assert.equal(await subscription.text(), clashYaml);
    }
  } finally {
    restoreFetch();
  }
});
