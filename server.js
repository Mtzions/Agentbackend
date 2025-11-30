// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

// -------------------------------------------
// CONFIG
// -------------------------------------------

const app = express();
const port = process.env.PORT || 3001;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WORLDSOUND_MCP_URL =
  process.env.WORLDSOUND_MCP_URL || "http://localhost:8050/sse";

// Chat / planner models
const DEFAULT_CHAT_MODEL = "gpt-5-mini";
const HEAVY_CHAT_MODEL = "gpt-5.1";

// OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// -------------------------------------------
// EXPRESS MIDDLEWARE
// -------------------------------------------

app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);

app.use(express.json());

// -------------------------------------------
// HELPERS & IN-MEMORY STATE
// -------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

// In-memory store (replace with real DB later)
const memory = {
  projects: {},
};

function getOrCreateProject(projectId = "default") {
  if (!memory.projects[projectId]) {
    memory.projects[projectId] = {
      id: projectId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      tasks: [],
      taskRuns: [],
      messages: [],
      repoSnapshot: null,
      events: [],
    };
  }
  return memory.projects[projectId];
}

// -------------------------------------------
// STATE STORE
// -------------------------------------------

const stateStore = {
  // ----- Projects -----
  async getProject(projectId) {
    return getOrCreateProject(projectId);
  },

  // ----- Messages (conversation history) -----
  async addMessage(projectId, msg) {
    const p = getOrCreateProject(projectId);
    const m = {
      id: makeId("msg"),
      role: msg.role || "user",
      source: msg.source || "ui",
      content: msg.content || "",
      createdAt: msg.createdAt || nowIso(),
      taskId: msg.taskId || null,
      runId: msg.runId || null,
      metadata: msg.metadata || {},
    };
    p.messages.push(m);
    p.updatedAt = nowIso();
    return m;
  },

  async getMessages(projectId, limit = 50) {
    const p = getOrCreateProject(projectId);
    if (!p.messages.length) return [];
    return p.messages.slice(-limit);
  },

  // ----- Tasks -----
  async addTask(projectId, task) {
    const p = getOrCreateProject(projectId);
    const t = {
      id: task.id || makeId("T"),
      title: task.title || "Untitled task",
      description: task.description || "",
      type: task.type || "analysis",
      priority:
        typeof task.priority === "number" ? task.priority : 5, // default mid priority
      status: task.status || "todo",
      dependsOn: task.dependsOn || [],
      agentHint: task.agentHint || "coder",
      source: task.source || "manual",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    p.tasks.push(t);
    p.updatedAt = nowIso();
    return t;
  },

  async addTasks(projectId, tasks) {
    const results = [];
    for (const t of tasks) {
      results.push(await this.addTask(projectId, t));
    }
    return results;
  },

  async getTasks(projectId) {
    const p = getOrCreateProject(projectId);
    return p.tasks;
  },

  async getTask(projectId, taskId) {
    const p = getOrCreateProject(projectId);
    return p.tasks.find((t) => t.id === taskId) || null;
  },

  async updateTask(projectId, taskId, patch) {
    const p = getOrCreateProject(projectId);
    const idx = p.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return null;
    p.tasks[idx] = {
      ...p.tasks[idx],
      ...patch,
      updatedAt: nowIso(),
    };
    p.updatedAt = nowIso();
    return p.tasks[idx];
  },

  // ----- Task Runs -----
  async createTaskRun(projectId, run) {
    const p = getOrCreateProject(projectId);
    const r = {
      id: makeId("run"),
      taskId: run.taskId,
      agent: run.agent || "cline",
      status: run.status || "pending",
      mode: run.mode || "normal", // "normal" | "dry_run" | "debug"
      startedAt: run.startedAt || nowIso(),
      finishedAt: run.finishedAt || null,
      logs: run.logs || [],
      metadata: run.metadata || {},
    };
    p.taskRuns.push(r);
    p.updatedAt = nowIso();
    return r;
  },

  async updateTaskRun(projectId, runId, patch) {
    const p = getOrCreateProject(projectId);
    const idx = p.taskRuns.findIndex((r) => r.id === runId);
    if (idx === -1) return null;
    p.taskRuns[idx] = {
      ...p.taskRuns[idx],
      ...patch,
    };

    // auto-finish when status becomes terminal
    if (
      patch.status &&
      !p.taskRuns[idx].finishedAt &&
      ["success", "failed", "cancelled"].includes(p.taskRuns[idx].status)
    ) {
      p.taskRuns[idx].finishedAt = nowIso();
    }

    // merge metadata
    if (patch.metadata) {
      p.taskRuns[idx].metadata = {
        ...p.taskRuns[idx].metadata,
        ...patch.metadata,
      };
    }

    p.updatedAt = nowIso();
    return p.taskRuns[idx];
  },

  async appendRunLog(projectId, runId, logEntry) {
    const p = getOrCreateProject(projectId);
    const run = p.taskRuns.find((r) => r.id === runId);
    if (!run) return null;
    run.logs.push({
      id: makeId("log"),
      ts: logEntry.ts || Date.now(),
      type: logEntry.type || "info",
      message: logEntry.message || "",
      data: logEntry.data || {},
    });
    p.updatedAt = nowIso();
    return run;
  },

  async getTaskRuns(projectId, filters = {}) {
    const p = getOrCreateProject(projectId);
    let runs = p.taskRuns;
    if (filters.taskId) {
      runs = runs.filter((r) => r.taskId === filters.taskId);
    }
    if (filters.status) {
      runs = runs.filter((r) => r.status === filters.status);
    }
    return runs;
  },

  // ----- Repo Snapshot -----
  async setRepoSnapshot(projectId, snapshot) {
    const p = getOrCreateProject(projectId);
    p.repoSnapshot = {
      ...(p.repoSnapshot || {}),
      ...snapshot,
      updatedAt: nowIso(),
    };
    p.updatedAt = nowIso();
    return p.repoSnapshot;
  },

  async getRepoSnapshot(projectId) {
    const p = getOrCreateProject(projectId);
    return p.repoSnapshot || null;
  },

  // ----- Project Events (for timeline) -----
  async addProjectEvent(projectId, event) {
    const p = getOrCreateProject(projectId);
    if (!p.events) p.events = [];
    const evt = {
      id: makeId("evt"),
      ts: nowIso(),
      type: event.type,
      data: event.data || {},
    };
    p.events.push(evt);
    p.updatedAt = nowIso();
    return evt;
  },

  // ----- Project summary -----
  async getProjectState(projectId) {
    const p = getOrCreateProject(projectId);
    return {
      id: p.id,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      tasks: p.tasks,
      taskRuns: p.taskRuns.slice(-50),
      messages: p.messages.slice(-50),
      repoSnapshot: p.repoSnapshot,
      events: p.events?.slice(-100) || [],
    };
  },
};

// -------------------------------------------
// SYSTEM PROMPTS
// -------------------------------------------

function getChatSystemPrompt() {
  return `
You are the ChatGPT Planner agent for WorldSound Agent Hub.

- You talk to the user about their projects, tasks, and codebase.
- You can suggest breaking work into smaller tasks and workflows.
- You can reference "Task Queue", "Agents", and "AI Workflow" conceptually,
  but in /api/chat you are NOT directly executing code, only advising.

Formatting rules:
- Always respond in clean Markdown.
- Start with a short **Summary** section when helpful.
- Use headings (##, ###), bullet lists, and numbered steps.
- Use fenced code blocks with language tags for code examples.
`;
}

function getPlannerJsonPrompt() {
  // Used for /api/plan and /api/planner/with-mcp
  return `
You are the Planner agent for WorldSound Agent Hub.

The user describes a software goal or change they want. 
You MUST return ONLY a single valid JSON object. No backticks. No markdown. No commentary.

Schema:
{
  "projectTitle": "short human title",
  "summary": "1-2 sentence description of the goal",
  "tasks": [
    {
      "id": "T1",
      "title": "Short task title",
      "description": "What this task will do",
      "type": "analysis" | "frontend" | "backend" | "infra" | "research" | "testing",
      "priority": 1,
      "dependsOn": ["T0"],
      "agentHint": "planner" | "coder" | "devops" | "tester"
    }
  ]
}

Rules:
- Use stable IDs like "T1", "T2", "T3".
- Order tasks in logical execution order.
- Use dependsOn to express prerequisites (can be empty).
- Make descriptions clear enough for a coder agent.
`;
}

// -------------------------------------------
// MCP HELPERS (repo snapshot + MCP-aware planning)
// -------------------------------------------

async function refreshRepoSnapshot(projectId) {
  if (!OPENAI_API_KEY || !WORLDSOUND_MCP_URL) {
    console.warn(
      "[refreshRepoSnapshot] Missing OPENAI_API_KEY or WORLDSOUND_MCP_URL; skipping."
    );
    return null;
  }

  try {
    const resp = await openai.responses.create({
      model: HEAVY_CHAT_MODEL,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Inspect the repository using MCP tools (get_repo_info, git_status).",
            },
          ],
        },
      ],
      tools: [
        {
          type: "mcp",
          server_label: "worldsound-mcp",
          server_url: WORLDSOUND_MCP_URL,
          allowed_tools: ["get_repo_info", "git_status"],
          require_approval: "never",
        },
      ],
      tool_choice: "auto",
    });

    let repoInfo = null;
    let gitStatus = null;

    (resp.output || []).forEach((item) => {
      if (
        item.type === "mcp_call" &&
        item.name === "get_repo_info" &&
        item.output
      ) {
        try {
          repoInfo = JSON.parse(item.output);
        } catch (e) {
          console.warn("[refreshRepoSnapshot] Failed to parse get_repo_info:", e);
        }
      }
      if (
        item.type === "mcp_call" &&
        item.name === "git_status" &&
        item.output
      ) {
        gitStatus = item.output;
      }
    });

    const snapshot = {
      repoInfo,
      gitStatus,
      updatedAt: nowIso(),
    };

    await stateStore.setRepoSnapshot(projectId, snapshot);
    return snapshot;
  } catch (err) {
    console.error("[refreshRepoSnapshot] Error calling MCP:", err);
    return null;
  }
}

