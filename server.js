const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const home = (p) => String(p || "").replace(/^~(?=\/|$)/, os.homedir());
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const merge = (a, b) => { const r = { ...a }; for (const k in b || {}) r[k] = isObj(b[k]) && isObj(a[k]) ? merge(a[k], b[k]) : b[k]; return r; };
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
const dig = (o, p) => String(p || "").split(".").filter(Boolean).reduce((x, k) => (x == null ? x : x[k]), o);
const action = (name, o, keys) => { const k = (keys || []).find((k) => typeof dig(o, k) === "string"); return [name, k && dig(o, k)].filter(Boolean).join(" "); };

const base = readJson(path.join(__dirname, "defaults.json")) || {};
const LANGS = path.join(__dirname, "ext", "languages");
const T0 = readJson(path.join(LANGS, base.language + ".json")) || {};
const ROOT = process.argv[2] ? path.resolve(home(process.argv[2])) : null;
const RUN = process.argv[3] ? path.resolve(home(process.argv[3])) : null;
if (!ROOT || !RUN || !fs.existsSync(ROOT) || !fs.statSync(ROOT).isDirectory()) {
  const app = RUN && path.dirname(__dirname) === RUN, cmd = app && path.relative(process.cwd(), path.join(RUN, base.release.launcher));
  console.error(app ? fill(T0.noProjectsApp, { cmd: cmd.includes(path.sep) ? cmd : "." + path.sep + cmd }) : fill(T0.noProjects, {}));
  process.exit(1);
}
const CONF = path.join(RUN, base.config.file);
const seeded = !fs.existsSync(CONF);
if (seeded) {
  fs.mkdirSync(RUN, { recursive: true });
  fs.writeFileSync(CONF, JSON.stringify(Object.fromEntries(base.config.seed.map((k) => [k, base[k]])), null, 2) + "\n");
}
console.log(fill(T0[seeded ? "configCreated" : "configAt"], { file: CONF }));
const askLine = (q) => {
  process.stdout.write(q);
  const tty = fs.openSync(base.config.tty, "r"), b = Buffer.alloc(1), bytes = [];
  while (fs.readSync(tty, b, 0, 1) === 1 && b[0] !== 10) bytes.push(b[0]);
  fs.closeSync(tty);
  return Buffer.from(bytes).toString("utf8").trim();
};
const user = readJson(CONF) || {};
const missing = base.config.ask.filter((k) => !user[k]);
if (missing.length) {
  if (!process.stdin.isTTY) { console.error(fill(T0.askNoTty, { file: CONF, keys: missing.join(", ") })); process.exit(1); }
  const langs = fs.readdirSync(LANGS).filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json"));
  const def = { author: os.userInfo().username, lang: base.language };
  const ok = { author: (v) => new RegExp(base.projectName).test(v), lang: (v) => langs.includes(v) };
  for (const k of missing) {
    let v;
    do v = askLine(fill(T0["ask_" + k], { def: def[k], langs: langs.join(", ") })) || def[k]; while (!ok[k](v));
    user[k] = v;
  }
  fs.writeFileSync(CONF, JSON.stringify(user, null, 2) + "\n");
}
const cfg = merge(base, user);
const me = merge({ author: user.author, lang: user.lang, hints: cfg.hints }, user);
const PORT = Number(cfg.port);
const langOf = (dir) => merge(readJson(path.join(dir, cfg.language + ".json")) || {}, readJson(path.join(dir, me.lang + ".json")) || {});
const T = langOf(LANGS);
const t = (k, v = {}) => fill(T[k] || k, v);
const inRun = (p) => path.resolve(RUN, home(p));
const FLOWS = inRun(cfg.flows);
const TOKEN_FILE = inRun(cfg.auth.token);
const queue = new Map(), qkey = (e) => [e.project, e.work, e.iteration, e.author, e.n].join("/");
const tail = (d) => { const s = String(d || "").trim(); return s.length > cfg.feed.detail ? "…" + s.slice(-cfg.feed.detail) : s; };
function rebuild() {
  for (const name of projects()) {
    try {
      const Q = project(name);
      for (const w of Q.works) for (const iteration of Q.iterations()) {
        const at = (n) => Q.at(w.file, { iteration, author: me.author, n });
        for (const n of dirsOf(path.join(Q.dir, path.dirname(path.dirname(at("0")))))) {
          const s = jsonlWork.read(path.join(Q.dir, at(n)));
          if (!s || cfg.closed.includes(s.status)) continue;
          const dir = path.dirname(at(n)), base = { project: name, work: w.key, iteration, author: me.author, n, status: s.status };
          const last = fs.readdirSync(path.join(Q.dir, dir)).map((f) => ({ rel: dir + "/" + f, wh: Q.taskOf(dir + "/" + f) })).filter((x) => x.wh)
            .map((x) => ({ ...x, r: readLines(path.join(Q.dir, x.rel)).filter((r) => r.who).at(-1) })).filter((x) => x.r).sort((a, b) => a.r.ts.localeCompare(b.r.ts)).at(-1);
          const e = cfg.feed.waits.includes(s.status) ? { kind: s.status } : last && cfg.feed.lastWho.includes(last.r.who) ? { kind: "waiting" } : null;
          if (e) queue.set(qkey(base), { ...base, ...e, ts: last ? last.r.ts : new Date().toISOString(), chat: last ? name + "/" + last.rel : "", role: last ? last.wh.role : w.role, detail: tail(last && last.r.text) });
        }
      }
    } catch {}
  }
}
const fresh = !fs.existsSync(TOKEN_FILE);
if (fresh) { fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true }); fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(cfg.auth.bytes).toString("hex") + "\n", { mode: 0o600 }); }
const TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
const COOKIE = fill(cfg.auth.cookie, { port: PORT });
const same = (a) => { const x = Buffer.from(String(a || "")), y = Buffer.from(TOKEN); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cookieOf = (req) => (String(req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "=")) || "").slice(COOKIE.length + 1);
const hostMatch = (v) => cfg.auth.hosts.some((h) => (h.startsWith("*.") ? v.endsWith(h.slice(1) + ":" + PORT) : v === h + ":" + PORT));
const hostOk = (req) => hostMatch(String(req.headers.host || ""));
const originOk = (req) => { const o = req.headers.origin; if (o === undefined) return true; try { return hostMatch(new URL(o).host); } catch { return false; } };
const authed = (req, url) => same(cookieOf(req)) || same(url.searchParams.get(cfg.auth.param));
const deny = (res) => { res.writeHead(403, { "content-type": mime[".txt"] }); res.end(t("noAccess")); };
const projects = () => fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && fs.existsSync(path.join(ROOT, e.name, cfg.projectFile))).map((e) => e.name);
function project(name) {
  const dir = path.join(ROOT, name), fdir = path.join(dir, cfg.flowDir);
  const flow = merge({ stages: [], commands: {}, languages: "languages" }, readJson(path.join(fdir, cfg.flowFile)) || {});
  const rules = flow.rules && [me.lang, cfg.language].map((lang) => path.join(fdir, fill(flow.rules, { lang }))).find((f) => fs.existsSync(f));
  const layout = merge(cfg.layout, flow.layout || {});
  const at = (kind, v) => fill(layout[kind], v);
  const parse = (kind, p) => { const m = layout[kind] && layoutRe(layout[kind]).exec(p); return m && { ...m.groups }; };
  const seq = flow.start ? [flow.start, ...flow.stages] : flow.stages;
  const artPath = (stage, iteration, author) => (stage === flow.start ? at("startArtifact", { author }) : at("stageArtifact", { iteration, stage, author }));
  const chatPath = (stage, iteration, author) => path.posix.join(path.posix.dirname(artPath(stage, iteration, author)), author, cfg.chatFile);
  const chatOf = (kind, p) => { const m = layout[kind] && layoutRe(path.posix.join(path.posix.dirname(layout[kind]), "{author}", cfg.chatFile)).exec(p); return m && { ...m.groups }; };
  const works = [["tasks", "task", "taskChat"], ["experiments", "experiment", "experimentChat"]].filter(([k, f, c]) => flow[k] && layout[f] && layout[c]).map(([key, file, chat]) => ({ key, file, chat, ...flow[key] }));
  const tasksOn = works.length > 0;
  const workAt = (stage) => works.find((w) => w.stage === stage);
  const taskOf = (p) => { for (const w of works) { const m = layoutRe(layout[w.chat]).exec(p); if (m && (w.role || (flow.roles || {})[m.groups.role])) return { role: w.role, ...m.groups, stage: w.stage, work: w.key }; } return null; };
  const where = (p) => taskOf(p) || chatOf("stageArtifact", p) || (flow.start && chatOf("startArtifact", p) && { ...chatOf("startArtifact", p), stage: flow.start, iteration: flow.iteration });
  const taskDir = (p) => { for (const w of works) { const m = layoutRe(path.posix.dirname(layout[w.file])).exec(p); if (m) return { ...m.groups, work: w.key }; } return null; };
  const textOf = (tpl) => { const f = tpl && [me.lang, cfg.language].map((lang) => path.join(fdir, fill(tpl, { lang }))).find((x) => fs.existsSync(x)); return f ? fs.readFileSync(f, "utf8") : ""; };
  const roleRules = (role) => textOf(((flow.roles || {})[role] || {}).rules);
  const iterRel = path.posix.normalize(String(layout.stageArtifact).split("{iteration}")[0]).replace(/\/$/, ""), iterRoot = path.join(dir, iterRel);
  const iterations = () => [...new Set([flow.iteration, ...dirsOf(iterRoot)])].filter(Boolean);
  return { name, dir, layout, at, parse, seq, chatPath, artPath, where, iterations, iterRel, taskOf, taskDir, tasksOn, works, workAt, roleRules, cfg: merge(cfg, readJson(path.join(dir, cfg.projectFile)) || {}), flow, FT: langOf(path.join(fdir, flow.languages)),
    rules: rules ? fs.readFileSync(rules, "utf8") : "", tag: `${flow.name}@${flow.version}` };
}
function newIteration(P, it) {
  if (!new RegExp(cfg.iterationName).test(it)) return { error: t("iterationBad", { name: it }) };
  if (P.iterations().includes(it)) return { error: t("iterationExists", { name: it }) };
  const chat = P.name + "/" + P.chatPath(P.flow.stages[0], it, me.author);
  fs.mkdirSync(path.dirname(path.join(ROOT, chat)), { recursive: true });
  broadcast({ t: "tree" });
  return { chat, name: it };
}
const layoutRe = (s) => new RegExp("^" + String(s).split(/(\{\w+\})/).map((x) => (/^\{\w+\}$/.test(x) ? `(?<${x.slice(1, -1)}>[^/]+)` : x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("") + "$");
const dirsOf = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
const verNum = (v) => String(v).split(".").map(Number);
const newer = (a, b) => { const x = verNum(a), y = verNum(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
const localFlows = () => dirsOf(FLOWS).flatMap((name) => dirsOf(path.join(FLOWS, name)).filter((v) => fs.existsSync(path.join(FLOWS, name, v, cfg.flowFile))).map((version) => ({ name, version })));
const remote = { at: 0, list: [] };
async function remoteFlows() {
  if (Date.now() - remote.at < cfg.flowSourcesTtl * 1000) return remote.list;
  const all = await Promise.all((cfg.flowSources || []).map(async (src) => {
    try {
      const r = await fetch(src);
      if (!r.ok) return null;
      return ((await r.json()).flows || []).map((x) => ({ name: x.name, version: x.version, source: new URL(src).host, url: new URL(x.url, src).href, digest: x.sha256 && "sha256:" + x.sha256 }));
    } catch { return null; }
  }));
  if (all.every((x) => x)) remote.at = Date.now();
  remote.list = all.some((x) => x) ? all.flat().filter(Boolean) : remote.list;
  return remote.list;
}
async function fetchTo(url, digest, target, marker, texts) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const [algo, sum] = String(digest || "").split(":");
  if (sum && crypto.createHash(algo).update(buf).digest("hex") !== sum) throw new Error(t(texts.digest, { url }));
  const tmp = target + cfg.flowArchive;
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(tmp, buf);
  await new Promise((ok, fail) => { const [cmd, ...args] = cfg.unpack.map((x) => fill(x, { file: tmp, dir: target })); spawn(cmd, args, { stdio: "ignore" }).on("error", fail).on("close", (c) => (c ? fail(new Error(cmd + " " + c)) : ok())); });
  fs.rmSync(tmp);
  if (!fs.existsSync(path.join(target, marker))) { fs.rmSync(target, { recursive: true }); throw new Error(t(texts.broken, { url })); }
}
const download = (f) => fetchTo(f.url, f.digest, path.join(FLOWS, f.name, f.version), cfg.flowFile, { digest: "flowDigest", broken: "flowBroken" });
const VSCODE = inRun(fill(cfg.vscode.dir, { version: cfg.vscode.version }));
async function ensureVscode() {
  if (fs.existsSync(path.join(VSCODE, cfg.vscode.marker))) return;
  console.log(t("vscodeLoading", { version: cfg.vscode.version }));
  await fetchTo(fill(cfg.vscode.url, { version: cfg.vscode.version }), cfg.vscode.digest, VSCODE, cfg.vscode.marker, { digest: "vscodeDigest", broken: "vscodeBroken" });
}
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n") : []).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const taskState = (f) => {
  const r = { text: null, status: null, diff: null, why: null, result: null };
  for (const o of readLines(f)) { if (o.ev === "task") r.text = o.text; if (o.ev === "status") { r.status = o.s; if (o.diff) r.diff = o.diff; if (o.why) r.why = o.why; if (o.result) r.result = o.result; } }
  return r.text === null ? null : r;
};
const jsonlWork = {
  read: taskState,
  create: (f, n, text, author) => fs.writeFileSync(f, JSON.stringify({ ev: "task", ts: new Date().toISOString(), author, text }) + "\n"),
  mark: (f, o) => fs.appendFileSync(f, JSON.stringify({ ev: "status", ...o }) + "\n"),
};
const outcomeOf = (FT, text) => {
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)], body = (blocks.length ? blocks.at(-1)[1] : text).trimEnd();
  const no = text.includes(FT.outcomeNo), yes = !no && text.includes(FT.outcomeYes);
  return { body, outcome: no ? FT.outcomeNo : yes ? FT.outcomeYes : null, s: no ? "refuted" : yes ? "confirmed" : "back" };
};
const lightsOf = (w) => (cfg.ui.workLights || {})[w.key] || cfg.ui.taskLights;
const workLight = (Q, w, at) => {
  const f = Q.at(w.file, at), s = jsonlWork.read(path.join(Q.dir, f));
  if (!s) return null;
  const dir = Q.name + "/" + path.posix.dirname(f) + "/", near = [...sessions].filter(([k]) => k.startsWith(dir)).map(([, S]) => S.st);
  return near.some((x) => x.busy) ? "busy" : near.some((x) => x.light === "error") ? "error" : lightsOf(w)[s.status] || lightsOf(w).default;
};
const scratchDir = (v) => {
  const root = inRun(cfg.scratch.root);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(root);
  if (s.isSymbolicLink() || !s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error(t("scratchUnsafe", { dir: root }));
  const dir = path.join(root, fill(cfg.scratch.dir, v));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};
const nextNum = (names) => 1 + Math.max(0, ...names.map(Number).filter(Number.isInteger));
const lockTree = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) lockTree(f); else fs.chmodSync(f, 0o444); } };
const locked = (file) => { const [pr, sub] = path.relative(ROOT, file).split(path.sep); return sub === cfg.flowDir && projects().includes(pr); };

