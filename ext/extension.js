const vscode = require("vscode");
let BASE = "", WS = "", L = { tool: {}, flow: {}, commands: {}, stages: [], icons: {} };
const TYPE = { file: vscode.FileType.File, dir: vscode.FileType.Directory };
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
const t = (k, v = {}) => fill(L.tool[k] || k, v);

async function api(op, p, { body, method, q } = {}) {
  const u = new URL(`${BASE}/fs/${op}`);
  u.searchParams.set("p", p);
  for (const k in q || {}) u.searchParams.set(k, q[k]);
  const r = await fetch(u, { method: method || (body ? "PUT" : "GET"), body });
  if (r.status === 404) throw vscode.FileSystemError.FileNotFound(p);
  if (!r.ok) throw new Error(`fs ${op} ${p}: ${r.status}`);
  return r;
}

class IfeFs {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeFile = this.emitter.event; }
  watch() { return new vscode.Disposable(() => {}); }
  async stat(uri) { const s = await (await api("stat", uri.path)).json(); return { type: TYPE[s.type], size: s.size, mtime: s.mtime, ctime: s.ctime }; }
  async readDirectory(uri) { return (await (await api("readdir", uri.path)).json()).map(([n, k]) => [n, TYPE[k]]); }
  async readFile(uri) { return new Uint8Array(await (await api("read", uri.path)).arrayBuffer()); }
  async writeFile(uri, content) { await api("write", uri.path, { body: content }); this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]); }
  async createDirectory(uri) { await api("mkdir", uri.path, { method: "POST" }); }
  async delete(uri, o) { await api("delete", uri.path, { method: "POST", q: { r: o && o.recursive ? "1" : "0" } }); }
  async rename(a, b) { await api("rename", a.path, { method: "POST", q: { to: b.path } }); }
}

const icon = (agent) => L.icons[agent]
  ? { dark: vscode.Uri.parse(`${BASE}/ext/icons/${L.icons[agent]}.svg`), light: vscode.Uri.parse(`${BASE}/ext/icons/${L.icons[agent]}-light.svg`) }
  : new vscode.ThemeIcon("comment-discussion");
const lightIcon = (s) => { const u = vscode.Uri.parse(`${BASE}/ext/icons/${L.ui.lights[s]}.svg`); return { dark: u, light: u }; };
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p) => p.slice(p.lastIndexOf("/") + 1);

class Tree {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; this.data = null; }
  refresh() { this.data = null; this.emitter.fire(); }
  async load() { if (!this.data) this.data = await (await fetch(`${BASE}/tree`)).json(); return this.data; }
  getParent(e) { const d = dirOf(e.path); return d ? this.data.list.find((x) => x.path === d) : undefined; }
  async reveal(p) {
    const { list } = await this.load();
    const e = list.find((x) => x.path === p);
    if (e && view) view.reveal(e, { select: true, focus: false }).then(undefined, () => {});
  }
  async getChildren(node) {
    const { list, order } = await this.load();
    const parent = node ? node.path : "";
    const rank = (e) => { const i = order.indexOf(nameOf(e.path)); return i < 0 ? order.length + (e.dir ? 0 : 1) : i; };
    return list.filter((e) => dirOf(e.path) === parent).sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, undefined, { numeric: true }));
  }
  getTreeItem(e) {
    const name = nameOf(e.path);
    const it = new vscode.TreeItem(name, e.dir ? (e.path.includes("/") ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded) : vscode.TreeItemCollapsibleState.None);
    it.id = e.path;
    it.resourceUri = vscode.Uri.from({ scheme: "ife", path: "/" + this.data.root + "/" + e.path });
    if (e.chat) {
      it.iconPath = e.chat.role ? lightIcon(e.chat.light) : icon(e.chat.agent);
      it.description = [e.chat.model, e.chat.moves].filter(Boolean).join(" · ");
      it.command = { command: "ife.openChat", title: name, arguments: [e.path] };
    } else if (e.task) {
      it.iconPath = lightIcon(e.task.light);
      it.description = e.task.status ? t("status_" + e.task.status) : "";
    } else if (e.flow) {
      it.iconPath = new vscode.ThemeIcon("lock");
      it.contextValue = "flow";
      it.description = e.flow;
    } else if (e.artifact) {
      it.iconPath = new vscode.ThemeIcon("book");
    } else if (e.iterations) {
      it.contextValue = "iterations";
    }
    if (!e.dir && !it.command) it.command = { command: "vscode.open", title: name, arguments: [it.resourceUri] };
    return it;
  }
}

const panels = new Map();
let active = null;
let tree = null;
let view = null;
const names = new Map();
function retitle() {
  const base = (c) => (names.has(c) ? t(names.get(c).role ? (names.get(c).k ? "tabTitleTask" : "tabTitleRole") : "tabTitle", names.get(c)) : nameOf(c));
  for (const [c, p] of panels) {
    const b = base(c), dup = [...panels.keys()].some((o) => o !== c && base(o) === b);
    p.title = dup && names.has(c) ? t("tabTitleAuthor", names.get(c)) : b;
  }
}
let chatHtml = null;