// -------------------------------------------
// CLINE PROMPT BUILDER (handoff only)
// -------------------------------------------

function buildClinePromptPayload({ projectId, task, run, repoSnapshot }) {
  return {
    taskId: task.id,
    runId: run.id,
    projectId,
    goal: task.title,
    description: task.description,
    context: {
      repo_root: repoSnapshot?.repoInfo?.repo_root || "<set REPO_ROOT>",
      branch: repoSnapshot?.repoInfo?.current_branch || null,
      latest_commit: repoSnapshot?.repoInfo?.latest_commit || null,
      git_status: repoSnapshot?.gitStatus || null,
    },
    instructions: [
      "Work directly in the repository to complete this task.",
      "Prefer minimal, focused changes.",
      "Keep existing styles, behavior, and public APIs unless explicitly asked to change them.",
    ],
    acceptance_criteria: [
      "The task goal is satisfied.",
      "No TypeScript/JavaScript runtime errors.",
      "No obvious regressions in related features.",
    ],
    mode: run.mode || "normal",
  };
}

// For now, Cline is manual: we just prepare the payload and store it.
const clineRunner = {
  async runTask(projectId, task, run, repoSnapshot) {
    const payload = buildClinePromptPayload({
      projectId,
      task,
      run,
      repoSnapshot,
    });

    // mark run as "waiting_for_user" and attach clinePrompt
    await stateStore.updateTaskRun(projectId, run.id, {
      status: "waiting_for_user",
      metadata: {
        ...(run.metadata || {}),
        clinePrompt: payload,
      },
    });

    await stateStore.appendRunLog(projectId, run.id, {
      type: "info",
      message:
        "Cline prompt prepared. Copy `metadata.clinePrompt` into your Cline agent to execute this task.",
      data: { payload },
    });

    await stateStore.addProjectEvent(projectId, {
      type: "cline_prompt_prepared",
      data: { runId: run.id, taskId: task.id },
    });

    return payload;
  },
};

