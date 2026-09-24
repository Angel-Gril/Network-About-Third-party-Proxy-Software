import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isMainModule, runScheduledRefresh } from "../src/scheduled-refresh.mjs";

async function fixture(settings, metadata = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"scheduled-refresh-"));
  const cache = path.join(root,"cache");
  const settingsFile = path.join(root,"settings.json");
  await fs.mkdir(cache);
  await fs.writeFile(settingsFile,JSON.stringify({schemaVersion:1,providers:{monocloud:settings}}));
  if (metadata) await fs.writeFile(path.join(cache,"monocloud.json"),JSON.stringify(metadata));
  return {root,cache,settingsFile};
}

test("scheduled refresh skips disabled and not-due providers", async () => {
  for (const value of [
    {settings:{enabled:false,intervalMinutes:60},metadata:null,reason:"disabled"},
    {settings:{enabled:true,intervalMinutes:180},metadata:{updatedAt:"2026-09-23T10:00:00Z"},reason:"not_due"},
  ]) {
    const f=await fixture(value.settings,value.metadata);
    try {
      let called=false;
      const result=await runScheduledRefresh("monocloud",{cacheDirectory:f.cache,settingsFile:f.settingsFile,
        nowMs:Date.parse("2026-09-23T12:00:00Z"),runner:()=>{called=true;return 0;}});
      assert.equal(result.reason,value.reason);
      assert.equal(called,false);
    } finally { await fs.rm(f.root,{recursive:true,force:true}); }
  }
});

test("scheduled refresh runs a due provider and propagates its status", async () => {
  const f=await fixture({enabled:true,intervalMinutes:60},{updatedAt:"2026-09-23T10:00:00Z"});
  try {
    let selected=null;
    const result=await runScheduledRefresh("monocloud",{cacheDirectory:f.cache,settingsFile:f.settingsFile,
      nowMs:Date.parse("2026-09-23T12:00:00Z"),runner:(_script,provider)=>{selected=provider;return 0;}});
    assert.equal(result.ok,true);
    assert.equal(result.skipped,false);
    assert.equal(selected,"monocloud");
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});

test("a failed refresh is retried on the short failure backoff instead of the normal interval", async () => {
  const f=await fixture({enabled:true,intervalMinutes:360},{
    updatedAt:"2026-09-24T05:00:00Z", failedAt:"2026-09-24T11:54:00Z",
  });
  try {
    let calls=0;
    const result=await runScheduledRefresh("monocloud",{cacheDirectory:f.cache,settingsFile:f.settingsFile,
      nowMs:Date.parse("2026-09-24T12:00:00Z"),runner:()=>{calls+=1;return 1;}});
    assert.equal(result.skipped,false);
    assert.equal(result.ok,false);
    assert.equal(calls,1);
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});

test("the scheduler recognizes a symlinked current-release entrypoint", () => {
  const links = new Map([
    ["/opt/private-subscription/current/apps/subscription-server/src/scheduled-refresh.mjs", "/opt/private-subscription/releases/example/source/apps/subscription-server/src/scheduled-refresh.mjs"],
    ["/opt/private-subscription/releases/example/source/apps/subscription-server/src/scheduled-refresh.mjs", "/opt/private-subscription/releases/example/source/apps/subscription-server/src/scheduled-refresh.mjs"],
  ]);
  const resolvePath = value => links.get(value) || value;
  const urlToPath = value => new URL(value).pathname;
  assert.equal(isMainModule("/opt/private-subscription/current/apps/subscription-server/src/scheduled-refresh.mjs",
    "file:///opt/private-subscription/releases/example/source/apps/subscription-server/src/scheduled-refresh.mjs",
    resolvePath, urlToPath), true);
  assert.equal(isMainModule("/opt/private-subscription/current/apps/subscription-server/src/other.mjs",
    "file:///opt/private-subscription/releases/example/source/apps/subscription-server/src/scheduled-refresh.mjs",
    resolvePath, urlToPath), false);
});