class Feed {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; }
  refresh() { clearTimeout(this.later); this.later = setTimeout(() => this.emitter.fire(), L.ui.treeDelay); }
  async getChildren() {
    const { list } = await (await fetch(`${BASE}/feed`)).json();
    if (feedView) feedView.badge = list.length ? { value: list.length, tooltip: t("feedBadge", { n: list.length }) } : undefined;
    return list;
  }
  getTreeItem(e) {
    const it = new vscode.TreeItem(`${t("feedWork_" + e.work, { n: e.n })} · ${e.role} · ${t("feed_" + e.kind)}`);
    it.description = e.project;
    it.tooltip = new vscode.MarkdownString().appendText(e.detail || "");
    it.iconPath = new vscode.ThemeIcon("circle-filled");
    it.command = { command: "ife.openChat", title: "", arguments: [e.chat] };
    return it;
  }
}
let feed = null, feedView = null;
function listen() {
  const ws = new WebSocket(`${WS}/ws?${L.auth}`);
  ws.onmessage = (m) => { const o = JSON.parse(String(m.data)); if (o.t === "feed" || o.t === "tree") feed.refresh(); };
  ws.onclose = () => setTimeout(listen, L.ui.reconnect);
}

async function openChat(dir, pending, quiet) {
  const p = panels.get(dir);
  if (p) { if (quiet) return; p.reveal(); if (pending) p.webview.postMessage({ send: pending }); return; }
  const back = quiet && active !== null && panels.get(active);
  attach(vscode.window.createWebviewPanel("ife.chat", nameOf(dir), { viewColumn: vscode.ViewColumn.Active, preserveFocus: !!quiet }, { enableScripts: true, retainContextWhenHidden: true }), dir, pending, back);
}

async function attach(p, dir, pending, back) {
  if (!chatHtml) chatHtml = await (await fetch(`${BASE}/ext/chat.html`)).text();
  const PL = await (await fetch(`${BASE}/lang?project=${encodeURIComponent(String(dir).split("/")[0])}`)).json();
  p.title = nameOf(dir);
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  p.webview.html = chatHtml.replace(/__NONCE__/g, nonce).replace("__CHAT__", JSON.stringify(dir || ".")).replace("__PENDING__", JSON.stringify(pending || null))
    .replace("__TEXTS__", JSON.stringify(PL).replace(/</g, "\\u003c")).replace(/__BASE__/g, BASE).replace(/__WS__/g, WS).replace(/__AUTH__/g, L.auth);
  p.webview.onDidReceiveMessage(async (m) => {
    if (m.jump !== undefined) openChat(m.jump, m.text);
    if (m.openTab) openChat(m.openTab, null, !m.focus);
    if (m.md !== undefined) { let html = null; try { html = await vscode.commands.executeCommand("markdown.api.render", m.md); } catch {} p.webview.postMessage({ mdId: m.id, html: typeof html === "string" ? html : null }); }
    if (m.refresh) { clearTimeout(tree.later); tree.later = setTimeout(() => tree.refresh(), L.ui.treeDelay); }
    if (m.pickTask) {
      const c = await vscode.window.showQuickPick(m.pickTask.map((x) => ({ label: x.n, description: x.text.split("\n")[0], n: x.n })), { title: m.title, matchOnDescription: true });
      if (c) p.webview.postMessage({ send: `${m.cmd} ${c.n}` });
    }
    if (m.light) { p.iconPath = lightIcon(m.light); tree.refresh(); }
    if (m.title) { names.set(dir, m.title); retitle(); }
    if (m.pickModel) {
      const items = m.pickModel.map((x) => ({ label: x.model, iconPath: icon(x.agent), agent: x.agent }));
      const c = await vscode.window.showQuickPick(items, { title: m.bad ? t("pickBad", { error: m.bad }) : t("pickTitle"), placeHolder: t("pickHolder") });
      if (c) { p.webview.postMessage({ send: `${L.commands.model} ${c.agent} ${c.label}` }); setTimeout(() => tree && tree.refresh(), 1500); }
    }
  });
  p.onDidChangeViewState(() => { if (p.active) { active = dir; tree.reveal(dir); } });
  if (p.active) tree.reveal(dir);
  p.onDidDispose(() => { panels.delete(dir); names.delete(dir); retitle(); if (active === dir) active = null; });
  panels.set(dir, p);
  if (back) back.reveal(back.viewColumn, false); else active = dir;
}

async function newProject() {
  const flows = await (await fetch(`${BASE}/flows`)).json();
  if (!flows.length) return vscode.window.showWarningMessage(t("noFlows", { dir: L.flows }));
  const f = await vscode.window.showQuickPick(flows.map((x) => ({ label: x.name, description: [x.version, x.source].filter(Boolean).join(" · "), version: x.version })), { title: t("newProjectFlow") });
  if (!f) return;
  const name = await vscode.window.showInputBox({ title: t("newProjectName"), validateInput: (v) => (new RegExp(L.projectName).test(v) ? null : t("projectNameBad")) });
  if (!name) return;
  const r = await fetch(`${BASE}/project?name=${encodeURIComponent(name)}&flow=${encodeURIComponent(f.label)}&version=${encodeURIComponent(f.version)}`, { method: "POST" });
  if (!r.ok) return vscode.window.showErrorMessage(await r.text());
  tree.refresh();
  openChat((await r.json()).chat);
}

