// backend/state/stateStore.js
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

// Storage directory (JSON-based persistence)
const STATE_DIR = path.join(__dirname, "..", "project_state");
if (!fs.existsSync(STATE_DIR)) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

/**
 * Data Shape Definitions
 * (JSDoc for IDE support + easy future migration to DB)
 *
 * @typedef {Object} ConversationMessage
 * @property {string} id
 * @property {"user"|"assistant"|"system"} role
 * @property {string} content
 * @property {string} ts
 *
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {"todo"|"in_progress"|"done"|"blocked"} status
 * @property {number} priority
 * @property {string[]} dependsOn
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {Object} TaskRun
 * @property {string} id
 * @property {string|null} taskId
 * @property {"planner"|"cline"|"user"|"other"} source
 * @property {string} inputPrompt
 * @property {string|null} clineLogsRaw
 * @property {string|null} clineLogsSummary
 * @property {"running"|"success"|"failed"} status
 * @property {string} startedAt
 * @property {string|null} finishedAt
 *
 * @typedef {Object} RepoSnapshot
 * @property {string|null} lastGitStatus
 * @property {string|null} lastChangesSummary
 * @property {string|null} takenAt
 *
 * @typedef {Object} ProjectSettings
 * @property {string} defaultMode
 * @property {boolean} allowPremium
 * @property {string|null} preferredModel
 *
 * @typedef {Object} ProjectState
 * @property {string} projectId
 * @property {{
 *   messages: ConversationMessage[],
 *   summary: string|null
 * }} conversation
 * @property {Task[]} tasks
 * @property {TaskRun[]} taskRuns
 * @property {RepoSnapshot} repoSnapshot
 * @property {ProjectSettings} settings
 */

// In-memory cache
/** @type {Map<string, ProjectState>} */
const memoryCache = new Map();
// Simple write-lock to avoid simultaneous FS writes
const savingProjects = new Set();

function filePathForProject(projectId) {
  const safeId = projectId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(STATE_DIR, `${safeId}.json`);
}

function readStateFromDisk(projectId) {
  try {
    const file = filePathForProject(projectId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeStateToDisk(projectId, state) {
  try {
    const file = filePathForProject(projectId);
    fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("Error saving project state:", err);
  }
}

/** @param {string} projectId */
function createDefaultState(projectId) {
  const now = new Date().toISOString();
  return {
    projectId,
    conversation: { messages: [], summary: null },
    tasks: [],
    taskRuns: [],
    repoSnapshot: {
      lastGitStatus: null,
      lastChangesSummary: null,
      takenAt: null,
    },
    settings: {
      defaultMode: "chat",
      allowPremium: true,
      preferredModel: null,
    },
  };
}

/** @param {any} raw @param {string} projectId */
function normalizeState(raw, projectId) {
  const base = createDefaultState(projectId);
  if (!raw || typeof raw !== "object") return base;

  const s = { ...base, ...raw };

  if (!s.conversation || !Array.isArray(s.conversation.messages)) {
    s.conversation = base.conversation;
  }

  if (!Array.isArray(s.tasks)) s.tasks = [];
  if (!Array.isArray(s.taskRuns)) s.taskRuns = [];

  if (!s.repoSnapshot || typeof s.repoSnapshot !== "object") {
    s.repoSnapshot = base.repoSnapshot;
  }

  if (!s.settings) s.settings = base.settings;

  return s;
}

/**
 * Load state (prefer memory, fallback to disk)
 * @param {string} projectId
 * @returns {Promise<ProjectState>}
 */
async function loadProjectState(projectId) {
  const id = projectId || "default";

  if (memoryCache.has(id)) return memoryCache.get(id);

  const fromDisk = readStateFromDisk(id);
  const normalized = normalizeState(fromDisk, id);

  memoryCache.set(id, normalized);
  return normalized;
}

/**
 * Persist state (memory + disk)
 * @param {string} projectId
 * @param {ProjectState} state
 */
async function saveProjectState(projectId, state) {
  const id = projectId || "default";
  memoryCache.set(id, state);

  if (savingProjects.has(id)) return;
  savingProjects.add(id);

  try {
    writeStateToDisk(id, state);
  } finally {
    savingProjects.delete(id);
  }
}

/**
 * Conversation handling
 */
async function appendMessage(projectId, msg) {
  const state = await loadProjectState(projectId);

  const message = {
    id: randomUUID(),
    role: msg.role,
    content: String(msg.content ?? ""),
    ts: new Date().toISOString(),
  };

  state.conversation.messages.push(message);
  await saveProjectState(projectId, state);
  return message;
}

async function getRecentMessages(projectId, limit = 30) {
  const state = await loadProjectState(projectId);
  const all = state.conversation.messages;
  return all.slice(-limit);
}

/**
 * Tasks
 */
async function createTask(projectId, data) {
  const state = await loadProjectState(projectId);
  const now = new Date().toISOString();

  const task = {
    id: data.id || `T-${state.tasks.length + 1}`,
    title: data.title || "Untitled Task",
    description: data.description || "",
    status: data.status || "todo",
    priority: data.priority ?? 1,
    dependsOn: Array.isArray(data.dependsOn) ? data.dependsOn : [],
    createdAt: now,
    updatedAt: now,
  };

  state.tasks.push(task);
  await saveProjectState(projectId, state);
  return task;
}

async function updateTask(projectId, taskId, patch) {
  const state = await loadProjectState(projectId);
  const idx = state.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return null;

  const now = new Date().toISOString();
  state.tasks[idx] = {
    ...state.tasks[idx],
    ...patch,
    updatedAt: now,
  };

  await saveProjectState(projectId, state);
  return state.tasks[idx];
}

/**
 * Task Runs (Cline + Planner execution traces)
 */
async function startTaskRun(projectId, data) {
  const state = await loadProjectState(projectId);

  const run = {
    id: data.id || `RUN-${state.taskRuns.length + 1}`,
    taskId: data.taskId ?? null,
    source: data.source || "planner",
    inputPrompt: data.inputPrompt || "",
    clineLogsRaw: null,
    clineLogsSummary: null,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  state.taskRuns.push(run);
  await saveProjectState(projectId, state);
  return run;
}

async function finishTaskRun(projectId, runId, patch) {
  const state = await loadProjectState(projectId);
  const idx = state.taskRuns.findIndex(r => r.id === runId);
  if (idx === -1) return null;

  const now = new Date().toISOString();
  state.taskRuns[idx] = {
    ...state.taskRuns[idx],
    ...patch,
    finishedAt: patch.finishedAt || now,
  };

  await saveProjectState(projectId, state);
  return state.taskRuns[idx];
}

/**
 * Repo Snapshot (sync from MCP tools)
 */
async function updateRepoSnapshot(projectId, snapshot) {
  const state = await loadProjectState(projectId);
  state.repoSnapshot = {
    ...state.repoSnapshot,
    ...snapshot,
    takenAt: snapshot.takenAt || new Date().toISOString(),
  };
  await saveProjectState(projectId, state);
  return state.repoSnapshot;
}

// EXPORTS
module.exports = {
  loadProjectState,
  saveProjectState,
  appendMessage,
  getRecentMessages,
  createTask,
  updateTask,
  startTaskRun,
  finishTaskRun,
  updateRepoSnapshot,
};