// -------------------------------------------
// ROUTES
// -------------------------------------------

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "worldsound-backend",
    mcpUrl: WORLDSOUND_MCP_URL,
  });
});

// -------------------------------------------
// /api/chat — normal chat with Planner
// -------------------------------------------

app.post("/api/chat", async (req, res) => {
  try {
    const {
      projectId = "default",
      mode = "chat",
      usePremium = false,
      messages,
    } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    const systemContent = getChatSystemPrompt();
    const model = usePremium ? HEAVY_CHAT_MODEL : DEFAULT_CHAT_MODEL;

    const openAiMessages = [
      { role: "system", content: systemContent },
      ...messages,
    ];

    console.log("[/api/chat] model:", model, "mode:", mode);

    const completion = await openai.chat.completions.create({
      model,
      messages: openAiMessages,
    });

    const reply = completion.choices[0].message;

    // Save latest user + assistant messages
    await stateStore.addMessage(projectId, {
      role: "user",
      source: "ui",
      content: messages[messages.length - 1].content,
      createdAt: nowIso(),
    });

    await stateStore.addMessage(projectId, {
      role: reply.role || "assistant",
      source: "planner",
      content: reply.content,
      createdAt: nowIso(),
    });

    res.json({
      projectId,
      mode,
      model,
      reply,
    });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("Error in /api/chat:", detail);
    res.status(500).json({ error: "OpenAI request failed", detail });
  }
});

