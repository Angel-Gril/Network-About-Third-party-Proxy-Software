import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function validateToken(value) {
  const token = String(value || "").trim();
  if (!TOKEN_PATTERN.test(token)) throw new Error("Subscription token is invalid");
  return token;
}

export async function createTokenStore(filePath) {
  if (!filePath) throw new Error("Subscription token file is required");
  let current = validateToken(await fs.readFile(filePath, "utf8"));
  let rotationQueue = Promise.resolve();

  return {
    get() {
      return current;
    },

    rotate() {
      const operation = rotationQueue.then(async () => {
        const token = randomBytes(32).toString("hex");
        const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        let handle;
        try {
          handle = await fs.open(temporary, "wx", 0o600);
          await handle.writeFile(`${token}\n`, "utf8");
          await handle.sync();
          await handle.close();
          handle = null;
          await fs.rename(temporary, filePath);
          current = token;
          return token;
        } finally {
          await handle?.close().catch(() => {});
          await fs.rm(temporary, { force: true }).catch(() => {});
        }
      });
      rotationQueue = operation.catch(() => {});
      return operation;
    },
  };
}
