import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

test("the deployable Worker entry serves the provider page without upstream access", async () => {
  const response = await worker.fetch(new Request("https://worker.example.invalid/"), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /FlyingBird|FlyBird/);
  assert.equal(typeof worker.scheduled, "function");
});
