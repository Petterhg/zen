import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SHARED_PROTOCOL,
  indexSecret,
  sharedIndexPort,
  sharedIndexDirectory,
  receiveFrames,
  sendFrame,
  type RootStatus,
  type SharedRoot,
} from "./shared-index-protocol.js";
import type { DiscoveryRoot } from "./discovery.js";
import type { IndexHit, IndexFilter } from "./code-index.js";
export class SharedIndexClient {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      cleanup: () => void;
    }
  >();
  private disposed = false;
  private roots: DiscoveryRoot[] = [];
  private key = "";
  private rg = "rg";
  private registered = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private token = "";
  directory: string;
  constructor(
    private options: {
      directory?: string;
      daemonPath: string;
      changed: (roots: RootStatus[]) => void;
      disconnected?: () => void;
      start?: () => Promise<void>;
    },
  ) {
    this.directory = options.directory ?? sharedIndexDirectory();
  }
  private async ensure() {
    if (this.disposed) throw new Error("Index client closed.");
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return;
    this.connecting = this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  private async open() {
    this.token = await indexSecret(this.directory);
    this.directory = await realpath(this.directory);
    const attempt = () =>
      new Promise<Socket>((resolve, reject) => {
        const socket = connect(sharedIndexPort(this.directory), "127.0.0.1");
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.removeListener("error", reject);
          resolve(socket);
        });
      });
    let socket: Socket;
    try {
      socket = await attempt();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
      if (this.options.start) await this.options.start();
      else {
        const log = await open(
          path.join(this.directory, "daemon.log"),
          "a",
          0o600,
        );
        try {
          const child = spawn(
            process.execPath,
            [this.options.daemonPath, this.directory],
            {
              detached: true,
              stdio: ["ignore", log.fd, log.fd],
              env: {
                ...Object.fromEntries(
                  Object.entries(process.env).filter(
                    ([name]) =>
                      ![
                        "OPENAI_API_KEY",
                        "GROQ_API_KEY",
                        "CEREBRAS_API_KEY",
                        "FIRECRAWL_API_KEY",
                      ].includes(name),
                  ),
                ),
                ELECTRON_RUN_AS_NODE: "1",
              },
            },
          );
          child.on("error", () => {});
          child.unref();
        } finally {
          await log.close();
        }
      }
      const deadline = Date.now() + 15000;
      while (true) {
        try {
          socket = await attempt();
          break;
        } catch (e) {
          if (
            Date.now() > deadline ||
            (e as NodeJS.ErrnoException).code !== "ECONNREFUSED"
          )
            throw new Error(
              "Shared index service could not start. See its local daemon.log.",
            );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
    if (this.disposed) {
      socket.destroy();
      throw new Error("Index client closed.");
    }
    this.socket = socket;
    socket.on("error", () => {});
    receiveFrames(socket, (data) => {
      if (data.event === "status") {
        this.options.changed(data.roots as RootStatus[]);
        return;
      }
      const entry = this.pending.get(String(data.id));
      if (!entry) return;
      clearTimeout(entry.timer);
      entry.cleanup();
      this.pending.delete(String(data.id));
      if (data.error) entry.reject(new Error(String(data.error)));
      else entry.resolve(data.result);
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.cleanup();
        entry.reject(new Error("Shared index connection closed."));
      }
      this.pending.clear();
      if (!this.disposed && this.registered) {
        this.options.disconnected?.();
        this.scheduleReconnect();
      }
    });
    try {
      await this.requestRaw("hello", {}, undefined, {
        token: this.token,
        protocol: SHARED_PROTOCOL,
      });
      if (this.registered)
        await this.requestRaw("register", {
          roots: this.roots,
          key: this.key,
          rg: this.rg,
        });
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
  private scheduleReconnect() {
    if (this.disposed) return;
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => {
      void this.register(this.roots, this.key, this.rg).catch(() =>
        this.scheduleReconnect(),
      );
    }, 1500);
  }
  private requestRaw(
    method: string,
    params: object,
    signal?: AbortSignal,
    extra: object = {},
  ) {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        const e = this.pending.get(id);
        if (!e) return;
        clearTimeout(e.timer);
        e.cleanup();
        this.pending.delete(id);
        if (this.socket)
          sendFrame(this.socket, { method: "cancel", target: id });
        reject(new Error("Index request canceled."));
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(new Error("Shared index request timed out."));
      }, 30000);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (
        !this.socket ||
        !sendFrame(this.socket, { id, method, params, ...extra })
      ) {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(new Error("Shared index is disconnected."));
      }
    });
  }
  async register(
    roots: DiscoveryRoot[],
    key: string,
    rg: string,
  ): Promise<SharedRoot[]> {
    this.roots = roots;
    this.key = key;
    this.rg = rg;
    await this.ensure();
    const result = (await this.requestRaw("register", { roots, key, rg })) as {
      roots: SharedRoot[];
    };
    this.registered = true;
    clearTimeout(this.reconnect);
    return result.roots;
  }
  async refresh(checkout: string, file?: string, full = false, flush = false) {
    await this.ensure();
    await this.requestRaw("refresh", { checkout, file, full, flush });
  }
  async search(
    checkout: string,
    query: string,
    vector: number[],
    filter: IndexFilter,
    signal: AbortSignal,
  ): Promise<IndexHit[]> {
    await this.ensure();
    return (await this.requestRaw(
      "search",
      { checkout, query, vector, filter },
      signal,
    )) as IndexHit[];
  }
  async status() {
    await this.ensure();
    return (await this.requestRaw("status", {})) as {
      roots: RootStatus[];
      scopes: (SharedRoot & {
        files: number;
        chunks: number;
        services: string[];
      })[];
    };
  }
  close() {
    this.disposed = true;
    this.key = "";
    clearTimeout(this.reconnect);
    this.socket?.destroy();
  }
}
