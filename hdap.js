/**
 * hdap.js — integração do BloggySource com a rede HDAP.
 *
 * O BloggySource continua sendo o painel local. Este módulo adiciona uma
 * camada que fala com a rede HDAP através do `hdap-cli` (thin client),
 * permitindo:
 *
 *   - ler os artigos publicados em `HDAP!<pyle>@<dono>/artigos`;
 *   - publicar/atualizar artigos na mesma estrutura usada pelo blog;
 *   - configurar tudo pela interface web (nó, dono, identidade, caminho do
 *     binário do `hdap-cli`, etc).
 *
 * A identidade padrão (`hbu`) é criada e registrada automaticamente no
 * primeiro uso, num cofre local em `data/identity/`.
 *
 * Nada aqui depende de rede além do `hdap-cli`; por isso a ferramenta roda
 * em qualquer máquina que tenha o binário.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "hdap-config.json");
const TMP_DIR = path.join(DATA_DIR, "tmp");

/* ------------------------------------------------------------------ *
 * Configuração
 * ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  // Liga/desliga toda a integração HDAP.
  enabled: true,

  // "default" usa o hdap-cli que acompanha o projeto; "local" usa o
  // binário indicado em `cliPath` (o hdap-cli da máquina da pessoa).
  mode: "default",
  cliPath: "",

  // Nó HDAP padrão e identidade pública usada para ler.
  // Ajuste o host/porta/TLS pin do nó que você usa (Configurações no leitor).
  host: "hdap.exemplo.org",
  port: 8443,
  tlsPin: "",

  // Dono do espaço e pasta onde ficam os artigos.
  owner: "",
  articlesPath: "artigos",

  // Identidade local (cofre). Criada no primeiro uso se não existir.
  nickname: "hbu",
  identityHome: "",
  passphrase: "hbu",

  // Publicação automática ao criar/editar um post no BloggySource.
  autoPublish: true,

  // Cache da listagem de artigos (ms).
  cacheTtlMs: 5 * 60 * 1000,

  // Link "Ir para o blog no BloggySource". Vazio = painel local (/blog.html).
  bloggysourceUrl: "",

  // Aparência do leitor.
  siteTitle: "HBU",
  siteDescription: "Leitor e publicador de artigos na rede HDAP.",
  language: "pt",
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!patch || typeof patch !== "object") return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

let config = { ...DEFAULT_CONFIG };

function ensureDataDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  ensureDataDirs();
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      config = deepMerge(DEFAULT_CONFIG, raw);
    }
  } catch (err) {
    console.error("[HDAP] falha ao ler a configuração, usando padrões:", err.message);
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

function saveConfig(patch) {
  config = deepMerge(config, patch || {});
  ensureDataDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  // Qualquer mudança de identidade/nó invalida o cache em memória.
  resetRuntimeCache();
  return config;
}

function getConfig() {
  return config;
}

/** Config pública (sem a passphrase em texto claro). */
function publicConfig() {
  const { passphrase, ...rest } = config;
  return { ...rest, passphraseSet: !!passphrase };
}

/* ------------------------------------------------------------------ *
 * Resolução do binário do hdap-cli
 * ------------------------------------------------------------------ */

function candidateCliPaths() {
  const list = [];
  const local = config.mode === "local";
  // A variável de ambiente sempre tem prioridade.
  if (process.env.HDAP_CLI) list.push(process.env.HDAP_CLI);
  if (local) {
    // Modo "local": usa o binário indicado pela pessoa.
    if (config.cliPath) list.push(config.cliPath);
  } else {
    // Modo "default": o hdap-cli que acompanha o projeto.
    list.push(path.join(ROOT, "bin", "hdap-cli"));
    list.push(path.join(ROOT, "bin", "hdap-cli.exe"));
    if (config.cliPath) list.push(config.cliPath);
  }
  return list;
}

function resolveCli() {
  for (const p of candidateCliPaths()) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (_) {
      /* ignora */
    }
  }
  // Último recurso: confia no PATH.
  return "hdap-cli";
}

function cliAvailable() {
  const p = resolveCli();
  if (p === "hdap-cli") return true; // assume que está no PATH
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Execução do CLI (serializada)
 * ------------------------------------------------------------------ */

// O cofre/OTP é sensível a concorrência; serializamos todas as chamadas.
let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function execCli(args, timeoutMs = 45000) {
  const bin = resolveCli();
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout || "";
          err.stderr = stderr || "";
          return reject(err);
        }
        resolve({ stdout: stdout || "", stderr: stderr || "" });
      },
    );
  });
}

function identityHome() {
  return config.identityHome
    ? path.resolve(config.identityHome)
    : path.join(DATA_DIR, "identity");
}