// -------------------------------------------
// /api/plan — JSON plan (non-MCP, simple)
// -------------------------------------------

app.post("/api/plan", async (req, res) => {
  try {
    const { projectId = "default", messages, usePremium = true } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array required" });
    }

    const systemContent = getPlannerJsonPrompt();
    const model = usePremium ? HEAVY_CHAT_MODEL : DEFAULT_CHAT_MODEL;

    const openAiMessages = [
      { role: "system", content: systemContent },
      ...messages,
    ];

    const completion = await openai.chat.completions.create({
      model,
      messages: openAiMessages,
      response_format: { type: "json_object" },
    });

    const reply = completion.choices[0].message;
    let plan = null;

    try {
      plan = JSON.parse(reply.content);
    } catch (e) {
      console.warn("[/api/plan] Failed to parse JSON plan:", e);
    }

    await stateStore.addMessage(projectId, {
      role: "assistant",
      source: "planner",
      content: reply.content,
      createdAt: nowIso(),
    });

    let createdTasks = [];
    if (plan && Array.isArray(plan.tasks)) {
      createdTasks = await stateStore.addTasks(
        projectId,
        plan.tasks.map((t) => ({
          ...t,
          source: "planner",
          status: "todo",
        }))
      );

      await stateStore.addProjectEvent(projectId, {
        type: "planner_created_tasks",
        data: { count: createdTasks.length },
      });
    }

    res.json({
      projectId,
      model,
      raw: reply.content,
      plan,
      createdTasks,
    });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("Error in /api/plan:", detail);
    res.status(500).json({ error: "OpenAI planning request failed", detail });
  }
});

// -------------------------------------------
// /api/planner/with-mcp — MCP-aware planning
// -------------------------------------------

