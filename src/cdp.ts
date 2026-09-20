import WebSocket from "ws";
import http from "node:http";

/** CDP 事件消息 */
export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
}

export class CdpError extends Error {
  constructor(method: string, public readonly code: number, message: string) {
    super(`${method} 失败 (${code}): ${message}`);
  }
}

/**
 * 极简 Chrome DevTools Protocol 客户端。
 * 连接到浏览器级 endpoint，使用 flatten 会话模式，通过 sessionId 区分各个 target。
 */
export class CdpClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(ev: CdpEvent) => void>>();
  private closeHandlers = new Set<() => void>();

  static async connect(wsUrl: string): Promise<CdpClient> {
    const client = new CdpClient();
    await client.open(wsUrl);
    return client;
  }

  private open(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // 不发送 Origin 头：Chromium 对无 Origin 的 WebSocket 调试连接不做来源校验
      this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });
      this.ws.once("open", () => resolve());
      this.ws.once("error", (e) => reject(e));
      this.ws.on("message", (data) => this.onMessage(data.toString()));
      this.ws.on("close", () => {
        for (const p of this.pending.values()) {
          p.reject(new Error(`连接已关闭，${p.method} 未完成`));
        }
        this.pending.clear();
        for (const h of this.closeHandlers) h();
      });
    });
  }

  private onMessage(text: string): void {
    let msg: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const ev: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
      const set = this.listeners.get(msg.method);
      if (set) for (const fn of set) fn(ev);
      const all = this.listeners.get("*");
      if (all) for (const fn of all) fn(ev);
    }
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  on(method: string, fn: (ev: CdpEvent) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  onClose(fn: () => void): void {
    this.closeHandlers.add(fn);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** 通过 /json/version 获取浏览器级 WebSocket 地址 */
export function fetchBrowserWsUrl(port: number, timeoutMs = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/json/version", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(body) as { webSocketDebuggerUrl?: string };
            if (!j.webSocketDebuggerUrl) return reject(new Error("/json/version 未返回 webSocketDebuggerUrl"));
            resolve(j.webSocketDebuggerUrl);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

/** 轮询直到调试端口就绪 */
export async function waitForDebugPort(port: number, totalMs: number, intervalMs = 400): Promise<string> {
  const deadline = Date.now() + totalMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetchBrowserWsUrl(port);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(
    `在 ${totalMs / 1000}s 内未能连接到 127.0.0.1:${port} 的调试端口（最后错误: ${(lastErr as Error)?.message ?? lastErr}）。` +
      `可能原因：Cursor 已有实例在运行（新进程把参数转交后退出）、端口被占用、或 Cursor 禁用了 --remote-debugging-port。`,
  );
}