const parsers = {
  "claude-stream": {
    input: (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n",
    parse(line, st, p) {
      let ev; try { ev = JSON.parse(line); } catch { return {}; }
      if (ev.session_id) st.sid = ev.session_id;
      if (ev.type === "system" && ev.subtype === "init") return { info: { model: ev.model, sid: ev.session_id }, ready: true };
      if (ev.type === "stream_event") {
        const d = ev.event?.delta;
        if (ev.event?.type === "content_block_start" && ev.event.content_block?.type === "text" && st.text) return { text: "\n\n" };
        if (d?.type === "text_delta") { st.streamed = true; return { text: d.text }; }
        return {};
      }
      if (ev.type === "assistant") {
        const content = ev.message?.content || [];
        const text = st.streamed ? "" : content.filter((b) => b.type === "text").map((b) => b.text).join("");
        st.streamed = false;
        const acts = content.filter((b) => b.type === "tool_use").map((b) => action(b.name, b.input, (p.actions || {}).keys));
        return { text, acts };
      }
      if (ev.type === "result") {
        const error = ev.is_error ? (ev.result || ev.subtype) : undefined;
        return { done: true, error, badModel: !!error && new RegExp(p.badModel, "i").test(error) };
      }
      return {};
    },
    catalog: (p, a) => ask(p, a, JSON.stringify({ type: "control_request", request_id: "catalog", request: { subtype: "initialize" } }) + "\n",
      (m) => m.type === "control_response" && m.response?.request_id === "catalog" && (m.response.response?.models || [])),
  },
  "codex-rpc": {
    open(st, p) {
      const rpc = st.rpc = { id: 0, ready: false, queue: [], pending: {} };
      rpc.req = (method, params, tag) => { const id = ++rpc.id; rpc.pending[id] = tag; return rpcLine({ id, method, params }); };
      rpc.thread = () => ({ model: st.modelReq, cwd: st.cwd, ...p.thread, ...st.thread });
      return rpc.req("initialize", { clientInfo: p.client, capabilities: null }, "init") + rpcLine({ method: "initialized" })
        + (st.sid ? rpc.req("thread/resume", { threadId: st.sid, ...rpc.thread() }, "resume") : rpc.req("thread/start", rpc.thread(), "start"));
    },
    input(text, st) {
      const turn = () => st.rpc.req("turn/start", { threadId: st.sid, input: [{ type: "text", text, text_elements: [] }] }, "turn");
      if (st.rpc.ready) return turn();
      st.rpc.queue.push(turn);
      return "";
    },
    parse(line, st, p) {
      let m; try { m = JSON.parse(line); } catch { return {}; }
      const rpc = st.rpc, bad = (error) => new RegExp(p.badModel, "i").test(error);
      if (m.id != null && !m.method && rpc.pending[m.id]) {
        const tag = rpc.pending[m.id]; delete rpc.pending[m.id];
        if (tag === "resume" && m.error) { st.sid = null; return { write: rpc.req("thread/start", rpc.thread(), "start") }; }
        if ((tag === "start" || tag === "resume") && m.result) {
          st.sid = m.result.thread.id; rpc.ready = true;
          const write = rpc.queue.map((f) => f()).join(""); rpc.queue = [];
          return { write, info: { model: st.modelReq, sid: st.sid }, ready: true };
        }
        if (m.error) { const error = m.error.message || JSON.stringify(m.error); return { done: tag !== "init", error, badModel: bad(error) }; }
        return {};
      }
      if (m.id != null && m.method) return { write: rpcLine({ id: m.id, error: { code: -32601, message: m.method } }) };
      if (m.method === "item/agentMessage/delta") return { text: m.params.delta };
      if (m.method === "item/started") {
        const it = m.params.item || {}, a = p.actions || {};
        if (it.type === "agentMessage" && st.text) return { text: "\n\n" };
        return (a.skip || []).includes(it.type) ? {} : { acts: [action(it.type, it, a.keys)] };
      }
      if (m.method === "turn/completed") {
        const turn = m.params.turn;
        if (turn.status !== "failed") return { done: true };
        const error = turn.error?.message || turn.status;
        return { done: true, error, badModel: bad(error) };
      }
      return {};
    },
    catalog: (p, a) => ask(p, a, rpcLine({ id: 1, method: "initialize", params: { clientInfo: p.client, capabilities: null } }) + rpcLine({ method: "initialized" }) + rpcLine({ id: 2, method: "model/list", params: {} }),
      (m) => m.id === 2 && (m.result?.data || [])),
  },
};
const rpcLine = (o) => JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n";
const provider = (a) => cfg.providers[a];
const usable = (a) => !!(provider(a) && parsers[provider(a).parser]);
const found = (cmd) => (String(process.env.PATH || "").split(path.delimiter).filter(Boolean).concat(cmd.includes(path.sep) ? [""] : []))
  .some((d) => { try { fs.accessSync(path.resolve(d, cmd), fs.constants.X_OK); return true; } catch { return false; } });
const installed = (a) => usable(a) && found(provider(a).command);
const cleanEnv = (list) => { const e = { ...process.env }; for (const k of list || []) delete e[k]; return e; };
const ask = (p, a, input, take) => new Promise((ok, fail) => {
  const args = [...p.args, ...(p.new || [])].map((x) => fill(x, { model: cfg.default.models[a] || "", sid: "", cwd: ROOT }));
  const proc = spawn(p.command, args, { cwd: ROOT, env: cleanEnv(p.unsetEnv), stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const timer = setTimeout(() => { proc.kill(); fail(new Error(p.command)); }, 30000);
  proc.on("error", (e) => { clearTimeout(timer); fail(e); });
  proc.stdout.on("data", (d) => {
    buf += d; const ls = buf.split("\n"); buf = ls.pop();
    for (const l of ls) { let m; try { m = JSON.parse(l); } catch { continue; } const v = take(m); if (v) { clearTimeout(timer); proc.kill(); ok(v); } }
  });
  proc.stdin.write(input);
});

const catalogs = {};
function catalogRaw(a) {
  const c = (provider(a) || {}).catalog;
  const raw = !c ? [] : c.source === "agent" ? catalogs[a] || [] : dig(readJson(home(c.file)), c.path) || [];
  return raw.filter((m) => Object.entries(c.filter || {}).every(([k, v]) => m[k] === v));
}
function models(a) {
  const c = (provider(a) || {}).catalog || {};
  return [...new Set([...((provider(a) || {}).models || []), ...catalogRaw(a).map((m) => (c.key ? m[c.key] : m))])];
}
function fullName(a, m) {
  const c = (provider(a) || {}).catalog || {};
  const hit = c.alias && catalogRaw(a).find((x) => x[c.alias] === m);
  return hit ? hit[c.key] : m;
}
const available = (a, m) => { const list = models(a); return !list.length || list.includes(fullName(a, m)); };
async function refreshCatalogs() {
  await Promise.all(Object.keys(cfg.providers).filter(installed).map(async (a) => {
    const p = provider(a), get = parsers[p.parser].catalog;
    if (p.catalog && p.catalog.source === "agent" && get) { try { catalogs[a] = await get(p, a); } catch {} }
  }));
}
const modelList = () => Object.keys(cfg.providers).filter(installed).flatMap((a) => models(a).map((model) => ({ agent: a, model })));
const agentsLine = () => { const all = Object.keys(cfg.providers).filter(usable); return all.some(installed) ? t("agentsFound", { list: all.map((a) => t(installed(a) ? "agentYes" : "agentNo", { name: a })).join(", ") }) : t("agentsNone", { list: all.map((a) => provider(a).command).join(", ") }); };

if (!usable(cfg.default.provider)) { console.error(t("noAdapter", { name: cfg.default.provider })); process.exit(1); }
refreshCatalogs().then(() => {
  for (const a in cfg.default.models) if (usable(a) && !available(a, cfg.default.models[a])) console.error(t("modelNotListed", { model: cfg.default.models[a], provider: a, list: models(a).join(", ") }));
});

const countWords = (s) => (s.match(/[\p{L}\p{N}_][\p{L}\p{N}_'’-]*/gu) || []).length;
const countQuestions = (s) => (s.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/(?:https?:\/\/|www\.)\S+/gi, " ")
  .replace(/«[^»]*»/g, " ").replace(/“[^”]*”/g, " ").replace(/"[^"\n]*"/g, " ")
  .match(/[?？][?？!]*(?=[\s)\]»"'”’]|$)/g) || []).length;

const files = { "/ide": "public/ide.html" };
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".json": "application/json", ".map": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
const roots = { "/vscode/": VSCODE, "/ext/": path.join(__dirname, "ext") };
const inside = (root, rel) => { const f = path.normalize(path.join(root, rel)); return f === root || f.startsWith(root + path.sep) ? f : null; };
const serveFile = (res, file) => { res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" }); fs.createReadStream(file).pipe(res); };
const json = (res, o) => { res.writeHead(200, { "content-type": mime[".json"] }); res.end(JSON.stringify(o)); };
const chatInfo = (file) => {
  const info = { agent: null, model: null, moves: 0 };
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.ev === "session" && o.agent) { info.agent = o.agent; info.model = o.model || info.model; }
    if (o.ev === "info" && o.model && !info.model) info.model = o.model;
    if (o.who && o.move > info.moves) info.moves = o.move;
  }
  if (info.agent && info.model) info.model = fullName(info.agent, info.model);
  return info;
};
const ROOT_RE = new RegExp("^/" + path.basename(ROOT).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=/|$)");
const body = (req) => new Promise((ok) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });

async function fsApi(req, res, op, q) {
  const file = inside(ROOT, (q.get("p") || "/").replace(ROOT_RE, ""));
  if (!file) { res.writeHead(403); return res.end(); }
  if (!["stat", "readdir", "read"].includes(op) && locked(file)) { res.writeHead(403); return res.end(t("flowLocked")); }
  const exists = fs.existsSync(file);
  if (op === "stat") {
    if (!exists) { res.writeHead(404); return res.end(); }
    const st = fs.statSync(file);
    return json(res, { type: st.isDirectory() ? "dir" : "file", size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs });
  }
  if (op === "readdir") {
    if (!exists) { res.writeHead(404); return res.end(); }
    return json(res, fs.readdirSync(file, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? "dir" : "file"]));
  }
  if (op === "read") { if (!exists || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); } return serveFile(res, file); }
  if (op === "write") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, await body(req)); }
  else if (op === "mkdir") fs.mkdirSync(file, { recursive: true });
  else if (op === "delete") { if (!exists) { res.writeHead(404); return res.end(); } fs.rmSync(file, { recursive: q.get("r") === "1" }); }
  else if (op === "rename") { const to = inside(ROOT, (q.get("to") || "").replace(ROOT_RE, "")); if (!to || locked(to)) { res.writeHead(403); return res.end(); } fs.renameSync(file, to); }
  else { res.writeHead(404); return res.end(); }
  res.writeHead(200); res.end();
}

const icons = () => Object.fromEntries(Object.keys(cfg.providers).filter((a) => provider(a).icon).map((a) => [a, provider(a).icon]));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://ife");
  const p = url.pathname;
  if (!hostOk(req) || !originOk(req)) return deny(res);
  for (const pre in roots) if (p.startsWith(pre)) {
    const file = inside(roots[pre], decodeURIComponent(p.slice(pre.length)));
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    return serveFile(res, file);
  }
  if (!authed(req, url)) return deny(res);
  if (url.searchParams.has(cfg.auth.param)) {
    res.writeHead(302, { "set-cookie": `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${cfg.auth.days * 86400}`, location: p });
    return res.end();
  }
  if (p.startsWith("/fs/")) return fsApi(req, res, p.slice(4), url.searchParams).catch((e) => { res.writeHead(500); res.end(String(e)); });
  if (p === "/lang") {
    const name = url.searchParams.get("project"), P = name && projects().includes(name) ? project(name) : null;
    return json(res, { tool: T, author: me.author, icons: icons(), ui: cfg.ui, auth: `${cfg.auth.param}=${TOKEN}`, flows: FLOWS, projectName: cfg.projectName, iterationName: cfg.iterationName,
      commands: { ...cfg.commands, ...(P ? P.flow.commands : {}) }, ...(P ? { flow: P.FT, stages: P.flow.stages, offStage: P.flow.offStage, flowTag: `${P.flow.name} ${P.flow.version}` } : {}) });
  }
  if (p === "/flows") return remoteFlows().then((rl) => {
    const local = localFlows(), list = [...local, ...rl.filter((r) => !local.some((l) => l.name === r.name && l.version === r.version)).map(({ name, version, source }) => ({ name, version, source }))];
    json(res, list.sort((a, b) => a.name.localeCompare(b.name) || newer(a.version, b.version)));
  });
  if (p === "/project" && req.method === "POST") return (async () => {
    const name = url.searchParams.get("name") || "", fl = url.searchParams.get("flow") || "", ver = url.searchParams.get("version") || "";
    const src = fl && ver && inside(FLOWS, path.join(fl, ver)), dir = inside(ROOT, name);
    const ok = new RegExp(cfg.projectName).test(name) && dir && !fs.existsSync(dir) && src && path.relative(FLOWS, src).split(path.sep).length === 2;
    const far = ok && !fs.existsSync(path.join(src, cfg.flowFile)) && (await remoteFlows()).find((r) => r.name === fl && r.version === ver);
    if (far) await download(far);
    if (!ok || !fs.existsSync(path.join(src, cfg.flowFile))) { res.writeHead(400); return res.end(t("projectBad", { name })); }
    fs.cpSync(src, path.join(dir, cfg.flowDir), { recursive: true });
    lockTree(path.join(dir, cfg.flowDir));
    fs.writeFileSync(path.join(dir, cfg.projectFile), JSON.stringify({ flow: `${fl}@${ver}` }, null, 2) + "\n");
    const P = project(name), chat = name + "/" + P.chatPath(P.seq[0], P.flow.iteration, me.author);
    fs.mkdirSync(path.dirname(path.join(ROOT, chat)), { recursive: true });
    json(res, { chat });
  })().catch((e) => { res.writeHead(400); res.end(String(e.message || e)); });
  if (p === "/flow/update" && req.method === "POST") return (async () => {
    const name = url.searchParams.get("project") || "", ver = url.searchParams.get("version") || "";
    if (!projects().includes(name)) { res.writeHead(400); return res.end(t("projectBad", { name })); }
    const P0 = project(name), fl = P0.flow.name, src = fl && ver && inside(FLOWS, path.join(fl, ver));
    if (!src || path.relative(FLOWS, src).split(path.sep).length !== 2) { res.writeHead(400); return res.end(t("flowBad", { flow: fl, version: ver })); }
    const far = !fs.existsSync(path.join(src, cfg.flowFile)) && (await remoteFlows()).find((r) => r.name === fl && r.version === ver);
    if (far) await download(far);
    if (!fs.existsSync(path.join(src, cfg.flowFile))) { res.writeHead(400); return res.end(t("flowBad", { flow: fl, version: ver })); }
    for (const [k, S2] of sessions) if (k.startsWith(name + "/")) { S2.st.proc?.kill(); sessions.delete(k); }
    const fdir = path.join(P0.dir, cfg.flowDir);
    fs.rmSync(fdir, { recursive: true, force: true });
    fs.cpSync(src, fdir, { recursive: true });
    lockTree(fdir);
    const pf = path.join(P0.dir, cfg.projectFile);
    fs.writeFileSync(pf, JSON.stringify({ ...(readJson(pf) || {}), flow: `${fl}@${ver}` }, null, 2) + "\n");
    json(res, { flow: `${fl} ${ver}` });
  })().catch((e) => { res.writeHead(400); res.end(String(e.message || e)); });
  if (p === "/iteration" && req.method === "POST") {
    const name = url.searchParams.get("project") || "";
    if (!projects().includes(name)) { res.writeHead(400); return res.end(t("projectBad", { name })); }
    const r = newIteration(project(name), url.searchParams.get("name") || "");
    if (r.error) { res.writeHead(400); return res.end(r.error); }
    return json(res, r);
  }
  if (p === "/feed") {
    const now = (e) => { try { const Q = project(e.project), w = Q.works.find((x) => x.key === e.work); return w && (jsonlWork.read(path.join(Q.dir, Q.at(w.file, e))) || {}).status; } catch { return null; } };
    for (const [k, e] of queue) if (now(e) !== e.status) queue.delete(k);
    return json(res, { list: [...queue.values()].sort((a, b) => a.ts.localeCompare(b.ts)) });
  }
  if (p === "/tree") {
    const list = [], names = projects(), Ps = names.map(project);
    (function walk(dir, rel) {
      const es = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of es) {
        if (e.name.startsWith(".") || e.name === "node_modules" || (!rel && !names.includes(e.name))) continue;
        const rp = rel ? rel + "/" + e.name : e.name;
        const item = { path: rp, dir: e.isDirectory() };
        const P = Ps.find((x) => rp === x.name + "/" + cfg.flowDir);
        if (P) item.flow = `${P.flow.name} ${P.flow.version}`;
        if (Ps.some((x) => rp === x.name + "/" + x.iterRel)) item.iterations = true;
        const Q = Ps.find((x) => rp.startsWith(x.name + "/")), inner = Q && rp.slice(Q.name.length + 1);
        const wh = Q && !item.dir && Q.where(inner);
        if (wh) item.chat = { ...chatInfo(path.join(dir, e.name)), ...(wh.role && cfg.ui.chatLights.includes(wh.work) ? { role: wh.role, light: sessions.get(rp)?.st.light || "wait" } : {}) };
        const td = Q && item.dir && Q.taskDir(inner);
        const tw = td && Q.works.find((w) => w.key === td.work);
        if (td) { const s = jsonlWork.read(path.join(ROOT, Q.name, Q.at(tw.file, td))); if (s) item.task = { n: td.n, status: s.status, light: workLight(Q, tw, td) }; }
        if (Q && !item.dir && (Q.parse("stageArtifact", inner) || (Q.flow.start && Q.parse("startArtifact", inner)))) item.artifact = true;
        list.push(item);
        if (e.isDirectory()) walk(path.join(dir, e.name), rp);
      }
    })(ROOT, "");
    return json(res, { root: path.basename(ROOT), list, order: [...new Set([...cfg.order.dirs, ...Ps.flatMap((x) => [...x.iterations(), ...x.seq]), ...cfg.order.files])], icons: icons() });
  }
  const f = files[p];
  if (!f) { res.writeHead(404); return res.end(); }
  if (p === "/ide") {
    const conf = JSON.parse(fill(JSON.stringify(cfg.vscode.workbench), { root: path.basename(ROOT), host: String(req.headers.host), port: PORT }));
    res.writeHead(200, { "content-type": mime[".html"] });
    return res.end(fs.readFileSync(path.join(__dirname, f), "utf8").replace("__CONFIG__", JSON.stringify(conf).replace(/&/g, "&amp;").replace(/"/g, "&quot;")));
  }
  serveFile(res, path.join(__dirname, f));
});

const sessions = new Map();
function session(rel) {
  rel = rel.replace(/\\/g, "/").replace(/\/+$/, "");
  if (sessions.has(rel)) {
    const S = sessions.get(rel);
    if (fs.existsSync(path.join(ROOT, rel)) || (!S.logged() && !S.hist.length)) return S;
    S.st.proc?.kill(); sessions.delete(rel);
  }
  const [pname, ...rest] = rel.split("/"), inner = rest.join("/");
  const where = projects().includes(pname) && !path.relative(ROOT, path.resolve(ROOT, rel)).startsWith("..") && project(pname).where(inner);
  if (!where) throw new Error(t("chatOutside", { rel }));
  const P = project(pname), { cfg, flow, FT } = P;
  const W = where.work ? P.works.find((w) => w.key === where.work) : P.workAt(where.stage);
  const CWD = P.dir;
  const hints = () => me.hints !== false && !!FT.hint;
  const { iteration, stage, author: owner = me.author, role, n: taskN, k: roleK } = where, own = owner === me.author;
  const goal = !role && P.seq.includes(stage) && (FT.goals || {})[stage];
  const C = { ...cfg.commands, ...flow.commands };
  const kind = role || (W ? W.key : "stage");
  const allowed = (flow.chatCommands || {})[kind] || Object.keys(C);
  const system = role ? P.roleRules(role) : P.rules;
  const access = (role ? ((flow.roles || {})[role] || {}).access : flow.access) || cfg.access;
  const LOG = path.join(ROOT, rel), dir = path.dirname(LOG), artRel = P.artPath(stage, iteration, owner), ART = path.join(CWD, artRel);
  const si = P.seq.indexOf(stage), prevArt = si > 0 ? P.artPath(P.seq[si - 1], iteration, owner) : "";
  const jump = Object.fromEntries([1, -1].filter((d) => si >= 0 && P.seq[si + d]).map((d) => [d, { chat: pname + "/" + P.chatPath(P.seq[si + d], iteration, me.author), stage: P.seq[si + d], artifact: P.artPath(P.seq[si + d], iteration, me.author) }]));
  const st = { agent: cfg.default.provider, modelReq: null, sid: null, model: null, move: 0, try: 1, mul: 1, proc: null, text: "", buf: "", last: null, fed: false, redo: null, cwd: CWD, thread: {} };
  const clients = new Set();
  const raw = (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n") : [])
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const hist = [], acts = [];
  for (const o of raw) {
    if (o.ev === "session" && usable(o.agent) && o.model) { st.agent = o.agent; st.modelReq = o.model; }
    if (o.who && o.text) hist.push(o.who === "agent" && !o.agent ? { ...o, agent: st.agent } : o);
    if (o.ev === "act") acts.push(o);
  }
  const want = { ...cfg.chats, ...me.chats }[role || "stage"];
  if (!st.modelReq && want && usable(want.provider)) { st.agent = want.provider; st.modelReq = want.model || cfg.default.models[want.provider]; }
  if (!st.modelReq) st.modelReq = cfg.default.models[st.agent] || st.agent;
  for (const h of hist) st.move = Math.max(st.move, h.move || 0);
  const lastSaid = hist.filter((h) => (h.who === "human" || h.who === "agent") && !h.offStage).at(-1);
  if (lastSaid) st.last = { who: lastSaid.who, move: lastSaid.move, try: lastSaid.try, text: lastSaid.text };
  let log = null;
  const head = () => ({ ev: "session", agent: st.agent, model: st.modelReq, cwd: CWD, stage: rel, author: me.author, limits: cfg.limits, flow: P.tag });
  const write = (r) => {
    if (!log) { fs.mkdirSync(dir, { recursive: true }); fs.closeSync(fs.openSync(LOG, "a")); log = fs.createWriteStream(LOG, { flags: "a" }); if (r.ev !== "session") log.write(JSON.stringify({ ts: r.ts, ...head() }) + "\n"); }
    log.write(JSON.stringify(r) + "\n");
  };
  const rec = (o) => { if (!own) return; const r = { ts: new Date().toISOString(), ...o }; write(r); if (r.who && r.text) hist.push(r); if (r.ev === "act") acts.push(r); };
  const send = (o) => { if (o.t === "sys" && !o.kept) rec({ who: "sys", move: o.move, text: o.d }); const s = JSON.stringify({ chat: rel, ...o }); for (const ws of clients) if (ws.readyState === 1) ws.send(s); };
  const agent = () => parsers[provider(st.agent).parser];
  const info = () => ({ agent: st.agent, model: fullName(st.agent, st.modelReq), modelId: st.model, sid: st.sid, moves: st.move, last: hist.at(-1)?.ts, listed: available(st.agent, st.modelReq),
    busy: !!st.busy, hints: hints(), own, owner, project: pname, iteration, stage, artifact: artRel, jump, role, task: taskN, k: roleK, commands: allowed.map((x) => C[x]).filter(Boolean), resume: st.sid ? fill(provider(st.agent).resumeHint || "", { sid: st.sid }) : null, light: tabLight() });
  const pastArts = () => { const l = P.iterations().filter((x) => x !== iteration).flatMap((x) => [...flow.stages.map((s) => P.artPath(s, x, owner)), ...P.works.filter((w) => w.list).map((w) => P.at(w.list, { iteration: x }))]).filter((f) => fs.existsSync(path.join(P.dir, f))); return l.length ? l.map((f) => "- " + f).join("\n") : ""; };
  const tabLight = () => (!role || !W ? null : cfg.ui.chatLights.includes(W.key) ? st.light || "wait" : workLight(P, W, { iteration, author: owner, n: taskN }));
  const pushLight = () => { const s = tabLight(); if (s && s !== st.tab) { st.tab = s; send({ t: "state", s }); } };
  async function pick(note) { await refreshCatalogs(); send({ t: "model", bad: note, cur: { agent: st.agent, model: st.modelReq }, list: modelList() }); }
  function setModel(a, m) {
    if (!usable(a)) { send({ t: "sys", move: st.move, d: t("noAdapter", { name: a }) }); return false; }
    if (!installed(a)) { send({ t: "sys", move: st.move, d: t("agentMissing", { bin: provider(a).command, cmd: C.model }) }); return false; }
    if (st.proc) { const p = st.proc; st.proc = null; p.kill(); }
    st.agent = a; st.modelReq = m; st.sid = null; st.model = null; st.fed = false;
    rec(head());
    send({ t: "info", ...info() });
    return true;
  }

  function busy(v, err) {
    st.busy = v;
    if (!role) return;
    if (v && W) queue.delete(qkey({ project: pname, work: W.key, iteration, author: owner, n: taskN }));
    st.light = v ? "busy" : err ? "error" : "wait";
    broadcast({ t: "tree" });
  }

  function toAgent(text, kind) {
    const warm = !!st.proc;
    if (!warm) start();
    busy(true); st.t0 = new Date().toISOString();
    const first = !hist.some((h) => h.who === "human" || h.who === "agent");
    let out = text, fed = false;
    if (kind === "human" && hist.length && !st.fed && !st.sid) {
      st.fed = true; fed = true;
      const names = { human: t("whoHuman"), agent: t("whoAgent") };
      const doc = hist.filter((h) => names[h.who] && !h.err).map((h) => `${names[h.who]}: ${h.text.trim()}`).join("\n\n");
      out = t("feed", { doc, text });
    }
    const remind = kind === "human" && goal && FT.remind;
    if (remind) out = fill(FT.remind, { stage, goal, mark: flow.offStage, text: out });
    const past = !role && first && kind === "human" && stage === flow.stages[0] && FT.past && pastArts();
    if (past) out = fill(FT.past, { list: past, text: out });
    if (first && system && !provider(st.agent).system) out = system + "\n\n" + out;
    const hint = !role && hints() && first && kind === "human";
    if (hint) out = fill(FT.hint, { rules: P.rules, stage, goal: goal || "", paths: fill(FT.paths || "", { artifact: artRel, prev: prevArt || FT.none || "" }), tutorial: stage === flow.start ? FT.tutorial || "" : "", text: out });
    rec({ who: kind === "auto" ? "ife" : "human", move: st.move, try: st.try, text, ...(fed ? { fed: hist.length } : {}), ...(remind ? { stage } : {}), ...(hint ? { hint } : {}) });
    if (kind === "auto") send({ t: "sys", move: st.move, d: text, kept: true });
    else st.last = { who: "human", move: st.move, text };
    if (warm) send({ t: "phase", d: "thinking" });
    st.proc.stdin.write(agent().input(out, st));
  }

  function finish() {
    const words = countWords(st.text), questions = countQuestions(st.text);
    const limit = cfg.limits.words * st.mul;
    const errs = [];
    if (!role && words > limit) errs.push(t("errWords", { n: words, limit }));
    if (!role && questions > cfg.limits.questions) errs.push(t("errQuestions", { n: questions, limit: cfg.limits.questions }));
    const err = errs.join("; ") || undefined;
    const offStage = !!flow.offStage && st.text.trimStart().startsWith(flow.offStage), said = st.text;
    rec({ who: "agent", agent: st.agent, t0: st.t0, move: st.move, try: st.try, text: st.text, words, questions, limit, err, sid: st.sid, ...(offStage ? { offStage } : {}) });
    if (!offStage) st.last = { who: "agent", move: st.move, try: st.try, text: st.text };
    st.text = "";
    const retry = err && st.try < cfg.limits.tries;
    busy(false, err);
    send({ t: "done", move: st.move, try: st.try, err, offStage, lock: !!retry });
    if (retry) {
      st.try += 1;
      toAgent(t("retry", { limit, questions: cfg.limits.questions, err, oneQuestion: questions > cfg.limits.questions ? t("retryOneQuestion") : "" }), "auto");
    } else auto(said);
  }

  function handle(line) {
    const r = agent().parse(line, st, provider(st.agent));
    if (r.write && st.proc) st.proc.stdin.write(r.write);
    if (r.info) { rec({ ev: "info", move: st.move, ...r.info }); if (r.info.model) { st.model = r.info.model; send({ t: "info", ...info() }); } }
    if (r.ready) send({ t: "phase", d: "thinking" });
    for (const d of (r.acts || []).map((x) => x.split(CWD + path.sep).join(""))) { rec({ ev: "act", move: st.move, try: st.try, d }); send({ t: "act", move: st.move, try: st.try, d }); }
    if (r.text) { st.text += r.text; send({ t: "out", move: st.move, try: st.try, d: r.text }); }
    if (r.badModel) return badModel(r.error);
    if (r.error) { send({ t: "out", move: st.move, try: st.try, d: t("agentError", { error: r.error }) }); feed("error", r.error); }
    if (r.done) finish();
  }

  function badModel(error) {
    const h = hist.at(-1);
    if (h && h.who === "human" && h.move === st.move) { hist.pop(); st.redo = h.text; st.move -= 1; }
    st.text = ""; st.sid = null; st.fed = false; busy(false, error);
    if (st.proc) { const p = st.proc; st.proc = null; p.kill(); }
    rec({ ev: "badmodel", agent: st.agent, model: st.modelReq, error });
    send({ t: "done", move: st.move + 1, try: st.try, err: error, lock: false });
    pick(error);
  }

  function start() {
    const p = provider(st.agent);
    const v = { model: st.modelReq, sid: st.sid || "", cwd: CWD, system };
    const acc = (p.access || {})[access] || {}, sys = system && p.system || {};
    st.thread = { ...(acc.thread || {}), ...(sys.thread ? { [sys.thread]: system } : {}) };
    const bin = p.command, args = [...p.args, ...(acc.args || []), ...(sys.args || []), ...((st.sid ? p.resume : p.new) || [])].map((x) => fill(x, v));
    const proc = spawn(bin, args, { cwd: CWD, env: cleanEnv(p.unsetEnv), stdio: ["pipe", "pipe", "pipe"] });
    rec({ ev: "start", bin, args: args.map((x) => (x === system ? "{system}" : x)), access });
    if (agent().open) proc.stdin.write(agent().open(st, p));
    let err = "";
    proc.stdout.on("data", (d) => {
      st.buf += d;
      const lines = st.buf.split("\n"); st.buf = lines.pop();
      for (const l of lines) if (l.trim()) handle(l);
    });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("close", (code) => {
      if (st.buf.trim()) handle(st.buf); st.buf = "";
      if (st.proc === proc) {
        st.proc = null; busy(false, String(code));
        rec({ ev: "exit", code, stderr: err.slice(-2000) });
        feed("crashed", t("agentExit", { code, stderr: err.slice(-500) }));
        send({ t: "out", move: st.move, try: st.try, d: t("agentExit", { code, stderr: err.slice(-500) }) });
        send({ t: "done", move: st.move, try: st.try, lock: false });
      }
    });
    proc.stdin.on("error", () => {});
    proc.on("error", (e) => {
      if (st.proc !== proc) return;
      st.proc = null; busy(false, e.code);
      const d = e.code === "ENOENT" ? t("agentMissing", { bin, cmd: C.model }) : t("agentError", { error: e.message });
      rec({ ev: "exit", code: e.code, stderr: e.message });
      feed("error", d);
      send({ t: "out", move: st.move, try: st.try, d });
      send({ t: "done", move: st.move, try: st.try, lock: false });
    });
    st.proc = proc;
  }

  function input(d) {
    if (!own) { send({ t: "sys", move: st.move, d: t("readOnly", { author: owner }) }); send({ t: "done", move: st.move, try: 1, lock: false }); return; }
    const words = d.trim().split(/\s+/), cmd = words[0].toLowerCase();
    const is = (k) => C[k] && cmd === C[k].toLowerCase() && allowed.includes(k);
    const unknown = Object.keys(C).find((k) => cmd === String(C[k]).toLowerCase() && !allowed.includes(k));
    const reply = (d) => { if (d) send({ t: "sys", move: st.move, d }); send({ t: "done", move: st.move, try: 1, lock: false }); };
    if (unknown) return reply(t("commandUnavailable", { cmd: C[unknown] }));
    const arg = d.trim().slice(words[0].length).trim();
    if (Object.values(C).some((c) => cmd === String(c).toLowerCase())) rec({ who: "cmd", move: st.move, text: d.trim() });
    const grab = grabIn;
    const taskCmd = ["task", "run", "coder", "audit", "apply", "fail", "done", "drop"].find(is);
    if (taskCmd) return reply(task(taskCmd, arg, grab));
    if (is("short")) {
      const n = Number(words[1]) || cfg.limits.short, prev = st.last && st.last.who === "agent" ? st.last.text : null;
      if (!prev) return reply(t("nothingToAdd"));
      const w = countWords(prev);
      if (w <= n) return reply(t("shortFits", { n, words: w }));
      st.try += 1;
      return toAgent(t("retry", { limit: n, questions: cfg.limits.questions, err: t("errWords", { n: w, limit: n }), oneQuestion: "" }), "auto");
    }
    if (is("iteration")) {
      const r = newIteration(P, arg);
      if (r.error) return reply(r.error);
      send({ t: "openTab", tab: r.chat, focus: true });
      return reply(t("iterationCreated", { name: r.name }));
    }
    if (is("model")) {
      const [, a, m] = words;
      if (!a) { send({ t: "done", move: st.move, try: 1, lock: false }); return pick(null); }
      if (m && !available(a, m)) { send({ t: "sys", move: st.move, d: t("modelUnavailable", { model: m }) }); send({ t: "done", move: st.move, try: 1, lock: false }); return; }
      if (setModel(a, m || cfg.default.models[a] || a)) send({ t: "sys", move: st.move, d: t("modelSet", { provider: a, model: st.modelReq }) });
      const redo = st.redo; st.redo = null;
      send({ t: "done", move: st.move, try: 1, lock: !!redo });
      if (redo) { send({ t: "sys", move: st.move + 1, d: t("redo") }); input(redo); }
      return;
    }
    if (is("add") || is("replace")) {
      const op = is("add") ? "add" : "replace";
      const src = grab(arg);
      let note;
      if (!src) note = t("nothingToAdd");
      else if (op === "add") {
        fs.appendFileSync(ART, (fs.existsSync(ART) && fs.statSync(ART).size ? "\n" : "") + src.text.trimEnd() + "\n");
        note = t("added", { file: artRel, move: src.move, who: src.who });
      } else {
        fs.writeFileSync(ART, src.text.trimEnd() + "\n");
        note = t("replaced", { file: artRel, move: src.move, who: src.who });
      }
      rec({ ev: op, move: src?.move, who: src?.who, file: artRel, note, ...(arg ? { saved: arg } : {}) });
      send({ t: "sys", move: st.move, d: note });
      send({ t: "done", move: st.move, try: 1, lock: false });
      return;
    }
    if (!available(st.agent, st.modelReq)) { st.redo = d; send({ t: "done", move: st.move, try: 1, lock: false }); return pick(t("modelUnavailable", { model: st.modelReq })); }
    st.move += 1; st.try = 1; st.mul = 1;
    let text = d;
    const x = /(^|[^`\p{L}\p{N}])x(\d+)(?=$|[^`\p{L}\p{N}])/iu.exec(text);
    if (x) {
      st.mul = Math.max(1, Number(x[2]));
      text = (text.slice(0, x.index + x[1].length) + text.slice(x.index + x[0].length)).replace(/\s{2,}/g, " ").trim();
      rec({ ev: "limit", move: st.move, mul: st.mul, limit: cfg.limits.words * st.mul });
    }
    if (!text) { send({ t: "done", move: st.move, try: 1, lock: false }); return; }
    toAgent(text, "human");
  }

  function task(op, arg, grab) {
    const first = arg.split(/\s+/)[0];
    let n = role ? taskN : op === "task" || op === "run" || !/^\d+$/.test(first) ? null : first;
    if (!role && n) arg = arg.slice(first.length).trim();
    const tf = (x) => path.join(P.dir, P.at(W.file, { iteration, author: owner, n: x }));
    const IO = jsonlWork;
    const status = (o) => IO.mark(tf(n), { ts: new Date().toISOString(), author: me.author, ...o });
    const tree = () => broadcast({ t: "tree" });
    const say = (k, v) => t(W.role && T[k + "Exp"] ? k + "Exp" : k, v);
    if (op === "task" || op === "run") {
      const src = grab(arg);
      if (!src) return t("nothingToAdd");
      const m = nextNum(dirsOf(path.dirname(path.dirname(tf("0")))));
      fs.mkdirSync(path.dirname(tf(m)), { recursive: true });
      IO.create(tf(m), m, src.text.trimEnd(), me.author);
      rec({ ev: "task", n: m }); tree();
      if (op === "task") return say("taskSaved", { n: m, file: P.at(W.file, { iteration, author: owner, n: m }) });
      n = String(m); op = "coder"; arg = "";
    }
    const fromStage = !role && op === "apply";
    if (!n && (op === "coder" || op === "drop" || fromStage)) {
      const list = dirsOf(path.dirname(path.dirname(tf("0")))).map((x) => ({ n: x, ...IO.read(tf(x)) })).filter((x) => x.text !== null && x.text !== undefined && !cfg.closed.includes(x.status) && (!fromStage || x.status === cfg.ready))
        .sort((a, b) => Number(a.n) - Number(b.n));
      const fresh = list.filter((x) => !x.status);
      const one = op === "coder" ? (fresh.length === 1 ? fresh[0] : list.length === 1 ? list[0] : null) : fromStage && list.length === 1 ? list[0] : null;
      if (one) n = one.n;
      else if (!list.length) return say(fromStage ? "noReadyTasks" : "noOpenTasks");
      else { send({ t: "pickTask", cmd: C[op], title: say("pickTask"), list: list.map((x) => ({ n: x.n, text: x.text })) }); return ""; }
    }
    const T0 = n && IO.read(tf(n));
    if (!T0) return say("taskNone", { n: n || "" });
    const spec = P.artPath(W.spec, iteration, me.author);
    const chatOfRole = (r) => pname + "/" + P.at(W.chat, { iteration, n, author: owner, role: r });
    const fresh = (r) => !session(chatOfRole(r)).hist.some((h) => h.who === "human");
    const open = (r, text) => { const chat = chatOfRole(r); session(chat).kick(text); return chat; };
    const src = (op === "coder" && !role) || op === "drop" || op === "ready" || fromStage ? null : grab(arg);
    if (op !== "done" && op !== "coder" && op !== "drop" && op !== "ready" && !fromStage && !src) return t("nothingToAdd");
    if (fromStage && !T0.diff) return t("nothingToAdd");
    if (op === "coder" && role && !src) return t("nothingToAdd");
    const exp = !!W.role;
    let note;
    if (op === "coder" && exp) {
      const scratch = scratchDir({ project: pname, iteration, stage: W.stage, n });
      const chat = open(W.role, fill(FT[W.text], { n, task: T0.text, spec, scratch }));
      status({ s: "coding" }); note = say("taskOpened", { n, chat });
      if (cfg.ui.openTabs.includes(W.key)) send({ t: "openTab", tab: chat });
    } else if (op === "coder") {
      const text = role && !fresh("coder") ? fill(FT.toCoderAgain, { n, remarks: src.text.trimEnd() }) : fill(FT.toCoder, { n, task: T0.text, spec }) + (role ? "\n\n" + fill(FT.toCoderAgain, { n, remarks: src.text.trimEnd() }) : "");
      status({ s: "coding" }); note = t("taskOpened", { n, chat: open("coder", text) });
    } else if (op === "audit") {
      const diff = src.text.trimEnd(), key = role === "apply" ? "toAuditorFinal" : fresh("auditor") ? "toAuditor" : "toAuditorAgain";
      status({ s: role === "apply" ? "final" : "audit", diff }); note = t("taskOpened", { n, chat: open("auditor", fill(FT[key], { n, task: T0.text, spec, diff })) });
    } else if (op === "apply") {
      const diff = src ? src.text.trimEnd() : T0.diff;
      status({ s: "apply", diff }); note = t("taskOpened", { n, chat: open("apply", fill(FT.toApply, { n, task: T0.text, spec, diff })) });
    } else if (op === "ready") {
      status({ s: cfg.ready }); note = t("taskReady", { n });
    } else if (op === "drop") {
      const prefix = pname + "/" + path.posix.dirname(P.at(W.file, { iteration, author: owner, n })) + "/";
      for (const [k, S2] of sessions) if (k.startsWith(prefix)) S2.stop();
      status({ s: "dropped", ...(arg ? { why: arg } : {}) }); note = say("taskDropped", { n });
    } else if (op === "fail") {
      status({ s: "back", why: src.text.trimEnd() }); note = t(exp ? "experimentFailed" : "taskFailed", { n, file: P.at(W.file, { iteration, author: owner, n }) });
    } else {
      const outcome = T0.status;
      status({ s: exp ? "closed" : "done" });
      if (exp && W.list) {
        const list = path.join(P.dir, P.at(W.list, { iteration })), all = readJson(list) || {};
        if (outcome !== "closed") all[owner + "/" + n] = { outcome, chat: P.at(W.chat, { iteration, author: owner, n }) };
        fs.writeFileSync(list, JSON.stringify(all, null, 2) + "\n");
        send({ t: "sys", move: st.move, d: t("expToArtifact", { n, file: P.at(W.list, { iteration }) }) });
      } note = t(exp ? "experimentSaved" : "taskDone", { n, file: P.at(W.file, { iteration, author: owner, n }) });
    }
    rec({ ev: op, n, note }); tree();
    return note;
  }

  function stop() {
    if (!st.proc) return;
    const p = st.proc, was = st.busy; st.proc = null;
    if (was && st.text) {
      rec({ who: "agent", agent: st.agent, t0: st.t0, move: st.move, try: st.try, text: st.text, sid: st.sid, stopped: true });
      st.last = { who: "agent", move: st.move, try: st.try, text: st.text };
    }
    busy(false); st.text = ""; p.kill();
    if (was) { send({ t: "sys", move: st.move, d: t("stopped") }); feed("stopped", st.last && st.last.who === "agent" ? st.last.text : ""); }
    send({ t: "done", move: st.move, try: st.try, lock: false });
  }

  function grabIn(a) { const blocks = st.last ? [...st.last.text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)] : []; return a ? { who: "human", move: st.move, text: a } : st.last && { ...st.last, text: blocks.length ? blocks.at(-1)[1] : st.last.text }; }
  const rounds = (r) => session(pname + "/" + P.at(W.chat, { iteration, n: taskN, author: owner, role: r })).hist.filter((h) => h.who === "human").length;
  function feed(kind, detail) {
    if (!role || !W) return;
    const at = { iteration, author: owner, n: taskN }, s = jsonlWork.read(path.join(P.dir, P.at(W.file, at)));
    const e = { ts: new Date().toISOString(), project: pname, chat: rel, work: W.key, ...at, role, kind, status: s && s.status, detail: tail(detail) };
    if (cfg.feed.attention.includes(kind)) queue.set(qkey(e), e); else queue.delete(qkey(e));
    broadcast({ t: "feed" });
  }
  function auto(text) {
    const A = flow.auto;
    if (W && W.role && role === W.role && FT.outcomeYes) {
      const o = outcomeOf(FT, text), f = path.join(P.dir, P.at(W.file, { iteration, author: owner, n: taskN })), was = jsonlWork.read(f);
      if (!o.outcome && was && was.result) { broadcast({ t: "tree" }); return feed("answered", text); }
      jsonlWork.mark(f, { ts: new Date().toISOString(), s: o.s, ...(o.outcome ? { result: o.body.includes(o.outcome) ? o.body : o.body + "\n\n" + o.outcome } : { why: o.body }) });
      broadcast({ t: "tree" });
      return feed(o.outcome ? o.s : "notDone", o.body);
    }
    if (!A || !role || !W || W.role) return;
    const T1 = jsonlWork.read(path.join(P.dir, P.at(W.file, { iteration, author: owner, n: taskN })));
    if (!T1 || cfg.closed.includes(T1.status)) return;
    const block = [...text.matchAll(new RegExp("```" + A.diff + "\\n([\\s\\S]*?)```", "g"))].at(-1)?.[1];
    const given = (x) => () => ({ text: x });
    let note = null;
    let kind = null;
    if (role === "coder" && block) { note = task("audit", "", given(block)); kind = "toAuditor"; }
    else if (role === "coder") kind = "question";
    else if (role === "apply" && block && flow.tests) return runTests(block);
    else if (role === "apply") { note = block ? task("audit", "", given(block)) : task("fail", "", given(text)); kind = block ? "toAuditor" : "applyFailed"; }
    else if (role === "auditor") {
      const said = A.okLastLine ? text.trim().split("\n").at(-1) : text;
      if (said.trim().replace(new RegExp(A.okTrim + "$"), "") === A.ok) { kind = T1.status === "final" ? "done" : "ready"; note = task(kind, "", given("")); }
      else if (rounds("coder") < cfg.limits.tries) { note = task("coder", "", given(text)); kind = "remarks"; }
      else { note = task("fail", "", given(t("roundsOut", { n: cfg.limits.tries }) + "\n\n" + text)); kind = "roundsOut"; }
    }
    if (kind) feed(kind, text);
    if (note) send({ t: "sys", move: st.move, d: t("autoStep", { note }) });
  }
  function runTests(block) {
    const T = flow.tests, given = (x) => () => ({ text: x }), step = (note) => send({ t: "sys", move: st.move, d: t("autoStep", { note }) });
    if (!fs.existsSync(path.join(P.dir, T.file))) { send({ t: "sys", move: st.move, d: t("testsNone", { file: T.file }) }); step(task("audit", "", given(block))); return feed("toAuditor", block); }
    send({ t: "sys", move: st.move, d: t("testsRun", { cmd: T.run.join(" ") }) });
    busy(true);
    let out = "";
    const p = spawn(T.run[0], T.run.slice(1), { cwd: P.dir, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => { out += "\n" + t("testsTimeout", { ms: T.timeout }); p.kill(); }, T.timeout);
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    p.on("error", (e) => { out += String(e.message); });
    p.on("close", (code) => {
      clearTimeout(timer); busy(false);
      const tail = out.trimEnd().split("\n").slice(-T.tail).join("\n");
      rec({ ev: "tests", code, out: tail });
      if (code === 0) { send({ t: "sys", move: st.move, d: t("testsOk") }); step(task("audit", "", given(block))); return feed("testsOk", tail); }
      send({ t: "sys", move: st.move, d: t("testsFailed", { code }) });
      if (rounds("apply") < cfg.limits.tries) { step(t("testsBack")); kick(fill(FT[T.text], { code, out: tail })); return feed("testsBack", tail); }
      step(task("fail", "", given(t("roundsOut", { n: cfg.limits.tries }) + "\n\n" + tail)));
      feed("testsOut", tail);
    });
  }
  const kick = (text) => { st.move += 1; st.try = 1; st.mul = 1; send({ t: "kicked", move: st.move, d: text }); toAgent(text, "human"); };
  const note = (d) => rec({ who: "cmd", move: st.move, text: d });
  const S = { rel, st, clients, hist, acts, info, input, rec, stop, kick, note, pushLight, logged: () => !!log };
  sessions.set(rel, S);
  return S;
}

const wss = new WebSocketServer({ noServer: true });
const broadcast = (o) => { const s = JSON.stringify(o); for (const ws of wss.clients) if (ws.readyState === 1) ws.send(s); if (o.t === "tree") setImmediate(() => { for (const S of sessions.values()) S.pushLight(); }); };
const pwss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://ife");
  const s = url.pathname === "/ws" ? wss : url.pathname === "/pty" ? pwss : null;
  if (!s || !hostOk(req) || !originOk(req) || !same(url.searchParams.get(cfg.auth.param))) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return socket.destroy(); }
  s.handleUpgrade(req, socket, head, (ws) => s.emit("connection", ws, req));
});
let pty = null;
try { pty = require("node-pty"); } catch (e) { console.error(t("ptyUnavailable") + ": " + e.message); }
pwss.on("connection", (ws) => {
  if (!pty) { ws.send(t("ptyUnavailable") + "\r\n"); return ws.close(); }
  const p = pty.spawn(process.env.SHELL || cfg.terminal.shell, [], { name: "xterm-256color", cols: 80, rows: 24, cwd: ROOT, env: cleanEnv(cfg.terminal.unsetEnv) });
  p.onData((d) => ws.readyState === 1 && ws.send(d));
  p.onExit(() => ws.close());
  ws.on("message", (m) => {
    const s = m.toString();
    if (s.startsWith('{"resize"')) { const [c, r] = JSON.parse(s).resize; if (c > 0 && r > 0) p.resize(c, r); } else p.write(s);
  });
  ws.on("close", () => p.kill());
});
wss.on("connection", (ws) => {
  const mine = new Set();
  const open = (rel) => {
    let S; try { S = session(rel); } catch (e) { return ws.send(JSON.stringify({ chat: rel, t: "sys", d: e.message })); }
    S.clients.add(ws); mine.add(S);
    const i = S.info();
    ws.send(JSON.stringify({ chat: S.rel, t: "hist", info: i,
      list: [...S.hist.map((h) => ({ who: h.who, agent: h.agent, ts: h.who === "agent" ? h.t0 || h.ts : h.ts, at: h.ts, move: h.move, try: h.try, text: h.text, err: h.err, offStage: h.offStage, stopped: h.stopped })),
        ...S.acts.map((a) => ({ who: "act", at: a.ts, move: a.move, try: a.try, text: a.d }))].sort((a, b) => String(a.at).localeCompare(String(b.at))) }));
  };
  ws.on("message", (m) => {
    const msg = JSON.parse(m);
    if (msg.t === "open") open(msg.chat);
    else if (msg.t === "hints") {
      me.hints = !!msg.on;
      fs.writeFileSync(CONF, JSON.stringify({ ...(readJson(CONF) || {}), hints: me.hints }, null, 2) + "\n");
    }
    else if (msg.t === "cmd") { try { session(msg.chat).note(String(msg.d)); } catch (e) { ws.send(JSON.stringify({ chat: msg.chat, t: "sys", d: e.message })); } }
    else if (msg.t === "stop") { try { session(msg.chat).stop(); } catch (e) { ws.send(JSON.stringify({ chat: msg.chat, t: "sys", d: e.message })); } }
    else if (msg.t === "in") { try { session(msg.chat).input(msg.d); } catch (e) { ws.send(JSON.stringify({ chat: msg.chat, t: "sys", d: e.message })); } }
  });
  ws.on("close", () => { for (const S of mine) { S.clients.delete(ws); if (S.logged()) S.rec({ ev: "ws-close" }); } });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { for (const S of sessions.values()) S.st.proc?.kill(); process.exit(0); });

rebuild();
ensureVscode().catch((e) => { console.error(e.message); process.exit(1); }).then(() => server.listen(PORT, "127.0.0.1", () => {
  const link = `http://127.0.0.1:${PORT}/ide?${cfg.auth.param}=${TOKEN}`;
  console.log(t("openOnce", { url: link }));
  if (fresh && cfg.auth.browser) spawn(cfg.auth.browser, [link], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  console.log(agentsLine());
  console.log(t("listen", { url: `http://127.0.0.1:${PORT}/ide`, cwd: ROOT, author: me.author, lang: me.lang, provider: cfg.default.provider, model: cfg.default.models[cfg.default.provider] }));
}));