app.post("/api/planner/with-mcp", async (req, res) => {
  try {
    const { projectId = "default", prompt } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required" });
    }

    // Refresh repo snapshot (so planner has recent info)
    const snapshot = await refreshRepoSnapshot(projectId);

    const devText = `${getPlannerJsonPrompt()}

IMPORTANT:
Before producing a plan, you may call MCP tools like:
- \`get_repo_info\`
- \`git_status\`
- \`read_file\`
- \`search_in_files\`

Use them to understand:
- Current branch
- File changes
- High level structure

Never hallucinate file paths — confirm via search if needed.
Your final output MUST be only a valid JSON plan as per schema.`;

    const response = await openai.responses.create({
      model: HEAVY_CHAT_MODEL,
      input: [
        {
          role: "developer",
          content: [{ type: "input_text", text: devText }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      tools: [
        {
          type: "mcp",
          server_label: "worldsound-mcp",
          server_url: WORLDSOUND_MCP_URL,
          allowed_tools: [
            "get_repo_info",
            "git_status",
            "read_file",
            "search_in_files",
          ],
          require_approval: "never",
        },
      ],
      tool_choice: "auto",
    });

    const outputText = response.output_text || "";
    let plan = null;

    try {
      plan = JSON.parse(outputText);
    } catch (e) {
      console.warn("[/api/planner/with-mcp] Failed to parse JSON plan:", e);
    }

    await stateStore.addMessage(projectId, {
      role: "user",
      source: "ui",
      content: prompt,
      createdAt: nowIso(),
    });

    await stateStore.addMessage(projectId, {
      role: "assistant",
      source: "planner",
      content: outputText,
      createdAt: nowIso(),
      metadata: { snapshotUsed: !!snapshot },
    });

    let createdTasks = [];
    if (plan && Array.isArray(plan.tasks)) {
      createdTasks = await stateStore.addTasks(
        projectId,
        plan.tasks.map((t) => ({
          ...t,
          source: "planner",
          status: "todo",
        }))
      );

      await stateStore.addProjectEvent(projectId, {
        type: "planner_created_tasks",
        data: { count: createdTasks.length },
      });
    }

    res.json({
      projectId,
      model: response.model,
      raw: outputText,
      plan,
      createdTasks,
      repoSnapshot: snapshot,
    });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("Error in /api/planner/with-mcp:", detail);
    res.status(500).json({ error: "MCP-aware planning failed", detail });
  }
});

// -------------------------------------------
// /api/cline/callback — record Cline's final result
// -------------------------------------------

app.post("/api/cline/callback", async (req, res) => {
  try {
    const { projectId = "default", runId, taskId, result } = req.body || {};

    if (!runId || typeof runId !== "string") {
      return res.status(400).json({ error: "Valid runId is required" });
    }
    if (!result || typeof result !== "object") {
      return res.status(400).json({ error: "result object is required" });
    }

    const {
      status,
      summary,
      files_touched = [],
      commands_run = [],
      acceptance_criteria = [],
      notes,
      error,
    } = result;

    if (!status) {
      return res
        .status(400)
        .json({ error: "result.status (success/failed) is required" });
    }

    // 1) Update run status + metadata
    const runPatch = {
      status: status === "success" ? "success" : "failed",
      metadata: {
        clineResult: result,
      },
    };

    const updatedRun = await stateStore.updateTaskRun(projectId, runId, runPatch);
    if (!updatedRun) {
      return res.status(404).json({ error: "Run not found" });
    }

    // 2) Append structured logs
    if (summary) {
      await stateStore.appendRunLog(projectId, runId, {
        type: "summary",
        message: summary,
      });
    }

    for (const f of files_touched) {
      await stateStore.appendRunLog(projectId, runId, {
        type: "file",
        message: `File ${f.change_type || "modified"}: ${f.path}`,
        data: f,
      });
    }

    for (const c of commands_run) {
      await stateStore.appendRunLog(projectId, runId, {
        type: "command",
        message: `Command: ${c.command} (${c.outcome || "unknown"})`,
        data: c,
      });
    }

    for (const ac of acceptance_criteria) {
      await stateStore.appendRunLog(projectId, runId, {
        type: "criteria",
        message: `Criteria "${ac.criteria}" met=${ac.met}`,
        data: ac,
      });
    }

    if (notes) {
      await stateStore.appendRunLog(projectId, runId, {
        type: "notes",
        message: notes,
      });
    }

    if (error) {
      await stateStore.appendRunLog(projectId, runId, {
        type: "error",
        message: error,
      });
    }

    // 3) Mark task done/failed
    if (taskId) {
      await stateStore.updateTask(projectId, taskId, {
        status: status === "success" ? "done" : "failed",
      });
    }

    // 3.5) Add agent-visible conversation message
    await stateStore.addMessage(projectId, {
      role: "assistant",
      source: "coder",
      taskId: taskId || null,
      runId,
      content: `Run **${runId}** for task **${
        taskId || "N/A"
      }** finished with status: **${status}**.\n${summary || ""}`,
      createdAt: nowIso(),
    });

    // 3.6) Record project event
    await stateStore.addProjectEvent(projectId, {
      type: "task_run_finished",
      data: { runId, taskId: taskId || null, status },
    });

    // 4) Refresh repo snapshot for UI
    const snapshot = await refreshRepoSnapshot(projectId);

    res.json({
      ok: true,
      projectId,
      runId,
      taskId: taskId || null,
      run: updatedRun,
      repoSnapshot: snapshot,
    });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("Error in /api/cline/callback:", detail);
    res.status(500).json({ error: "Failed to process Cline callback", detail });
  }
});

// -------------------------------------------
// TASK QUEUE ENDPOINTS
// -------------------------------------------

// Get all tasks for a project
app.get("/api/tasks/:projectId", async (req, res) => {
  const { projectId } = req.params;
  const tasks = await stateStore.getTasks(projectId);
  tasks.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (a.createdAt || "").localeCompare(b.createdAt || "");
  });
  res.json({ projectId, tasks });
});