function identityPaths() {
  const home = identityHome();
  return {
    home,
    krypte: path.join(home, "krypte.hdap"),
    prosopeion: path.join(home, "prosopeion.hdap"),
  };
}

function globalFlags() {
  const f = ["--host", String(config.host), "--port", String(config.port)];
  if (config.tlsPin) f.push("--tls-pin", String(config.tlsPin));
  f.push("--home", identityHome());
  if (config.passphrase) f.push("--pass", String(config.passphrase));
  return f;
}

function errorText(err) {
  return `${(err && err.stderr) || ""}\n${(err && err.stdout) || ""}\n${(err && err.message) || ""}`;
}

function httpStatusFromError(err) {
  const m = errorText(err).match(/status:\s*(\d{3})/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Transforma o erro cru do `hdap-cli` (um panic do Rust) numa mensagem curta
 * e legível, aproveitando o status HTTP e o corpo da resposta quando existirem.
 */
function humanError(err) {
  const text = errorText(err);

  let detail = "";
  const bodyM = text.match(/body:\s*"((?:[^"\\]|\\.)*)"/);
  if (bodyM) {
    try {
      detail = JSON.parse(`"${bodyM[1]}"`);
    } catch (_) {
      detail = bodyM[1];
    }
    try {
      const j = JSON.parse(detail);
      if (j && j.error) detail = j.error;
    } catch (_) {
      /* mantém o texto puro */
    }
  }

  const status = httpStatusFromError(err);
  const actionM = text.match(/([a-z ]+ failed):/i);

  const parts = [];
  if (status) parts.push(`HTTP ${status}`);
  if (detail) parts.push(detail);
  else if (actionM) parts.push(actionM[1].trim());

  if (parts.length) return parts.join(" — ");

  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((l) => l && !/RUST_BACKTRACE|note: run with/i.test(l));
  return lines.pop() || "erro desconhecido ao falar com o HDAP";
}

/* ------------------------------------------------------------------ *
 * Identidade + sessão
 * ------------------------------------------------------------------ */

function configSignature() {
  return [
    identityHome(),
    config.nickname,
    config.host,
    config.port,
    config.tlsPin || "",
    resolveCli(),
  ].join("|");
}

let runtime = {
  signature: null,
  ensurePromise: null,
  identityId: null,
  token: null,
  tokenExp: 0,
};

function resetRuntimeCache() {
  runtime = {
    signature: null,
    ensurePromise: null,
    identityId: null,
    token: null,
    tokenExp: 0,
  };
  articleCache = { at: 0, items: null };
}

/**
 * Garante que exista um cofre local e que ele esteja registrado no nó.
 * Idempotente: só executa trabalho na primeira vez por configuração.
 */
function ensureIdentity(force = false) {
  const sig = configSignature();
  if (!force && runtime.ensurePromise && runtime.signature === sig) {
    return runtime.ensurePromise;
  }
  runtime.signature = sig;
  runtime.token = null;
  runtime.tokenExp = 0;

  const task = serialize(async () => {
    const { home, krypte, prosopeion } = identityPaths();
    fs.mkdirSync(home, { recursive: true });

    let created = false;
    if (!fs.existsSync(krypte) || !fs.existsSync(prosopeion)) {
      await execCli([...globalFlags(), "init", config.nickname], 30000);
      created = true;
    }

    let id = null;
    try {
      const { stdout } = await execCli([...globalFlags(), "whoami"], 20000);
      id = stdout.trim().split(/\s+/).pop() || null;
    } catch (_) {
      /* sem identidade legível */
    }

    let registered = false;
    try {
      await execCli([...globalFlags(), "register"], 30000);
      registered = true;
    } catch (err) {
      const status = httpStatusFromError(err);
      const text = errorText(err);
      if (status === 409 || /already|já registrad|registered/i.test(text)) {
        registered = true;
      } else if (created) {
        throw err;
      }
    }

    runtime.identityId = id;
    return { created, registered, id };
  });

  task.catch(() => {
    // Permite nova tentativa numa próxima chamada.
    if (runtime.signature === sig) runtime.ensurePromise = null;
  });

  runtime.ensurePromise = task;
  return task;
}

async function getToken(force = false) {
  if (!force && runtime.token && Date.now() < runtime.tokenExp) {
    return runtime.token;
  }
  await ensureIdentity();
  const { stdout } = await execCli([...globalFlags(), "auth"], 90000);
  const m = stdout.match(/token\s+([0-9a-fA-F]+)/);
  if (!m) throw new Error("auth não devolveu um token válido");
  runtime.token = m[1];
  runtime.tokenExp = Date.now() + 11 * 60 * 60 * 1000;
  return runtime.token;
}

/* ------------------------------------------------------------------ *
 * Operações de arquivo
 * ------------------------------------------------------------------ */

