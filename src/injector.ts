import { CdpClient, type CdpEvent } from "./cdp.js";

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title?: string;
  attached?: boolean;
}

interface SessionState {
  targetId: string;
  type: string;
  url: string;
  scriptId?: string;
}

const INJECTABLE_TYPES = new Set(["page", "iframe", "webview"]);

function isInjectableTarget(t: TargetInfo): boolean {
  if (!INJECTABLE_TYPES.has(t.type)) return false;
  if (/^(devtools|chrome|chrome-extension|about):/i.test(t.url)) return false;
  return true;
}

/**
 * 负责发现 Cursor 的所有渲染 target（主窗口、Agent 窗口、OOPIF、webview），
 * 并向每个 target 注入翻译脚本；支持词典热更新与批量求值。
 */
export class Injector {
  private sessions = new Map<string, SessionState>();
  private source = "";
  private log: (msg: string) => void;

  constructor(private client: CdpClient, log: (msg: string) => void = console.log) {
    this.log = log;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  async start(source: string): Promise<void> {
    this.source = source;

    this.client.on("Target.attachedToTarget", (ev) => void this.onAttached(ev));
    this.client.on("Target.detachedFromTarget", (ev) => {
      const sid = ev.params.sessionId as string | undefined;
      if (sid && this.sessions.delete(sid)) this.log(`会话断开: ${sid.slice(0, 8)}`);
    });
    this.client.on("Target.targetCreated", (ev) => void this.onTargetCreated(ev));
    this.client.on("Target.targetDestroyed", (ev) => {
      const tid = ev.params.targetId as string;
      for (const [sid, s] of this.sessions) if (s.targetId === tid) this.sessions.delete(sid);
    });

    // 现有 target 也会以 targetCreated 事件推送
    await this.client.send("Target.setDiscoverTargets", { discover: true });
  }

  private attaching = new Set<string>();

  private async onTargetCreated(ev: CdpEvent): Promise<void> {
    const info = ev.params.targetInfo as TargetInfo;
    if (!isInjectableTarget(info)) return;
    if (this.attaching.has(info.targetId)) return;
    for (const s of this.sessions.values()) if (s.targetId === info.targetId) return;
    this.attaching.add(info.targetId);
    try {
      // flatten 模式：返回 sessionId，并随后触发 Target.attachedToTarget
      await this.client.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
    } catch (e) {
      this.log(`attach 失败 (${info.type} ${info.url}): ${(e as Error).message}`);
    } finally {
      this.attaching.delete(info.targetId);
    }
  }

  private async onAttached(ev: CdpEvent): Promise<void> {
    const sessionId = ev.params.sessionId as string;
    const info = ev.params.targetInfo as TargetInfo;
    if (this.sessions.has(sessionId)) return;
    if (!isInjectableTarget(info)) {
      // 自动附加到的非渲染 target（如 worker），直接分离
      this.client.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      return;
    }
    this.sessions.set(sessionId, { targetId: info.targetId, type: info.type, url: info.url });
    this.log(`已附加 ${info.type}: ${shortUrl(info.url)}`);
    await this.setupSession(sessionId);
  }

  private async setupSession(sessionId: string): Promise<void> {
    const quiet = () => undefined;
    await this.client.send("Page.enable", {}, sessionId).catch(quiet);
    // 让该页面的跨进程 iframe / webview 子 target 自动附加进来
    await this.client
      .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId)
      .catch(quiet);
    await this.injectInto(sessionId);
  }

  private async injectInto(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    try {
      if (state.scriptId) {
        await this.client
          .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: state.scriptId }, sessionId)
          .catch(() => undefined);
        state.scriptId = undefined;
      }
      // 之后每次导航/重载自动注入
      const r = await this.client
        .send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: this.source }, sessionId)
        .catch(() => undefined);
      if (r) state.scriptId = r.identifier;
      // 当前已加载的文档立即注入
      await this.client.send("Runtime.evaluate", { expression: this.source, returnByValue: true }, sessionId);
    } catch (e) {
      this.log(`注入失败 (${shortUrl(state.url)}): ${(e as Error).message}`);
    }
  }

  /** 词典变更后对所有会话重新注入（脚本幂等，仅替换词典） */
  async updateSource(source: string): Promise<void> {
    this.source = source;
    await Promise.all([...this.sessions.keys()].map((sid) => this.injectInto(sid)));
  }

  /** 在所有会话中执行表达式并收集返回值（returnByValue） */
  async evaluateAll<T>(expression: string): Promise<Array<{ url: string; type: string; value: T | undefined }>> {
    const out: Array<{ url: string; type: string; value: T | undefined }> = [];
    for (const [sid, s] of this.sessions) {
      try {
        const r = await this.client.send<{ result: { value?: T } }>(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          sid,
        );
        out.push({ url: s.url, type: s.type, value: r.result?.value });
      } catch (e) {
        this.log(`求值失败 (${shortUrl(s.url)}): ${(e as Error).message}`);
      }
    }
    return out;
  }
}

export function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    const file = url.pathname.split("/").pop() || url.pathname;
    return `${url.protocol}//${url.host ? url.host + "/…/" : ""}${file}`;
  } catch {
    return u.length > 80 ? u.slice(0, 77) + "…" : u;
  }
}
