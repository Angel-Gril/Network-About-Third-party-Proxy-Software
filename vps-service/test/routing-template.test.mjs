import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { applyRoutingTemplate } from "../src/routing-template.mjs";

const proxy = {name:'日本 "A" \\ edge', type:"vless", server:"example.invalid", port:443,
  uuid:"11111111-1111-4111-8111-111111111111", network:"ws", tls:true,
  "skip-cert-verify":true, "ws-opts":{path:"/a?ed=2048",headers:{Host:"edge.example.invalid"}}};
const input = {"mixed-port":7890, "allow-lan":false, proxies:[proxy],
  "proxy-groups":[{name:"obsolete",type:"select",proxies:[proxy.name]}],rules:["MATCH,obsolete"]};

function renderer(text, base) {
  const config=YAML.parse(text);
  assert.equal(config.rules, undefined);
  assert.equal(config["proxy-groups"], undefined);
  assert.deepEqual(config.proxies,[proxy]);
  // The existing worker reads each node as one JSON flow-map line.
  assert.equal(text.split("\n").filter(line=>line.trim().startsWith('- {')).length,1);
  return YAML.stringify({...config,"geodata-mode":true,"geo-auto-update":true,"geo-update-interval":24,
    "geox-url":{geoip:base+"/rules/geoip.dat",geosite:base+"/rules/geosite.dat"},
    "proxy-groups":[{name:"shared",type:"select",proxies:[proxy.name,"DIRECT"]}],
    rules:["GEOSITE,cn,DIRECT","MATCH,shared"]});
}

test("routing bridge preserves nested WebSocket credentials and replaces the basic policy",()=>{
  const result=applyRoutingTemplate(JSON.stringify(input),"https://sub.example.invalid",renderer,{dns:{enable:true}});
  const config=YAML.parse(result.yaml);
  assert.deepEqual(config.proxies,input.proxies);
  assert.equal(config["mixed-port"],7890);
  assert.equal(config["allow-lan"],false);
  assert.equal(config.dns.enable,true);
  assert.equal(config.mode,"rule");
  assert.equal(config.rules.at(-1),"MATCH,shared");
  assert.equal(config["geo-update-interval"],24);
  assert.deepEqual(result.routing,{template:"flybird",proxyGroupCount:1,ruleCount:2,geoUpdateIntervalHours:24});
});

test("explicit DNS settings override the shared defaults",()=>{
  const result=applyRoutingTemplate(JSON.stringify({...input,dns:{enable:false}}),"https://sub.example.invalid",renderer,{dns:{enable:true}});
  assert.equal(YAML.parse(result.yaml).dns.enable,false);
});

test("a renderer cannot silently alter connection credentials or leave unknown policies",()=>{
  for (const mutate of [
    config=>{config.proxies[0].uuid="22222222-2222-4222-8222-222222222222";},
    config=>{config["proxy-groups"][0].proxies.push("missing");},
    config=>{config.rules.push("MATCH,missing");},
    config=>{config["proxy-groups"].push({...config["proxy-groups"][0]});},
  ]) {
    const broken=(text,base)=>{const config=YAML.parse(renderer(text,base));mutate(config);return YAML.stringify(config);};
    assert.throws(()=>applyRoutingTemplate(JSON.stringify(input),"https://sub.example.invalid",broken));
  }
});

test("invalid node names and non-HTTPS rule origins are rejected",()=>{
  const bad={...input,proxies:[{...proxy,name:"bad\nname"}]};
  assert.throws(()=>applyRoutingTemplate(JSON.stringify(bad),"https://sub.example.invalid",renderer));
  assert.throws(()=>applyRoutingTemplate(JSON.stringify(input),"http://sub.example.invalid",renderer));
});