function parseListing(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (!line || line === "(empty)") continue;
    if (line.endsWith("/")) {
      out.push({ name: line.slice(0, -1), dir: true, size: 0, hash: "" });
      continue;
    }
    const parts = line.split("\t");
    if (parts.length >= 2) {
      const sizeM = (parts[1] || "").match(/(\d+)/);
      out.push({
        name: parts[0],
        dir: false,
        size: sizeM ? parseInt(sizeM[1], 10) : 0,
        hash: parts[2] || "",
      });
    }
  }
  return out;
}

async function listDir(dir = "") {
  const token = await getToken();
  const args = [...globalFlags(), "list", token, config.owner];
  if (dir) args.push(dir);
  const { stdout } = await execCli(args, 45000);
  return parseListing(stdout);
}

function tmpFile(prefix) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return path.join(
    TMP_DIR,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

async function downloadFile(remotePath) {
  const token = await getToken();
  const out = tmpFile("dl");
  try {
    await execCli([...globalFlags(), "download", token, config.owner, remotePath, out], 90000);
    return fs.readFileSync(out);
  } finally {
    try {
      fs.unlinkSync(out);
    } catch (_) {}
  }
}

async function uploadFile(remotePath, data) {
  const token = await getToken();
  const f = tmpFile("ul");
  fs.writeFileSync(f, data);
  try {
    const { stdout } = await execCli(
      [...globalFlags(), "upload", token, config.owner, remotePath, f],
      180000,
    );
    const m = stdout.match(/hash\s+([0-9a-fA-F]+)/);
    return { hash: m ? m[1] : null, output: stdout.trim() };
  } finally {
    try {
      fs.unlinkSync(f);
    } catch (_) {}
  }
}

/* ------------------------------------------------------------------ *
 * Documentos de artigo (.md)
 * ------------------------------------------------------------------ */

function slugify(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function articleFileName(post) {
  return `${post.id}-${slugify(post.title)}.md`;
}

function parseArticle(raw) {
  const text = String(raw).replace(/\r\n/g, "\n");
  const sepIdx = text.search(/\n---\n/);
  const header = sepIdx >= 0 ? text.slice(0, sepIdx) : text;
  let content = sepIdx >= 0 ? text.slice(sepIdx + 5) : "";
  content = content.replace(/^\n+/, "");

  const titleM = header.match(/^#\s+(.*)$/m);
  const meta = {};
  const re = /\*\*([^*\n]+):\*\*\s*([^\n]*)/g;
  let m;
  while ((m = re.exec(header))) meta[m[1].trim()] = m[2].trim();

  const categories = (meta["Categorias"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    title: titleM ? titleM[1].trim() : "",
    id: meta["ID"] ? parseInt(meta["ID"], 10) : null,
    author: meta["Autor"] || "",
    publishedAt: meta["Publicado em"] || "",
    updatedAt: meta["Atualizado em"] || "",
    description: meta["Descrição"] || "",
    categories,
    content,
  };
}

function buildArticle(post) {
  const cats = (post.categories || []).join(", ");
  const header =
    `# ${post.title}\n\n` +
    `**ID:** ${post.id}\n\n` +
    `**Autor:** ${post.author}\n\n` +
    `**Publicado em:** ${post.publishedAt}\n\n` +
    `**Atualizado em:** ${post.updatedAt}\n\n` +
    `**Descrição:** ${post.description || ""}\n\n` +
    `**Categorias:** ${cats}\n`;
  let body = post.content || "";
  if (!body.endsWith("\n")) body += "\n";
  return `${header}\n---\n\n${body}`;
}

/* ------------------------------------------------------------------ *
 * Listagem de artigos (com cache)
 * ------------------------------------------------------------------ */

let articleCache = { at: 0, items: null };

function isArticleFile(name) {
  return /\.(md|markdown|txt)$/i.test(name);
}

async function getArticles({ refresh = false } = {}) {
  if (!refresh && articleCache.items && Date.now() - articleCache.at < config.cacheTtlMs) {
    return articleCache.items;
  }

  const entries = await listDir(config.articlesPath);
  const files = entries.filter((e) => !e.dir && isArticleFile(e.name));
  const items = [];

  for (const f of files) {
    const remotePath = `${config.articlesPath}/${f.name}`;
    try {
      const buf = await downloadFile(remotePath);
      const parsed = parseArticle(buf.toString("utf8"));
      items.push({
        ...parsed,
        file: f.name,
        path: remotePath,
        size: f.size,
        hash: f.hash,
      });
    } catch (err) {
      // Um arquivo ilegível não deve derrubar a listagem inteira.
      items.push({
        title: f.name.replace(/\.(md|markdown|txt)$/i, ""),
        id: null,
        author: "",
        publishedAt: "",
        updatedAt: "",
        description: "",
        categories: [],
        content: "",
        file: f.name,
        path: remotePath,
        size: f.size,
        hash: f.hash,
        error: humanError(err),
      });
    }
  }

  items.sort((a, b) => {
    if (a.id != null && b.id != null) return b.id - a.id;
    return String(b.publishedAt).localeCompare(String(a.publishedAt));
  });

  articleCache = { at: Date.now(), items };
  return items;
}

async function getArticleByFile(name) {
  if (!name || /[/\\]/.test(name)) throw new Error("nome de arquivo inválido");
  const remotePath = `${config.articlesPath}/${name}`;
  const buf = await downloadFile(remotePath);
  const parsed = parseArticle(buf.toString("utf8"));
  return { ...parsed, file: name, path: remotePath, size: buf.length };
}

/**
 * Publica um post do BloggySource no HDAP, na mesma estrutura dos artigos.
 * `post` = { id, title, content, description, author, created_at, updated_at, categories }
 */
async function publishPost(post, { refresh = true } = {}) {
  const fileName = articleFileName(post);
  const remotePath = `${config.articlesPath}/${fileName}`;
  const doc = buildArticle(post);
  const { hash } = await uploadFile(remotePath, Buffer.from(doc, "utf8"));
  if (refresh) articleCache = { at: 0, items: null };
  return { file: fileName, path: remotePath, hash, bytes: Buffer.byteLength(doc) };
}

async function deleteArticle(fileName) {
  const token = await getToken();
  const remotePath = `${config.articlesPath}/${fileName}`;
  await execCli([...globalFlags(), "delete", token, config.owner, remotePath], 45000);
  articleCache = { at: 0, items: null };
  return { deleted: true, path: remotePath };
}

/* ------------------------------------------------------------------ *
 * Estado / diagnóstico
 * ------------------------------------------------------------------ */

async function nodeHealth() {
  const { stdout } = await execCli([...globalFlags(), "health"], 20000);
  const facts = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^([a-z_]+)=(.*)$/);
    if (m) facts[m[1]] = m[2];
  }
  return facts;
}

async function status() {
  const s = {
    enabled: !!config.enabled,
    cliPath: resolveCli(),
    cliAvailable: cliAvailable(),
    node: { host: config.host, port: config.port, reachable: false, serverId: null, error: null },
    identity: { home: identityHome(), exists: false, id: runtime.identityId, nickname: config.nickname },
    authenticated: !!(runtime.token && Date.now() < runtime.tokenExp),
    articlesPath: config.articlesPath,
    owner: config.owner,
  };

  const { krypte, prosopeion } = identityPaths();
  s.identity.exists = fs.existsSync(krypte) && fs.existsSync(prosopeion);

  if (!s.cliAvailable) {
    s.node.error = "hdap-cli não encontrado";
    return s;
  }

  try {
    const facts = await nodeHealth();
    s.node.reachable = true;
    s.node.serverId = facts.server_id || null;
    s.node.nodeEncPub = facts.node_enc_pub || null;
    if (facts.tls_pin && facts.tls_pin !== config.tlsPin) {
      s.node.tlsPinMismatch = true;
      s.node.reportedTlsPin = facts.tls_pin;
    }
  } catch (err) {
    s.node.error = errorText(err).trim().split("\n").filter(Boolean).pop() || "falha no health";
  }

  return s;
}

async function setup({ force = false } = {}) {
  const res = await ensureIdentity(force);
  let token = null;
  let authError = null;
  try {
    token = await getToken(true);
  } catch (err) {
    authError = errorText(err).trim().split("\n").filter(Boolean).pop();
  }
  return { ...res, authenticated: !!token, authError };
}

/* ------------------------------------------------------------------ *
 * Inicialização
 * ------------------------------------------------------------------ */

function init() {
  loadConfig();
  ensureDataDirs();
  // Pré-aquece a identidade em segundo plano (sem travar o servidor).
  if (config.enabled && cliAvailable()) {
    ensureIdentity().catch((err) => {
      console.warn("[HDAP] não foi possível preparar a identidade:", errorText(err).trim().split("\n").pop());
    });
  }
  return config;
}

module.exports = {
  DEFAULT_CONFIG,
  init,
  loadConfig,
  saveConfig,
  getConfig,
  publicConfig,
  resetRuntimeCache,
  resolveCli,
  cliAvailable,
  ensureIdentity,
  getToken,
  listDir,
  downloadFile,
  uploadFile,
  getArticles,
  getArticleByFile,
  publishPost,
  deleteArticle,
  parseArticle,
  buildArticle,
  articleFileName,
  slugify,
  nodeHealth,
  status,
  setup,
  errorText,
  humanError,
  httpStatusFromError,
};
