"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Client, ConversationEntry, ProjectState, TurnResult, Usage, DeliverableType, ModelSelection, ProviderId,
} from "@/lib/types";
import { SPEC_DOCS, DELIVERABLE_TYPES } from "@/lib/types";

const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`;
const fmtCost = (u: number) => (u >= 0.01 ? `$${u.toFixed(2)}` : `$${u.toFixed(4)}`);
const fmtSecs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
};

type Lang = "zh" | "en";
const STR = {
  zh: {
    clients: "客户", newClient: "＋ 新客户", clientName: "客户名称", background: "客户背景 / 自我介绍",
    bgPh: "简单介绍这个客户：是谁、做什么、目标受众、风格偏好…（会被该客户下所有项目共享）",
    create: "创建", cancel: "取消", noClients: "还没有客户，先建一个",
    newProject: "＋ 新项目", projectName: "项目名称", deliverable: "交付物", deliverableName: "交付物命名",
    dlvPh: "如：我的视频简历 / 产品发布 PPT", noProjects: "该客户下还没有项目",
    pick: "← 选择或新建一个项目开始", you: "FDE Copilot", customer: "客户",
    composerPh: "说说你的情况和诉求（v0 文字；语音/图片/PDF 下一版）", sendHint: "⌘/Ctrl+Enter 发送",
    send: "发送", sending: "生成中…", working: "正在读现状、更新规格、调研缺口…（1–3 分钟）",
    specs: "规格", readinessLabel: "就绪度", loopReady: "✅ loop-ready", notReady: "尚未就绪",
    missing: "还缺", specsEmpty: "规格文档会随对话实时生成", empty: "（空）",
    tokens: "tokens", cache: "缓存", computeSecs: "计算秒", roundsRefresh: "轮 · 每 3 分钟刷新",
    theWorkbench: "生成「{x}」的 workbench", collapse: "折叠", rounds: "轮", ready: "就绪",
    provider: "模型后端", model: "模型", unavailable: "不可用",
    uploadSpec: "⬆ 上传 spec 构建", uploadTitle: "上传现成 spec · 一键构建",
    uSub: "上传一份 markdown 规格（或用当前 SPEC），loop-engineer 直接据此建 job 编码",
    uClient: "客户 slug", uProject: "项目 slug", uRepo: "目标仓库 (GitHub)",
    uFile: "选择 markdown 文件", uUseCurrent: "用当前 SPEC.md", uSpecBody: "spec 内容（可编辑）",
    uSpecPh: "# 你的规格…（上传文件或粘贴 markdown 全文）",
    build: "🚀 构建", building: "提交中…", jobTitle: "构建任务", jobState: "状态",
    jobProgress: "进度", jobCurrent: "当前", viewPr: "查看 PR ↗", viewApp: "在线预览 ↗",
    jobDone: "✅ 完成", jobFailed: "❌ 失败", closeJob: "关闭",
  },
  en: {
    clients: "Clients", newClient: "＋ New client", clientName: "Client name", background: "Client background / intro",
    bgPh: "Briefly introduce this client: who, what, audience, style… (shared by all their projects)",
    create: "Create", cancel: "Cancel", noClients: "No clients yet — create one",
    newProject: "＋ New project", projectName: "Project name", deliverable: "Deliverable", deliverableName: "Deliverable name",
    dlvPh: "e.g. My video resume / Launch PPT", noProjects: "No projects for this client yet",
    pick: "← Select or create a project to start", you: "FDE Copilot", customer: "You",
    composerPh: "Describe your situation and needs (v0: text)", sendHint: "⌘/Ctrl+Enter to send",
    send: "Send", sending: "Generating…", working: "Reading state, updating specs, researching gaps… (1–3 min)",
    specs: "Specs", readinessLabel: "Readiness", loopReady: "✅ loop-ready", notReady: "not ready yet",
    missing: "missing", specsEmpty: "Spec docs generate as you talk", empty: "(empty)",
    tokens: "tokens", cache: "cache", computeSecs: "compute-s", roundsRefresh: "turns · refresh 3 min",
    theWorkbench: "Workbench that generates “{x}”", collapse: "Collapse", rounds: "rounds", ready: "ready",
    provider: "Provider", model: "Model", unavailable: "unavailable",
    uploadSpec: "⬆ Build from spec", uploadTitle: "Upload a spec · one-click build",
    uSub: "Upload a markdown spec (or use the current SPEC); loop-engineer builds a job from it",
    uClient: "Client slug", uProject: "Project slug", uRepo: "Target repo (GitHub)",
    uFile: "Choose a markdown file", uUseCurrent: "Use current SPEC.md", uSpecBody: "Spec content (editable)",
    uSpecPh: "# Your spec… (upload a file or paste the full markdown)",
    build: "🚀 Build", building: "Submitting…", jobTitle: "Build job", jobState: "State",
    jobProgress: "Progress", jobCurrent: "Current", viewPr: "View PR ↗", viewApp: "Live preview ↗",
    jobDone: "✅ Done", jobFailed: "❌ Failed", closeJob: "Close",
  },
} as const;

interface ProjectDetail {
  client: Client;
  state: ProjectState;
  docs: Record<string, string>;
  conversation: ConversationEntry[];
}

interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  available: boolean;
  models: string[];
  error?: string;
}

export default function Workbench() {
  const [clients, setClients] = useState<Client[]>([]);
  const [projectsByClient, setProjectsByClient] = useState<Record<string, ProjectState[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeClient, setActiveClient] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [activeDoc, setActiveDoc] = useState<string>("SPEC.md");
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [lang, setLang] = useState<Lang>("zh");
  const [sidebar, setSidebar] = useState(true);
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [defaultSelection, setDefaultSelection] = useState<ModelSelection>({ provider: "claude" });
  const [newClient, setNewClient] = useState<{ name: string; background: string } | null>(null);
  const [newProject, setNewProject] = useState<{
    client: string; name: string; dlvName: string; dlvType: DeliverableType; provider: ProviderId; model: string;
  } | null>(null);
  // CC-61「上传现成 spec 一键构建」：上传 markdown → /api/plan → 轮询 job 状态
  const [uploadSpec, setUploadSpec] = useState<
    { client: string; project: string; repo: string; spec: string; fileName: string } | null
  >(null);
  const [buildingSpec, setBuildingSpec] = useState(false);
  const [job, setJob] = useState<
    {
      jobId: string; clientSlug: string; projectSlug: string; state: string;
      percent?: number; done?: number; total?: number; current?: string;
      prUrl?: string; appUrl?: string; costUsd?: number; error?: string;
    } | null
  >(null);
  const t = STR[lang];
  const chatEndRef = useRef<HTMLDivElement>(null);
  // 工作台切换条 URL（部署时用 NEXT_PUBLIC_WB_*_URL 覆盖为你的域名）
  const WB = {
    fde: process.env.NEXT_PUBLIC_WB_FDE_URL || "http://localhost:3939",
    loop: process.env.NEXT_PUBLIC_WB_LOOP_URL || "http://localhost:4040",
    packs: process.env.NEXT_PUBLIC_WB_PACKS_URL || "http://localhost:4141",
    site: process.env.NEXT_PUBLIC_WB_SITE_URL || "http://localhost:8080",
  };

  const flash = (msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 4000);
  };

  const loadClients = useCallback(async () => {
    const r = await fetch("/api/clients");
    const j = await r.json();
    setClients(j.clients ?? []);
  }, []);

  const loadProjects = useCallback(async (clientSlug: string) => {
    const r = await fetch(`/api/clients/${clientSlug}/projects`);
    if (!r.ok) return;
    const j = await r.json();
    setProjectsByClient((m) => ({ ...m, [clientSlug]: j.projects ?? [] }));
  }, []);

  const loadDetail = useCallback(async (c: string, p: string) => {
    const r = await fetch(`/api/clients/${c}/projects/${p}`);
    if (!r.ok) return;
    setDetail((await r.json()) as ProjectDetail);
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      const r = await fetch("/api/usage");
      if (r.ok) setUsage((await r.json()).global as Usage);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadClients();
    loadUsage();
    fetch("/api/providers").then(async (r) => {
      if (!r.ok) return;
      const j = await r.json();
      setProviders(j.providers ?? []);
      setDefaultSelection(j.defaultSelection ?? { provider: "claude" });
    }).catch(() => undefined);
    const t2 = setInterval(loadUsage, 180_000);
    if (typeof window !== "undefined") {
      const l = localStorage.getItem("fde:lang");
      if (l === "en" || l === "zh") setLang(l);
    }
    return () => clearInterval(t2);
  }, [loadClients, loadUsage]);

  useEffect(() => {
    if (activeClient && activeProject) loadDetail(activeClient, activeProject);
  }, [activeClient, activeProject, loadDetail]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.conversation.length, sending]);

  const toggleLang = () => {
    const next: Lang = lang === "zh" ? "en" : "zh";
    setLang(next);
    if (typeof window !== "undefined") localStorage.setItem("fde:lang", next);
  };

  const toggleExpand = async (slug: string) => {
    const nx = new Set(expanded);
    if (nx.has(slug)) nx.delete(slug);
    else {
      nx.add(slug);
      if (!projectsByClient[slug]) await loadProjects(slug);
    }
    setExpanded(nx);
  };

  const createClient = async () => {
    if (!newClient?.name.trim()) return;
    const r = await fetch("/api/clients", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(newClient),
    });
    const j = await r.json();
    if (!r.ok) return flash(j.error ?? "创建失败", true);
    setNewClient(null);
    await loadClients();
    setExpanded((s) => new Set(s).add(j.client.slug));
  };

  const createProject = async () => {
    if (!newProject?.name.trim()) return;
    const r = await fetch(`/api/clients/${newProject.client}/projects`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: newProject.name,
        deliverableName: newProject.dlvName || newProject.name,
        deliverableType: newProject.dlvType,
        provider: newProject.provider,
        model: newProject.model || undefined,
      }),
    });
    const j = await r.json();
    if (!r.ok) return flash(j.error ?? "创建失败", true);
    await loadProjects(newProject.client);
    setActiveClient(newProject.client);
    setActiveProject(j.project.slug);
    setNewProject(null);
  };

  const send = async () => {
    if (!activeClient || !activeProject || !input.trim() || sending) return;
    const text = input.trim();
    setInput("");
    setSending(true);
    setDetail((d) =>
      d ? { ...d, conversation: [...d.conversation, { role: "customer", at: new Date().toISOString(), text }] } : d,
    );
    try {
      const r = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientSlug: activeClient, projectSlug: activeProject, input: text }),
      });
      const j = await r.json();
      if (!r.ok) flash(j.error ?? "发送失败", true);
      else {
        const res = j.result as TurnResult;
        if (j.usedFallback) flash("未返回结构化结果，已用兜底文本", true);
        if (res.readiness.loop_ready) flash("🎉 规格已达 loop-ready！");
      }
    } catch (e) {
      flash(`网络错误：${(e as Error).message}`, true);
    } finally {
      setSending(false);
      await Promise.all([
        activeClient && activeProject ? loadDetail(activeClient, activeProject) : null,
        activeClient ? loadProjects(activeClient) : null,
        loadUsage(),
      ]);
    }
  };

  const commit = async (push: boolean) => {
    if (!activeClient || !activeProject) return;
    const r = await fetch("/api/commit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientSlug: activeClient, projectSlug: activeProject, push }),
    });
    const j = await r.json();
    flash(r.ok ? (j.detail ?? "已提交") : (j.error ?? "提交失败"), !r.ok);
  };

  const saveModelSelection = async (selection: ModelSelection) => {
    if (!activeClient || !activeProject) return;
    const r = await fetch(`/api/clients/${activeClient}/projects/${activeProject}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(selection),
    });
    const j = await r.json();
    if (!r.ok) return flash(j.error ?? "模型配置保存失败", true);
    setDetail((current) => current ? { ...current, state: j.state } : current);
    await loadProjects(activeClient);
  };

  // 打开「上传 spec 构建」：优先用当前选中项目预填 client/project/repo，spec 预填当前 SPEC.md
  const openUpload = () =>
    setUploadSpec({
      client: activeClient ?? "",
      project: activeProject ?? "",
      repo: activeProject ? `https://github.com/clestons/${activeProject}` : "",
      spec: detail?.docs["SPEC.md"] ?? "",
      fileName: "",
    });

  const onSpecFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = () =>
      setUploadSpec((u) => (u ? { ...u, spec: String(reader.result ?? ""), fileName: f.name } : u));
    reader.readAsText(f);
  };

  const startBuild = async () => {
    if (!uploadSpec || buildingSpec) return;
    const client = uploadSpec.client.trim();
    const project = uploadSpec.project.trim();
    const repo = uploadSpec.repo.trim();
    const spec = uploadSpec.spec;
    if (!client || !project || !repo) return flash("客户 / 项目 / 仓库均必填", true);
    if (!spec.trim()) return flash("spec 为空：上传文件或粘贴 markdown", true);
    setBuildingSpec(true);
    try {
      const r = await fetch("/api/plan", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientSlug: client, projectSlug: project, repo, spec }),
      });
      const j = await r.json();
      if (!r.ok) return flash(j.error ?? "构建失败", true);
      setJob({ jobId: j.jobId, clientSlug: client, projectSlug: project, state: "planning" });
      setUploadSpec(null);
      flash(`已建 job：${j.jobId}`);
    } catch (e) {
      flash(`网络错误：${(e as Error).message}`, true);
    } finally {
      setBuildingSpec(false);
    }
  };

  // job 进度轮询（每 4s），到 done/failed 停止
  useEffect(() => {
    if (!job || job.state === "done" || job.state === "failed") return;
    let alive = true;
    const tick = async () => {
      try {
        const qs = new URLSearchParams({
          jobId: job.jobId, clientSlug: job.clientSlug, projectSlug: job.projectSlug,
        });
        const r = await fetch(`/api/plan?${qs.toString()}`);
        if (!r.ok || !alive) return;
        const j = await r.json();
        setJob((prev) =>
          prev && prev.jobId === job.jobId
            ? {
                ...prev,
                state: j.state ?? prev.state,
                percent: j.progress?.percent,
                done: j.progress?.done,
                total: j.progress?.total,
                current: j.progress?.current?.title,
                prUrl: j.prUrl, appUrl: j.appUrl, costUsd: j.costUsd, error: j.error,
              }
            : prev,
        );
      } catch { /* ignore transient */ }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(id); };
  }, [job?.jobId, job?.state]);

  const readiness = detail?.state.lastReadiness;
  const dlvLabel = (type: string) =>
    DELIVERABLE_TYPES.find((d) => d.id === type)?.[lang === "zh" ? "label" : "labelEn"] ?? type;

  return (
    <div className="shell">
      <div className="wbnav">
        <span className="wbbrand">WORKBENCH</span>
        <a href={WB.fde} className="cur">① 需求 fde-copilot</a>
        <span className="wbsep">→</span>
        <a href={WB.loop}>② 造 loop-engineer</a>
        <span className="wbsep">→</span>
        <a href={WB.packs}>③ 能力 capability-packs</a>
        <a className="wbsite" href={WB.site}>官网 ↗</a>
      </div>
      <header className="topbar">
        <div className="brand">
          <button className="ghost icon" onClick={() => setSidebar((s) => !s)} title={t.collapse}>
            {sidebar ? "⟨" : "☰"}
          </button>
          FDE Copilot
        </div>
        <div className="stats">
          <span className="stat">🔢 <b>{usage ? fmtTokens(usage.inputTokens + usage.outputTokens) : "—"}</b> {t.tokens}</span>
          <span className="stat">⚙️ <b>{usage ? fmtSecs(usage.computeMs) : "—"}</b> {t.computeSecs}</span>
          <span className="stat" title="等效 API 成本，订阅实付≈0">💰 <b>{usage ? fmtCost(usage.costUsd) : "—"}</b></span>
          <span className="stat dim">{usage ? usage.turns : 0} {t.roundsRefresh}</span>
          <button className="ghost" onClick={toggleLang}>{lang === "zh" ? "EN" : "中"}</button>
        </div>
        {toast && <span className={`toast ${toast.err ? "err" : ""}`}>{toast.msg}</span>}
      </header>

      <div className={`app ${sidebar ? "" : "nosidebar"}`}>
        {/* 左：客户 → 项目 树（可折叠） */}
        {sidebar && (
          <div className="col sidebar">
            <div className="col-head">
              <h2>{t.clients}</h2>
              <button className="ghost sm" onClick={() => setNewClient({ name: "", background: "" })}>{t.newClient}</button>
            </div>
            <div className="col-body">
              {clients.length === 0 && <div className="empty">{t.noClients}</div>}
              {clients.map((c) => (
                <div key={c.slug} className="tree-client">
                  <div className="tree-row" onClick={() => toggleExpand(c.slug)}>
                    <span className="caret">{expanded.has(c.slug) ? "▾" : "▸"}</span>
                    <span className="cname">{c.name}</span>
                  </div>
                  {expanded.has(c.slug) && (
                    <div className="tree-projects">
                      {(projectsByClient[c.slug] ?? []).map((p) => (
                        <div
                          key={p.slug}
                          className={`tree-project ${activeClient === c.slug && activeProject === p.slug ? "active" : ""}`}
                          onClick={() => { setActiveClient(c.slug); setActiveProject(p.slug); }}
                        >
                          <div className="pname">{p.name}</div>
                          <div className="pmeta">
                            <span className={`badge ${p.status}`}>{p.status}</span>
                            <span>{dlvLabel(p.deliverable.type)}</span>
                          </div>
                        </div>
                      ))}
                      {(projectsByClient[c.slug]?.length ?? 0) === 0 && <div className="empty sm">{t.noProjects}</div>}
                      <button
                        className="ghost sm block"
                        onClick={() => setNewProject({
                          client: c.slug,
                          name: "",
                          dlvName: "",
                          dlvType: "video",
                          provider: defaultSelection.provider,
                          model: defaultSelection.model ?? "",
                        })}
                      >
                        {t.newProject}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 中：对话 */}
        <div className="col">
          <div className="col-head">
            <h2>{detail ? `${detail.client.name} · ${detail.state.name}` : "—"}</h2>
          </div>
          <div className="col-body">
            {!detail && <div className="empty">{t.pick}</div>}
            {detail?.conversation.map((e, i) => (
              <div key={i} className={`msg ${e.role}`}>
                <div className="who">{e.role === "customer" ? t.customer : t.you}</div>
                <div className="bubble">{e.text}</div>
                {e.result && e.result.open_questions.length > 0 && (
                  <div className="questions">
                    {e.result.open_questions.map((q) => (
                      <div className="q" key={q.id}><div>❓ {q.question}</div><div className="why">{q.why}</div></div>
                    ))}
                  </div>
                )}
                {e.result && <div className="readiness-bar"><span style={{ width: `${e.result.readiness.score}%` }} /></div>}
              </div>
            ))}
            {sending && (
              <div className="msg copilot">
                <div className="who">{t.you}</div>
                <div className="bubble"><span className="spinner" />{t.working}</div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          {detail && (
            <div className="composer">
              <textarea rows={3} placeholder={t.composerPh} value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} />
              <div className="row">
                <span className="hint">{t.sendHint}</span><div style={{ flex: 1 }} />
                <button className="primary" onClick={send} disabled={sending || !input.trim()}>
                  {sending ? t.sending : t.send}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 右：交付物优先 + 规格 */}
        <div className="col">
          <div className="col-head">
            <h2>{t.deliverable}</h2>
            <div style={{ display: "flex", gap: 6 }}>
              {detail && (
                <>
                  <button className="ghost" onClick={() => commit(false)}>commit</button>
                  <button className="ghost" onClick={() => commit(true)}>commit+push</button>
                </>
              )}
              <button className="ghost" onClick={openUpload} title={t.uploadTitle}>{t.uploadSpec}</button>
            </div>
          </div>

          {/* CC-61：构建任务进度卡（上传 spec → loop 建 job → 轮询） */}
          {job && (
            <div className="jobcard">
              <div className="jobcard-head">
                <b>{t.jobTitle}</b>
                <code>{job.jobId}</code>
                <div style={{ flex: 1 }} />
                <button className="ghost sm" onClick={() => setJob(null)}>{t.closeJob}</button>
              </div>
              <div className="jobcard-row">
                <span className="hint">{t.jobState}</span>
                <span className={`badge ${job.state}`}>
                  {job.state === "done" ? t.jobDone : job.state === "failed" ? t.jobFailed : job.state}
                </span>
                {typeof job.costUsd === "number" && job.costUsd > 0 && (
                  <span className="hint" style={{ marginLeft: 8 }}>{fmtCost(job.costUsd)}</span>
                )}
              </div>
              {typeof job.total === "number" && job.total > 0 && (
                <>
                  <div className="jobcard-row">
                    <span className="hint">{t.jobProgress}</span>
                    <span>{job.done ?? 0}/{job.total} · {job.percent ?? 0}%</span>
                  </div>
                  <div className="readiness-bar" style={{ marginTop: 4 }}>
                    <span style={{ width: `${job.percent ?? 0}%` }} />
                  </div>
                  {job.current && job.state !== "done" && (
                    <div className="hint" style={{ marginTop: 4 }}>{t.jobCurrent}：{job.current}</div>
                  )}
                </>
              )}
              {job.error && <div className="toast err" style={{ position: "static", marginTop: 6, whiteSpace: "pre-wrap" }}>{job.error}</div>}
              <div className="jobcard-links">
                {job.prUrl && <a href={job.prUrl} target="_blank" rel="noreferrer">{t.viewPr}</a>}
                {job.appUrl && <a href={job.appUrl} target="_blank" rel="noreferrer">{t.viewApp}</a>}
              </div>
            </div>
          )}
          {detail && (
            <div className="deliverable">
              <div className="dlv-type">{dlvLabel(detail.state.deliverable.type)}</div>
              <div className="dlv-name">{detail.state.deliverable.name}</div>
              <div className="dlv-sub">{t.theWorkbench.replace("{x}", detail.state.deliverable.name)}</div>
              <div className="model-picker">
                <label>{t.provider}</label>
                <select
                  value={(detail.state.model ?? defaultSelection).provider}
                  onChange={(e) => {
                    const provider = e.target.value as ProviderId;
                    const firstModel = providers.find((p) => p.id === provider)?.models[0];
                    saveModelSelection({ provider, ...(firstModel ? { model: firstModel } : {}) });
                  }}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available}>
                      {p.label}{p.available ? "" : ` (${t.unavailable})`}
                    </option>
                  ))}
                </select>
                {(detail.state.model ?? defaultSelection).provider === "lmstudio" && (
                  <>
                    <label>{t.model}</label>
                    <select
                      value={(detail.state.model ?? defaultSelection).model ?? ""}
                      onChange={(e) => saveModelSelection({ provider: "lmstudio", model: e.target.value })}
                    >
                      {providers.find((p) => p.id === "lmstudio")?.models.map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                  </>
                )}
              </div>
              {readiness && (
                <div className="hint" style={{ marginTop: 10 }}>
                  {t.readinessLabel} <b style={{ color: "var(--text)" }}>{readiness.score}/100</b>
                  {readiness.loop_ready ? ` · ${t.loopReady}` : ` · ${t.notReady}`}
                  {readiness.missing.length > 0 && <span> · {t.missing}：{readiness.missing.join("、")}</span>}
                </div>
              )}
              <div className="tabs" style={{ marginTop: 10 }}>
                {SPEC_DOCS.map((doc) => (
                  <div key={doc} className={`tab ${doc === activeDoc ? "active" : ""}`} onClick={() => setActiveDoc(doc)}>
                    {doc.replace(".md", "")}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="col-body">
            {!detail && <div className="empty">{t.specsEmpty}</div>}
            {detail && <div className="doc">{detail.docs[activeDoc] ?? t.empty}</div>}
          </div>
        </div>
      </div>

      {/* 新建客户 */}
      {newClient && (
        <div className="modal-bg" onClick={() => setNewClient(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t.newClient.replace("＋ ", "")}</h3>
            <label>{t.clientName}</label>
            <input value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} autoFocus />
            <label>{t.background}</label>
            <textarea rows={4} placeholder={t.bgPh} value={newClient.background}
              onChange={(e) => setNewClient({ ...newClient, background: e.target.value })} />
            <div className="modal-actions">
              <button className="ghost" onClick={() => setNewClient(null)}>{t.cancel}</button>
              <button className="primary" onClick={createClient} disabled={!newClient.name.trim()}>{t.create}</button>
            </div>
          </div>
        </div>
      )}

      {/* CC-61：上传现成 spec 一键构建 */}
      {uploadSpec && (
        <div className="modal-bg" onClick={() => setUploadSpec(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t.uploadTitle}</h3>
            <div className="hint" style={{ marginBottom: 8 }}>{t.uSub}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label>{t.uClient}</label>
                <input value={uploadSpec.client}
                  onChange={(e) => setUploadSpec({ ...uploadSpec, client: e.target.value })} />
              </div>
              <div style={{ flex: 1 }}>
                <label>{t.uProject}</label>
                <input value={uploadSpec.project}
                  onChange={(e) => setUploadSpec({ ...uploadSpec, project: e.target.value })} />
              </div>
            </div>
            <label>{t.uRepo}</label>
            <input placeholder="https://github.com/<owner>/<repo>" value={uploadSpec.repo}
              onChange={(e) => setUploadSpec({ ...uploadSpec, repo: e.target.value })} />
            <label>{t.uSpecBody}</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <input type="file" accept=".md,.markdown,.txt,text/markdown,text/plain"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onSpecFile(f); }} />
              {uploadSpec.fileName && <span className="hint">{uploadSpec.fileName}</span>}
            </div>
            <textarea rows={10} placeholder={t.uSpecPh} value={uploadSpec.spec}
              onChange={(e) => setUploadSpec({ ...uploadSpec, spec: e.target.value })}
              style={{ fontFamily: "var(--mono, monospace)", fontSize: 12 }} />
            <div className="modal-actions">
              <button className="ghost" onClick={() => setUploadSpec(null)}>{t.cancel}</button>
              <button className="primary" onClick={startBuild}
                disabled={buildingSpec || !uploadSpec.client.trim() || !uploadSpec.project.trim() || !uploadSpec.repo.trim() || !uploadSpec.spec.trim()}>
                {buildingSpec ? t.building : t.build}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建项目 */}
      {newProject && (
        <div className="modal-bg" onClick={() => setNewProject(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t.newProject.replace("＋ ", "")}</h3>
            <label>{t.projectName}</label>
            <input value={newProject.name} onChange={(e) => setNewProject({ ...newProject, name: e.target.value })} autoFocus />
            <label>{t.deliverableName}</label>
            <input placeholder={t.dlvPh} value={newProject.dlvName}
              onChange={(e) => setNewProject({ ...newProject, dlvName: e.target.value })} />
            <label>{t.deliverable}</label>
            <select value={newProject.dlvType}
              onChange={(e) => setNewProject({ ...newProject, dlvType: e.target.value as DeliverableType })}>
              {DELIVERABLE_TYPES.map((d) => (
                <option key={d.id} value={d.id}>{lang === "zh" ? d.label : d.labelEn}</option>
              ))}
            </select>
            <label>{t.provider}</label>
            <select value={newProject.provider} onChange={(e) => {
              const provider = e.target.value as ProviderId;
              const model = providers.find((p) => p.id === provider)?.models[0] ?? "";
              setNewProject({ ...newProject, provider, model });
            }}>
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available}>
                  {p.label}{p.available ? "" : ` (${t.unavailable})`}
                </option>
              ))}
            </select>
            {newProject.provider === "lmstudio" && (
              <>
                <label>{t.model}</label>
                <select value={newProject.model}
                  onChange={(e) => setNewProject({ ...newProject, model: e.target.value })}>
                  {providers.find((p) => p.id === "lmstudio")?.models.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </>
            )}
            <div className="modal-actions">
              <button className="ghost" onClick={() => setNewProject(null)}>{t.cancel}</button>
              <button className="primary" onClick={createProject}
                disabled={!newProject.name.trim() || (newProject.provider === "lmstudio" && !newProject.model)}>
                {t.create}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
