import { createServer, type Socket } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { writeFile, realpath } from "node:fs/promises";
import { CodeIndex, type IndexFilter } from "./code-index.js";
import { CodeChunker } from "./code-chunks.js";
import { openAIEmbed, type Embed } from "./embeddings.js";
import type { DiscoveryRoot } from "./discovery.js";
import { SharedIndexCoordinator } from "./shared-index-coordinator.js";
import {
  SHARED_PROTOCOL,
  indexSecret,
  receiveFrames,
  sendFrame,
  sharedIndexPort,
} from "./shared-index-protocol.js";
export async function startSharedIndexServer(
  directory: string,
  options: { grammars: string; embed?: Embed; idleMs?: number },
) {
  const token = await indexSecret(directory);
  directory = await realpath(directory);
  const connections = new Map<
    Socket,
    {
      id: string;
      authenticated: boolean;
      pending: Map<string, AbortController>;
    }
  >();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  let coordinator: SharedIndexCoordinator;
  let closing = false;
  const lastPhase = new Map<Socket, string>();
  const pendingStatus = new Map<Socket, object>();
  const publish = () => {
    if (closing) return;
    for (const [socket, client] of connections) {
      if (!client.authenticated || !coordinator) continue;
      const roots = coordinator.statuses(client.id);
      const phase = roots.map((r) => r.checkout + ":" + r.state).join("|");
      const message = { event: "status", roots };
      if (lastPhase.get(socket) !== phase) {
        const pending = pendingStatus.get(socket);
        if (pending) sendFrame(socket, pending);
        pendingStatus.delete(socket);
        lastPhase.set(socket, phase);
        sendFrame(socket, message);
      } else pendingStatus.set(socket, message);
    }
    if (!publishTimer)
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        for (const [socket, message] of pendingStatus)
          sendFrame(socket, message);
        pendingStatus.clear();
      }, 50);
  };
  const server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    clearTimeout(idle);
    const client = {
      id: randomUUID(),
      authenticated: false,
      pending: new Map<string, AbortController>(),
    };
    connections.set(socket, client);
    // An unauthenticated local connection cannot keep the daemon alive forever.
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => {
      connections.delete(socket);
      lastPhase.delete(socket);
      pendingStatus.delete(socket);
      for (const controller of client.pending.values()) controller.abort();
      coordinator?.unregister(client.id);
      publish();
      if (!connections.size && !closing)
        idle = setTimeout(() => void close(), options.idleMs ?? 60000);
    });
    receiveFrames(socket, (data) => {
      if (data.method === "cancel") {
        if (client.authenticated)
          client.pending.get(String(data.target))?.abort();
        return;
      }
      const id = String(data.id ?? "");
      if (
        !id ||
        id.length > 100 ||
        client.pending.has(id) ||
        client.pending.size >= 32
      ) {
        socket.destroy();
        return;
      }
      const controller = new AbortController();
      client.pending.set(id, controller);
      void (async () => {
        await ready;
        if (!client.authenticated) {
          const supplied =
            typeof data.token === "string"
              ? Buffer.from(data.token)
              : Buffer.alloc(0);
          if (
            data.method !== "hello" ||
            supplied.length !== token.length ||
            !timingSafeEqual(supplied, Buffer.from(token)) ||
            data.protocol !== SHARED_PROTOCOL
          )
            throw new Error(
              "Shared index authentication/version mismatch. Quit all Zen windows and allow the old index service to exit (up to 60 seconds), then reopen.",
            );
          client.authenticated = true;
          socket.setTimeout(0);
          return { protocol: SHARED_PROTOCOL, pid: process.pid };
        }
        const params = (data.params ?? {}) as Record<string, unknown>;
        switch (data.method) {
          case "register": {
            if (
              !Array.isArray(params.roots) ||
              typeof params.key !== "string" ||
              params.key.length > 1000 ||
              typeof params.rg !== "string" ||
              params.rg.length > 4000
            )
              throw new Error("Invalid registration.");
            const roots = await coordinator.register(
              client.id,
              params.roots as DiscoveryRoot[],
              params.key,
              params.rg,
              controller.signal,
            );
            return { roots };
          }
          case "status":
            return {
              roots: coordinator.statuses(client.id),
              scopes: await coordinator.scopes(client.id),
            };
          case "refresh":
            coordinator.refresh(
              client.id,
              String(params.checkout),
              typeof params.file === "string" ? params.file : undefined,
              params.full === true,
              params.flush === true,
            );
            return {};
          case "search": {
            if (
              typeof params.query !== "string" ||
              params.query.length > 1500 ||
              !Array.isArray(params.vector) ||
              !params.filter ||
              typeof params.filter !== "object"
            )
              throw new Error("Invalid search.");
            return coordinator.search(
              client.id,
              String(params.checkout),
              params.query,
              params.vector as number[],
              params.filter as IndexFilter,
              controller.signal,
            );
          }
          default:
            throw new Error("Unknown shared index command.");
        }
      })()
        .then(
          (result) => {
            if (!controller.signal.aborted) sendFrame(socket, { id, result });
          },
          (error) => {
            sendFrame(socket, {
              id,
              error:
                error instanceof Error
                  ? error.message
                  : "Shared index request failed.",
            });
            if (!client.authenticated) socket.destroy();
          },
        )
        .finally(() => client.pending.delete(id));
    });
  });
  // Binding is the ownership election. Losers never open the database.
  let resolveReady!: () => void, rejectReady!: (e: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sharedIndexPort(directory), "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const chunker = new CodeChunker(options.grammars);
    const index = await CodeIndex.open(
      directory,
      options.embed ?? openAIEmbed(async () => undefined),
      chunker,
      true,
    );
    coordinator = new SharedIndexCoordinator(
      index,
      (checkout) =>
        options.embed ?? openAIEmbed(async () => coordinator.key(checkout)),
      publish,
    );
    await writeFile(
      path.join(directory, "service.json"),
      JSON.stringify({
        protocol: SHARED_PROTOCOL,
        pid: process.pid,
        port: sharedIndexPort(directory),
        storage: directory,
      }),
      { mode: 0o600 },
    );
    resolveReady();
  } catch (error) {
    rejectReady(error);
    for (const s of connections.keys()) s.destroy();
    server.close();
    throw error;
  }
  server.on("error", () => void close());
  async function close() {
    if (closing) return;
    closing = true;
    clearTimeout(idle);
    clearTimeout(publishTimer);
    for (const socket of connections.keys()) socket.destroy();
    await coordinator?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (!connections.size)
    idle = setTimeout(() => void close(), options.idleMs ?? 60000);
  return { close, coordinator, pid: process.pid };
}
