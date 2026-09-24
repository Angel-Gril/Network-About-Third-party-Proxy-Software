import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRefreshSettingsStore, refreshTiming } from "../src/refresh-settings.mjs";

test("refresh settings default to six hours and persist provider overrides", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"refresh-settings-"));
  try {
    const file = path.join(root,"nested","settings.json");
    const store = createRefreshSettingsStore(file);
    const defaults = await store.get();
    assert.deepEqual(defaults.providers.monocloud,{enabled:true,intervalMinutes:360,retryMinutes:5});
    await store.update("monocloud",{enabled:false,intervalMinutes:720});
    const saved = await store.get();
    assert.deepEqual(saved.providers.monocloud,{enabled:false,intervalMinutes:720,retryMinutes:5});
    assert.deepEqual(saved.providers.flybird,{enabled:true,intervalMinutes:360,retryMinutes:5});
    await assert.rejects(store.update("monocloud",{enabled:true,intervalMinutes:1}), /outside/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("refresh timing uses the latest success or failure and honors the switch", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const metadata = {updatedAt:"2026-09-23T05:00:00Z",failedAt:"2026-09-23T10:00:00Z"};
  assert.equal(refreshTiming(metadata,{enabled:true,intervalMinutes:60},now).due,true);
  assert.equal(refreshTiming({updatedAt:"2026-09-23T10:00:00Z"},{enabled:true,intervalMinutes:180},now).due,false);
  assert.equal(refreshTiming({updatedAt:"2026-09-23T05:00:00Z",failedAt:"2026-09-23T11:54:00Z"},
    {enabled:true,intervalMinutes:360},now).due,true);
  assert.equal(refreshTiming({updatedAt:"2026-09-23T05:00:00Z",failedAt:"2026-09-23T11:54:00Z"},
    {enabled:true,intervalMinutes:360},now).retryMinutes,5);
  assert.deepEqual(refreshTiming(metadata,{enabled:false,intervalMinutes:60},now),{
    enabled:false,intervalMinutes:60,retryMinutes:5,due:false,nextAt:null,
  });
});