async function newIteration(e) {
  if (!e) return;
  const project = e.path.split("/")[0];
  const name = await vscode.window.showInputBox({ title: t("newIterationName", { project }), validateInput: (v) => (new RegExp(L.iterationName).test(v) ? null : t("iterationNameBad")) });
  if (!name) return;
  const r = await fetch(`${BASE}/iteration?project=${encodeURIComponent(project)}&name=${encodeURIComponent(name)}`, { method: "POST" });
  if (!r.ok) return vscode.window.showErrorMessage(await r.text());
  tree.refresh();
  openChat((await r.json()).chat);
}

async function updateFlow(e) {
  if (!e || !e.flow) return;
  const project = e.path.split("/")[0], [name, current] = e.flow.split(" ");
  const flows = (await (await fetch(`${BASE}/flows`)).json()).filter((x) => x.name === name);
  const pick = await vscode.window.showQuickPick(flows.map((x) => ({ label: x.version, description: x.version === current ? t("flowCurrent") : x.source || "", version: x.version })), { title: t("flowUpdateTitle", { project, flow: e.flow }) });
  if (!pick || pick.version === current) return;
  const yes = t("flowUpdateYes");
  if ((await vscode.window.showWarningMessage(t("flowUpdateAsk", { project, flow: name, from: current, to: pick.version }), { modal: true }, yes)) !== yes) return;
  const r = await fetch(`${BASE}/flow/update?project=${encodeURIComponent(project)}&version=${encodeURIComponent(pick.version)}`, { method: "POST" });
  if (!r.ok) return vscode.window.showErrorMessage(await r.text());
  const open = [...panels.keys()].filter((c) => c.startsWith(project + "/"));
  for (const c of open) panels.get(c).dispose();
  for (const c of open) await openChat(c);
  tree.refresh();
  vscode.window.showInformationMessage(t("flowUpdated", { project, flow: (await r.json()).flow }));
}

function terminal() {
  const writer = new vscode.EventEmitter();
  let ws;
  const resize = (d) => d && ws && ws.readyState === 1 && ws.send(JSON.stringify({ resize: [d.columns, d.rows] }));
  const pty = {
    onDidWrite: writer.event,
    open(d) {
      ws = new WebSocket(`${WS}/pty?${L.auth}`);
      ws.onopen = () => resize(d);
      ws.onmessage = (e) => writer.fire(String(e.data));
      ws.onclose = () => writer.fire("\r\n" + t("ptyClosed") + "\r\n");
    },
    close() { if (ws) ws.close(); },
    handleInput(s) { if (ws && ws.readyState === 1) ws.send(s); },
    setDimensions: resize,
  };
  vscode.window.createTerminal({ name: t("terminalName"), pty }).show();
}

exports.activate = async (ctx) => {
  BASE = ctx.extensionUri.scheme + "://" + ctx.extensionUri.authority;
  WS = "ws://" + ctx.extensionUri.authority;
  ctx.subscriptions.push(vscode.workspace.registerFileSystemProvider("ife", new IfeFs(), { isCaseSensitive: true }));
  L = await (await fetch(`${BASE}/lang`)).json();
  vscode.commands.executeCommand("workbench.view.extension.ife");
  tree = new Tree();
  setTimeout(listen, 0);
  const toActive = (key) => () => { const p = active !== null && panels.get(active); if (p) p.webview.postMessage({ cmdKey: key }); else vscode.window.showInformationMessage(t("noActiveChat")); };
  ctx.subscriptions.push(
    view = vscode.window.createTreeView("ife.tree", { treeDataProvider: tree }),
    feedView = vscode.window.createTreeView("ife.feed", { treeDataProvider: (feed = new Feed()) }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && ed.document.uri.scheme === "ife") tree.reveal(ed.document.uri.path.replace(/^\/[^/]+\/?/, ""));
    }),
    vscode.window.registerWebviewPanelSerializer("ife.chat", { deserializeWebviewPanel: (p, state) => attach(p, (state && state.chat) || ".") }),
    vscode.commands.registerCommand("ife.openChat", (dir) => openChat(dir)),
    vscode.commands.registerCommand("ife.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("ife.newProject", newProject),
    vscode.commands.registerCommand("ife.updateFlow", updateFlow),
    vscode.commands.registerCommand("ife.newIteration", newIteration),
    vscode.commands.registerCommand("ife.terminal", terminal),
    vscode.commands.registerCommand("ife.back", toActive("back")),
    vscode.commands.registerCommand("ife.next", toActive("next")),
    vscode.commands.registerCommand("ife.add", toActive("add")),
    vscode.commands.registerCommand("ife.replace", toActive("replace")),
    vscode.commands.registerCommand("ife.model", toActive("model")),
  );
};
