// A project's persisted port can be taken by another project's node after the
// first one stops. Attaching by banner alone would adopt the wrong node, so the
// listening socket's owner has to match this project's recorded pid.
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, test } from "bun:test";
import { ownsNodeAt, portOwnerPid } from "../../src/node/supervisor.ts";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(): Promise<number> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("node port ownership", () => {
  test("reports the pid of the listening process", async () => {
    const port = await listen();
    if (process.platform !== "linux" && process.platform !== "darwin") return;

    expect(await portOwnerPid(port)).toBe(process.pid);
  });

  test("accepts the recorded pid that owns the port", async () => {
    const port = await listen();
    expect(await ownsNodeAt(port, process.pid)).toBe(true);
  });

  test("rejects a live pid that does not own the port", async () => {
    const port = await listen();
    expect(await ownsNodeAt(port, process.pid + 1)).toBe(false);
  });

  test("rejects a missing recorded pid", async () => {
    const port = await listen();
    expect(await ownsNodeAt(port, null)).toBe(false);
  });

  test("reports no owner for a closed port", async () => {
    const port = await listen();
    await new Promise<void>((resolve) => {
      servers.pop()?.close(() => resolve());
    });

    expect(await portOwnerPid(port)).toBeNull();
  });
});