// Create manual task
app.post("/api/tasks/:projectId", async (req, res) => {
  const { projectId } = req.params;
  const body = req.body || {};
  const task = await stateStore.addTask(projectId, {
    title: body.title,
    description: body.description,
    type: body.type || "analysis",
    priority: body.priority,
    status: "todo",
    dependsOn: body.dependsOn || [],
    agentHint: body.agentHint || "coder",
    source: "manual",
  });

  await stateStore.addProjectEvent(projectId, {
    type: "task_created_manual",
    data: { taskId: task.id },
  });

  res.status(201).json({ projectId, task });
});

// Update a task
app.patch("/api/tasks/:projectId/:taskId", async (req, res) => {
  const { projectId, taskId } = req.params;
  const patch = req.body || {};
  const updated = await stateStore.updateTask(projectId, taskId, patch);
  if (!updated) return res.status(404).json({ error: "Task not found" });

  await stateStore.addProjectEvent(projectId, {
    type: "task_updated",
    data: { taskId },
  });

  res.json({ projectId, task: updated });
});

// Run a task (create Task Run + Cline handoff)
app.post("/api/tasks/:projectId/:taskId/run", async (req, res) => {
  try {
    const { projectId, taskId } = req.params;
    const mode = (req.body && req.body.mode) || "normal";

    const task = await stateStore.getTask(projectId, taskId);
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    // Create run
    const run = await stateStore.createTaskRun(projectId, {
      taskId: task.id,
      agent: "cline",
      status: "pending",
      mode,
      startedAt: nowIso(),
      metadata: { mode },
    });

    await stateStore.addProjectEvent(projectId, {
      type: "task_run_started",
      data: { runId: run.id, taskId, mode },
    });

    // Refresh snapshot and prepare Cline prompt
    const snapshot = await refreshRepoSnapshot(projectId);
    const payload = await clineRunner.runTask(projectId, task, run, snapshot);

    res.status(201).json({
      projectId,
      task,
      run,
      clinePrompt: payload,
    });
  } catch (err) {
    const detail = err?.response?.data || err.message || String(err);
    console.error("Error in /api/tasks/:projectId/:taskId/run:", detail);
    res.status(500).json({ error: "Failed to start task run", detail });
  }
});

// -------------------------------------------
// TASK RUNS ENDPOINTS
// -------------------------------------------

// List runs (optional filters)
app.get("/api/task-runs/:projectId", async (req, res) => {
  const { projectId } = req.params;
  const { taskId, status } = req.query;
  const runs = await stateStore.getTaskRuns(projectId, {
    taskId,
    status,
  });
  res.json({ projectId, runs });
});

// Get logs for a run
app.get("/api/task-runs/:projectId/:runId/logs", async (req, res) => {
  const { projectId, runId } = req.params;
  const p = getOrCreateProject(projectId);
  const run = p.taskRuns.find((r) => r.id === runId);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json({ projectId, runId, logs: run.logs || [] });
});

// Manual update of run (status / metadata)
app.patch("/api/task-runs/:projectId/:runId", async (req, res) => {
  const { projectId, runId } = req.params;
  const patch = req.body || {};
  const updated = await stateStore.updateTaskRun(projectId, runId, patch);
  if (!updated) return res.status(404).json({ error: "Run not found" });

  await stateStore.addProjectEvent(projectId, {
    type: "task_run_updated",
    data: { runId },
  });

  res.json({ projectId, run: updated });
});

// -------------------------------------------
// PROJECT STATE FOR FRONTEND
// -------------------------------------------

app.get("/api/state/:projectId", async (req, res) => {
  const { projectId } = req.params;
  const state = await stateStore.getProjectState(projectId);
  res.json(state);
});

// -------------------------------------------
// START SERVER
// -------------------------------------------

app.listen(port, () => {
  console.log(`WorldSound backend listening on http://localhost:${port}`);
  console.log(`MCP URL configured as: ${WORLDSOUND_MCP_URL}`);
});
