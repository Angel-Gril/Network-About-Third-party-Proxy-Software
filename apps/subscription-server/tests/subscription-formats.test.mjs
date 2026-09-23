import assert from "node:assert/strict";
import test from "node:test";
import { proxiesToShareLinks, renderSubscription } from "../src/subscription-formats.mjs";

test("renders Shadowsocks and VLESS transports as portable share links", () => {
  const proxies = [
    { name:"SS 节点", type:"ss", server:"203.0.113.8", port:443,
      cipher:"chacha20-ietf-poly1305", password:"synthetic-secret" },
    { name:"Vision", type:"vless", server:"edge.example.invalid", port:8443,
      uuid:"11111111-1111-4111-8111-111111111111", network:"tcp", tls:true,
      servername:"sni.example.invalid", flow:"xtls-rprx-vision", "skip-cert-verify":true },
    { name:"WebSocket", type:"vless", server:"ws.example.invalid", port:443,
      uuid:"22222222-2222-4222-8222-222222222222", network:"ws", tls:true,
      "ws-opts":{path:"/socket?ed=2048",headers:{Host:"host.example.invalid"}} },
  ];
  const links = proxiesToShareLinks(proxies);
  assert.equal(links.length, 3);
  assert.match(links[0], /^ss:\/\//);
  assert.match(links[1], /security=tls/);
  assert.match(links[1], /flow=xtls-rprx-vision/);
  assert.match(links[2], /type=ws/);
  assert.match(links[2], /path=%2Fsocket%3Fed%3D2048/);
  assert.match(links[2], /host=host.example.invalid/);
});

test("v2rayN format is the Base64 encoding of the plain URI list", () => {
  const yaml = JSON.stringify({ proxies:[{name:"sample",type:"ss",server:"203.0.113.8",port:443,
    cipher:"aes-128-gcm",password:"synthetic-secret"}] });
  const plain = renderSubscription(yaml,"uri");
  assert.equal(Buffer.from(renderSubscription(yaml,"v2rayn"),"base64").toString("utf8"), plain);
  assert.equal(renderSubscription(yaml,"clash"), yaml);
});

test("unsupported proxy types fail instead of emitting partial subscriptions", () => {
  assert.throws(() => proxiesToShareLinks([{name:"sample",type:"unknown"}]), /unsupported proxy type/);
  assert.throws(() => proxiesToShareLinks([{name:"sample",type:"vless",uuid:"id",server:"edge.example",port:443,
    network:"grpc",tls:true}]), /unsupported proxy transport/);
  assert.throws(() => proxiesToShareLinks([{name:"sample",type:"ss",server:"edge.example",port:443,
    cipher:"aes-128-gcm",password:"secret",plugin:"obfs"}]), /unsupported proxy transport/);
});
