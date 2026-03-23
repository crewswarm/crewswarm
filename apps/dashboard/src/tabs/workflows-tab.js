import { getJSON, postJSON } from "../core/api.js";
import { escHtml, showNotification } from "../core/dom.js";

let hideAllViews = () => {};
let setNavActive = () => {};
let knownAgents = [];
let knownSkills = [];

const wfState = {
  selectedName: "",
  list: [],
  runStatus: {},
  editorWorkflow: null,
};

const WORKFLOW_TEMPLATES = [
  {
    id: "daily-research",
    name: "Daily Research Brief",
    description: "Research, summarize, then QA-check every weekday morning.",
    schedule: "0 9 * * 1-5",
    stages: [
      {
        agent: "crew-researcher",
        task: "Research top 5 updates for our current project and summarize key signals.",
      },
      {
        agent: "crew-pm",
        task: "Turn the research into a concise daily brief with priorities and risks.",
      },
      {
        agent: "crew-qa",
        task: "Review the brief for factual clarity and missing edge cases.",
      },
    ],
  },
  {
    id: "seo-content",
    name: "SEO Content Pipeline",
    description: "Generate SEO topic ideas, draft copy, then edit.",
    schedule: "30 10 * * 1,3,5",
    stages: [
      {
        agent: "crew-seo",
        task: "Find one high-intent keyword cluster and propose a short content outline.",
      },
      {
        agent: "crew-copywriter",
        task: "Write a first draft from the outline. Keep it scannable and conversion-focused.",
      },
      {
        agent: "crew-main",
        task: "Polish the draft and produce final publish-ready copy.",
      },
    ],
  },
  {
    id: "code-health",
    name: "Code Health Sweep",
    description: "Automated PM->Coder->QA quality pass.",
    schedule: "0 14 * * 1-5",
    stages: [
      {
        agent: "crew-pm",
        task: "Pick one high-value backlog item from project context and define acceptance criteria.",
      },
      {
        agent: "crew-coder",
        task: "Implement the scoped item in small safe changes and summarize files touched.",
      },
      {
        agent: "crew-qa",
        task: "Audit the changes, run tests, and report any regressions with severity.",
      },
    ],
  },
];

function emptyWorkflow(name = "") {
  return {
    name,
    description: "",
    enabled: false,
    schedule: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    stages: [{ agent: "crew-main", task: "", tool: "" }],
  };
}

export function initWorkflowsTab(deps = {}) {
  hideAllViews = deps.hideAllViews || hideAllViews;
  setNavActive = deps.setNavActive || setNavActive;
}

export async function showWorkflows() {
  hideAllViews();
  document.getElementById("workflowsView")?.classList.add("active");
  setNavActive("navWorkflows");
  await loadAgents();
  await loadSkills();
  await loadWorkflowList();
}

async function loadAgents() {
  try {
    const agents = await getJSON("/api/agents");
    knownAgents = (agents || [])
      .map((a) => (typeof a === "string" ? a : a.id || a.agent))
      .filter(Boolean)
      .sort();
  } catch {
    knownAgents = [];
  }
}

async function loadSkills() {
  try {
    const data = await getJSON("/api/skills");
    knownSkills = (data.skills || [])
      .map((s) => ({
        name: s.name || "",
        description: s.description || "",
        type: s.type || (s.url ? "api" : "knowledge"),
      }))
      .filter((s) => s.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    knownSkills = [];
  }
}

async function loadWorkflowList() {
  const listEl = document.getElementById("workflowList");
  if (!listEl) return;
  listEl.innerHTML =
    '<div class="meta" style="padding:10px;">Loading workflows...</div>';
  try {
    const data = await getJSON("/api/workflows/list");
    wfState.list = data.workflows || [];
    renderWorkflowList();
    if (wfState.selectedName) {
      await loadWorkflowItem(wfState.selectedName);
    } else {
      renderWorkflowEditor(emptyWorkflow());
    }
    const tz =
      data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzEl = document.getElementById("workflowTimezoneLabel");
    if (tzEl) tzEl.textContent = `Local timezone: ${tz}`;
  } catch (e) {
    listEl.innerHTML = `<div class="meta" style="padding:10px;color:var(--red-hi);">Failed to load workflows: ${escHtml(e.message)}</div>`;
  }
}

function renderWorkflowList() {
  const listEl = document.getElementById("workflowList");
  if (!listEl) return;
  const items = wfState.list || [];
  if (!items.length) {
    listEl.innerHTML =
      '<div class="meta" style="padding:10px;">No workflows yet.</div>';
    return;
  }
  listEl.innerHTML = items
    .map((w) => {
      const active =
        w.name === wfState.selectedName
          ? "background:var(--bg-2);border-color:var(--accent);"
          : "";
      const schedule = w.schedule
        ? escHtml(w.schedule)
        : '<span style="opacity:0.7;">no schedule</span>';
      const running = w.runState?.running
        ? '<span style="color:var(--green-hi);font-size:11px;">running</span>'
        : "";
      return `
        <button class="btn-ghost workflow-row" data-workflow-name="${escHtml(w.name)}" style="width:100%;text-align:left;display:flex;flex-direction:column;gap:4px;padding:10px;margin-bottom:8px;${active}">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <strong style="font-size:13px;">${escHtml(w.name)}</strong>
            ${running}
          </div>
          <div style="font-size:11px;color:var(--text-3);">${w.enabled ? "enabled" : "disabled"} · ${w.stageCount || 0} stage(s)</div>
          <div style="font-size:11px;color:var(--text-2);font-family:monospace;">${schedule}</div>
        </button>
      `;
    })
    .join("");
  listEl.querySelectorAll(".workflow-row").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.workflowName || "";
      await loadWorkflowItem(name);
    });
  });
}

async function loadWorkflowItem(name) {
  if (!name) return;
  try {
    const data = await getJSON(
      `/api/workflows/item?name=${encodeURIComponent(name)}`,
    );
    wfState.selectedName = name;
    wfState.runStatus = data.runState || {};
    renderWorkflowList();
    renderWorkflowEditor({ name, ...(data.workflow || {}) }, data);
    await loadWorkflowLog(name);
  } catch (e) {
    showNotification(`Failed to load workflow: ${e.message}`, "error");
  }
}

function buildAgentOptions(selected) {
  const defaults = [
    "crew-main",
    "crew-pm",
    "crew-qa",
    "crew-coder",
    "crew-coder-front",
    "crew-coder-back",
    "crew-copywriter",
  ];
  const merged = Array.from(
    new Set([...(knownAgents || []), ...defaults, selected || ""]),
  )
    .filter(Boolean)
    .sort();
  return merged
    .map(
      (id) =>
        `<option value="${escHtml(id)}" ${id === selected ? "selected" : ""}>${escHtml(id)}</option>`,
    )
    .join("");
}

function scheduleHint(cronExpr) {
  const v = String(cronExpr || "").trim();
  if (!v) return "No schedule set. Add a cron expression or use a preset.";
  const presetHints = {
    "*/15 * * * *": "Runs every 15 minutes",
    "0 * * * *": "Runs hourly at minute 0",
    "0 9 * * 1-5": "Runs weekdays at 9:00",
    "0 9 * * *": "Runs daily at 9:00",
    "0 0 * * 1": "Runs every Monday at midnight",
    "0 8 1 * *": "Runs monthly on day 1 at 8:00",
  };
  return presetHints[v] || "Custom cron schedule";
}

function buildCronPresetButtons() {
  const presets = [
    { label: "Every 15m", cron: "*/15 * * * *" },
    { label: "Hourly", cron: "0 * * * *" },
    { label: "Daily 9am", cron: "0 9 * * *" },
    { label: "Weekdays 9am", cron: "0 9 * * 1-5" },
    { label: "Weekly Mon", cron: "0 0 * * 1" },
    { label: "Monthly", cron: "0 8 1 * *" },
  ];
  return presets
    .map(
      (p) =>
        `<button class="btn-ghost wf-cron-preset" data-cron="${escHtml(p.cron)}" style="font-size:11px;padding:4px 8px;">${escHtml(p.label)}</button>`,
    )
    .join("");
}

function renderTemplateCards() {
  return WORKFLOW_TEMPLATES.map(
    (t) => `
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px;background:var(--bg-2);">
        <div style="font-size:12px;font-weight:700;">${escHtml(t.name)}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:4px;">${escHtml(t.description)}</div>
        <div style="font-size:11px;color:var(--text-2);font-family:monospace;margin-top:6px;">${escHtml(t.schedule)}</div>
        <div style="margin-top:8px;">
          <button class="btn-ghost wf-apply-template" data-template-id="${escHtml(t.id)}" style="font-size:11px;">Use Template</button>
        </div>
      </div>
    `,
  ).join("");
}

function renderOptionsList() {
  const agents = knownAgents.length
    ? knownAgents
        .map((a) => `<code style="font-size:11px;">${escHtml(a)}</code>`)
        .join(" ")
    : '<span style="font-size:11px;color:var(--text-3);">No agents loaded</span>';
  const skills = knownSkills.length
    ? knownSkills
        .map(
          (s) =>
            `<div style="font-size:11px;line-height:1.4;"><code>${escHtml(s.name)}</code> <span style="color:var(--text-3);">(${escHtml(s.type)})</span></div>`,
        )
        .join("")
    : '<span style="font-size:11px;color:var(--text-3);">No skills loaded</span>';
  return { agents, skills };
}

function renderWorkflowEditor(wf, meta = {}) {
  const editor = document.getElementById("workflowEditor");
  if (!editor) return;
  const workflow = {
    ...emptyWorkflow(),
    ...wf,
  };
  const stages =
    Array.isArray(workflow.stages) && workflow.stages.length
      ? workflow.stages
      : emptyWorkflow().stages;
  wfState.editorWorkflow = {
    ...workflow,
    stages: stages.map((s) => ({ ...s })),
  };
  const cronCmd = meta.cronExample
    ? escHtml(meta.cronExample)
    : `*/15 * * * * cd ${escHtml(window.location.pathname || ".")} && node scripts/run-scheduled-pipeline.mjs ${escHtml(workflow.name || "my-workflow")}`;
  const optionsList = renderOptionsList();
  editor.innerHTML = `
    <div class="card" style="display:flex;flex-direction:column;gap:12px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="wfOpenTemplateLibraryBtn" class="btn-ghost" style="font-size:12px;">📚 Job Library</button>
        <button id="wfOpenSkillGuideBtn" class="btn-ghost" style="font-size:12px;">🧩 Skills & Agent Options</button>
        <button id="wfOpenJsonEditorBtn" class="btn-ghost" style="font-size:12px;">{ } Advanced JSON</button>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <div style="flex:1;min-width:260px;">
          <label style="font-size:12px;font-weight:600;">Name</label>
          <input id="wfName" type="text" value="${escHtml(workflow.name || "")}" placeholder="daily-research" style="width:100%;margin-top:4px;padding:8px 10px;" />
        </div>
        <div style="flex:1;min-width:260px;">
          <label style="font-size:12px;font-weight:600;">Description</label>
          <input id="wfDescription" type="text" value="${escHtml(workflow.description || "")}" placeholder="What this workflow does" style="width:100%;margin-top:4px;padding:8px 10px;" />
        </div>
      </div>

      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">
        <div style="min-width:280px;flex:1;">
          <label style="font-size:12px;font-weight:600;">Cron Schedule</label>
          <input id="wfSchedule" type="text" value="${escHtml(workflow.schedule || "")}" placeholder="0 9 * * 1-5" style="width:100%;margin-top:4px;padding:8px 10px;font-family:monospace;" />
          <div style="font-size:11px;color:var(--text-3);margin-top:4px;">Format: minute hour day month weekday</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">${buildCronPresetButtons()}</div>
          <div id="wfScheduleHint" style="font-size:11px;color:var(--text-2);margin-top:6px;">${escHtml(scheduleHint(workflow.schedule))}</div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;padding-bottom:8px;">
          <input id="wfEnabled" type="checkbox" ${workflow.enabled ? "checked" : ""} />
          Enabled
        </label>
      </div>

      <div id="workflowTimezoneLabel" style="font-size:11px;color:var(--text-3);"></div>

      <div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <label style="font-size:12px;font-weight:600;">Stages (wave-like, runs top to bottom)</label>
          <button id="wfAddStageBtn" class="btn-ghost" style="font-size:12px;">+ Add Stage</button>
        </div>
        <div id="wfStagesWrap" style="display:flex;flex-direction:column;gap:8px;">
          ${stages
            .map(
              (s, idx) => `
            <div class="wf-stage-row" data-stage-index="${idx}" style="border:1px solid var(--border);border-radius:8px;padding:10px;background:var(--bg-2);">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">
                <strong style="font-size:12px;">Stage ${idx + 1}</strong>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button class="btn-ghost wf-move-stage-up" data-stage-index="${idx}" style="font-size:11px;padding:4px 8px;">↑</button>
                  <button class="btn-ghost wf-move-stage-down" data-stage-index="${idx}" style="font-size:11px;padding:4px 8px;">↓</button>
                  <button class="btn-ghost wf-duplicate-stage" data-stage-index="${idx}" style="font-size:11px;padding:4px 8px;">Duplicate</button>
                  <button class="btn-red wf-remove-stage" data-stage-index="${idx}" style="font-size:11px;padding:4px 8px;">Remove</button>
                </div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
                <div style="flex:1;min-width:220px;">
                  <label style="font-size:11px;font-weight:600;">Agent</label>
                  <select class="wf-agent" style="width:100%;margin-top:4px;padding:6px 8px;">${buildAgentOptions(s.agent)}</select>
                </div>
                <div style="width:180px;">
                  <label style="font-size:11px;font-weight:600;">Tool hint (optional)</label>
                  <input class="wf-tool" type="text" value="${escHtml(s.tool || "")}" placeholder="write_file" style="width:100%;margin-top:4px;padding:6px 8px;" />
                </div>
              </div>
              <div>
                <label style="font-size:11px;font-weight:600;">Task</label>
                <textarea class="wf-task" rows="3" style="width:100%;margin-top:4px;padding:8px 10px;font-family:monospace;">${escHtml(s.task || "")}</textarea>
              </div>
            </div>
          `,
            )
            .join("")}
        </div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="wfSaveBtn" class="btn">Save Workflow</button>
        <button id="wfRunBtn" class="btn-green">Run Now</button>
        <button id="wfDeleteBtn" class="btn-red">Delete</button>
        <button id="wfNewBtn" class="btn-ghost">New</button>
        <button id="wfRefreshBtn" class="btn-ghost">Refresh</button>
      </div>

      <div>
        <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:4px;">Crontab example</div>
        <code style="display:block;background:var(--bg-2);border:1px solid var(--border);padding:8px 10px;border-radius:6px;overflow:auto;white-space:nowrap;">${cronCmd}</code>
      </div>

      <div id="wfLibraryModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:12000;align-items:center;justify-content:center;padding:18px;">
        <div style="width:min(960px,100%);max-height:85vh;overflow:auto;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
            <div style="font-size:14px;font-weight:700;">Workflow Job Library</div>
            <button id="wfCloseLibraryBtn" class="btn-ghost" style="font-size:12px;">Close</button>
          </div>
          <div style="font-size:12px;color:var(--text-2);margin-bottom:10px;">Pick a starter template, then customize stages/tasks.</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;">${renderTemplateCards()}</div>
          <hr style="border:none;border-top:1px solid var(--border);margin:14px 0;" />
          <div style="font-size:12px;font-weight:700;margin-bottom:6px;">Available Agents</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">${optionsList.agents}</div>
          <div style="font-size:12px;font-weight:700;margin:12px 0 6px;">Available Skills</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px;">${optionsList.skills}</div>
        </div>
      </div>

      <div id="wfJsonModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:12000;align-items:center;justify-content:center;padding:18px;">
        <div style="width:min(920px,100%);max-height:85vh;overflow:auto;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;">
            <div style="font-size:14px;font-weight:700;">Advanced Workflow JSON</div>
            <button id="wfCloseJsonBtn" class="btn-ghost" style="font-size:12px;">Close</button>
          </div>
          <div style="font-size:12px;color:var(--text-2);margin-bottom:8px;">Edit raw JSON. Supports both <code>stages</code> and <code>steps</code>.</div>
          <textarea id="wfJsonTextarea" rows="18" style="width:100%;font-family:monospace;font-size:12px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-2);"></textarea>
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
            <button id="wfApplyJsonBtn" class="btn-green">Apply JSON</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const tzEl = document.getElementById("workflowTimezoneLabel");
  if (tzEl)
    tzEl.textContent = `Local timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;

  wireWorkflowEditorEvents();
}

function collectWorkflowFromForm(options = {}) {
  const { includeIncompleteStages = false } = options;
  const name = (document.getElementById("wfName")?.value || "").trim();
  const description = (
    document.getElementById("wfDescription")?.value || ""
  ).trim();
  const schedule = (document.getElementById("wfSchedule")?.value || "").trim();
  const enabled = !!document.getElementById("wfEnabled")?.checked;
  const rows = Array.from(document.querySelectorAll(".wf-stage-row"));
  const stages = rows
    .map((row) => {
      const agent = row.querySelector(".wf-agent")?.value?.trim() || "";
      const tool = row.querySelector(".wf-tool")?.value?.trim() || "";
      const task = row.querySelector(".wf-task")?.value?.trim() || "";
      return { agent, task, ...(tool ? { tool } : {}) };
    })
    .filter((s) => includeIncompleteStages || (s.agent && s.task));
  const existingSteps = Array.isArray(wfState.editorWorkflow?.steps)
    ? wfState.editorWorkflow.steps
    : [];
  return {
    name,
    workflow: {
      description,
      enabled,
      schedule,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      stages,
      ...(existingSteps.length ? { steps: existingSteps } : {}),
    },
  };
}

function wireWorkflowEditorEvents() {
  document
    .getElementById("wfOpenTemplateLibraryBtn")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      const modal = document.getElementById("wfLibraryModal");
      if (modal) modal.style.display = "flex";
    });
  document
    .getElementById("wfOpenSkillGuideBtn")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      const modal = document.getElementById("wfLibraryModal");
      if (modal) modal.style.display = "flex";
    });
  document
    .getElementById("wfCloseLibraryBtn")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      const modal = document.getElementById("wfLibraryModal");
      if (modal) modal.style.display = "none";
    });
  document.getElementById("wfLibraryModal")?.addEventListener("click", (e) => {
    if (e.target?.id === "wfLibraryModal") {
      e.currentTarget.style.display = "none";
    }
  });
  document
    .getElementById("wfOpenJsonEditorBtn")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      const current = collectWorkflowFromForm();
      const raw = {
        ...current.workflow,
        ...(wfState.editorWorkflow?.steps
          ? { steps: wfState.editorWorkflow.steps }
          : {}),
      };
      const ta = document.getElementById("wfJsonTextarea");
      if (ta) ta.value = JSON.stringify(raw, null, 2);
      const modal = document.getElementById("wfJsonModal");
      if (modal) modal.style.display = "flex";
    });
  document.getElementById("wfCloseJsonBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    const modal = document.getElementById("wfJsonModal");
    if (modal) modal.style.display = "none";
  });
  document.getElementById("wfJsonModal")?.addEventListener("click", (e) => {
    if (e.target?.id === "wfJsonModal") {
      e.currentTarget.style.display = "none";
    }
  });
  document.getElementById("wfApplyJsonBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    try {
      const ta = document.getElementById("wfJsonTextarea");
      const parsed = JSON.parse(ta?.value || "{}");
      const current = collectWorkflowFromForm();
      const next = {
        name: current.name,
        description: parsed.description || current.workflow.description,
        enabled: parsed.enabled ?? current.workflow.enabled,
        schedule: parsed.schedule || current.workflow.schedule,
        timezone:
          parsed.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        stages:
          Array.isArray(parsed.stages) && parsed.stages.length
            ? parsed.stages
            : current.workflow.stages,
        ...(Array.isArray(parsed.steps) ? { steps: parsed.steps } : {}),
      };
      renderWorkflowEditor(next);
      const modal = document.getElementById("wfJsonModal");
      if (modal) modal.style.display = "none";
      showNotification("Applied advanced JSON", "success");
    } catch (err) {
      showNotification(`Invalid JSON: ${err.message}`, "error");
    }
  });

  document.querySelectorAll(".wf-apply-template").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const templateId = btn.dataset.templateId || "";
      const template = WORKFLOW_TEMPLATES.find((t) => t.id === templateId);
      if (!template) return;
      const current = collectWorkflowFromForm();
      const next = {
        name: current.name || template.id,
        description: template.description,
        enabled: current.workflow.enabled,
        schedule: template.schedule,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        stages: template.stages.map((s) => ({ ...s, tool: s.tool || "" })),
      };
      renderWorkflowEditor(next);
      const modal = document.getElementById("wfLibraryModal");
      if (modal) modal.style.display = "none";
      showNotification(`Applied template: ${template.name}`, "success");
    });
  });

  document.querySelectorAll(".wf-cron-preset").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const cron = btn.dataset.cron || "";
      const input = document.getElementById("wfSchedule");
      const hint = document.getElementById("wfScheduleHint");
      if (input) input.value = cron;
      if (hint) hint.textContent = scheduleHint(cron);
    });
  });
  document.getElementById("wfSchedule")?.addEventListener("input", (e) => {
    const hint = document.getElementById("wfScheduleHint");
    if (hint) hint.textContent = scheduleHint(e.target.value);
  });

  document.getElementById("wfAddStageBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    const current = collectWorkflowFromForm({ includeIncompleteStages: true });
    current.workflow.stages.push({ agent: "crew-main", task: "", tool: "" });
    renderWorkflowEditor({ name: current.name, ...current.workflow });
  });

  document.querySelectorAll(".wf-remove-stage").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const idx = Number(btn.dataset.stageIndex || "-1");
      const current = collectWorkflowFromForm({ includeIncompleteStages: true });
      current.workflow.stages = current.workflow.stages.filter(
        (_, i) => i !== idx,
      );
      if (!current.workflow.stages.length) {
        current.workflow.stages = [{ agent: "crew-main", task: "", tool: "" }];
      }
      renderWorkflowEditor({ name: current.name, ...current.workflow });
    });
  });

  document.querySelectorAll(".wf-move-stage-up").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const idx = Number(btn.dataset.stageIndex || "-1");
      if (idx <= 0) return;
      const current = collectWorkflowFromForm({ includeIncompleteStages: true });
      const [stage] = current.workflow.stages.splice(idx, 1);
      current.workflow.stages.splice(idx - 1, 0, stage);
      renderWorkflowEditor({ name: current.name, ...current.workflow });
    });
  });

  document.querySelectorAll(".wf-move-stage-down").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const idx = Number(btn.dataset.stageIndex || "-1");
      const current = collectWorkflowFromForm({ includeIncompleteStages: true });
      if (idx < 0 || idx >= current.workflow.stages.length - 1) return;
      const [stage] = current.workflow.stages.splice(idx, 1);
      current.workflow.stages.splice(idx + 1, 0, stage);
      renderWorkflowEditor({ name: current.name, ...current.workflow });
    });
  });

  document.querySelectorAll(".wf-duplicate-stage").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const idx = Number(btn.dataset.stageIndex || "-1");
      const current = collectWorkflowFromForm({ includeIncompleteStages: true });
      if (idx < 0 || idx >= current.workflow.stages.length) return;
      const source = current.workflow.stages[idx];
      current.workflow.stages.splice(idx + 1, 0, { ...source });
      renderWorkflowEditor({ name: current.name, ...current.workflow });
    });
  });

  document
    .getElementById("wfSaveBtn")
    ?.addEventListener("click", saveWorkflowFromForm);
  document
    .getElementById("wfRunBtn")
    ?.addEventListener("click", runWorkflowFromForm);
  document
    .getElementById("wfDeleteBtn")
    ?.addEventListener("click", deleteWorkflowFromForm);
  document.getElementById("wfNewBtn")?.addEventListener("click", () => {
    wfState.selectedName = "";
    renderWorkflowEditor(emptyWorkflow());
    const logEl = document.getElementById("workflowLog");
    if (logEl) logEl.textContent = "";
  });
  document
    .getElementById("wfRefreshBtn")
    ?.addEventListener("click", async () => {
      await loadWorkflowList();
    });
}

async function saveWorkflowFromForm() {
  const payload = collectWorkflowFromForm();
  if (!payload.name) {
    showNotification("Workflow name is required", "error");
    return;
  }
  if (!payload.workflow.stages.length) {
    showNotification("Add at least one stage", "error");
    return;
  }
  try {
    await postJSON("/api/workflows/save", payload);
    wfState.selectedName = payload.name;
    showNotification(`Saved workflow: ${payload.name}`, "success");
    await loadWorkflowList();
    await loadWorkflowItem(payload.name);
  } catch (e) {
    showNotification(`Save failed: ${e.message}`, "error");
  }
}

async function runWorkflowFromForm() {
  const payload = collectWorkflowFromForm();
  if (!payload.name) {
    showNotification("Save workflow first (name required)", "warning");
    return;
  }
  try {
    const data = await postJSON("/api/workflows/run", { name: payload.name });
    showNotification(
      `Started ${payload.name}${data.pid ? ` (pid ${data.pid})` : ""}`,
      "success",
    );
    await loadWorkflowItem(payload.name);
  } catch (e) {
    showNotification(`Run failed: ${e.message}`, "error");
  }
}

async function deleteWorkflowFromForm() {
  const payload = collectWorkflowFromForm();
  if (!payload.name) {
    showNotification("No workflow selected", "warning");
    return;
  }
  if (!confirm(`Delete workflow "${payload.name}"?`)) return;
  try {
    await postJSON("/api/workflows/delete", { name: payload.name });
    showNotification(`Deleted ${payload.name}`, "success");
    wfState.selectedName = "";
    await loadWorkflowList();
    renderWorkflowEditor(emptyWorkflow());
    const logEl = document.getElementById("workflowLog");
    if (logEl) logEl.textContent = "";
  } catch (e) {
    showNotification(`Delete failed: ${e.message}`, "error");
  }
}

async function loadWorkflowLog(name) {
  const logEl = document.getElementById("workflowLog");
  if (!logEl || !name) return;
  try {
    const data = await getJSON(
      `/api/workflows/log?name=${encodeURIComponent(name)}&limit=120`,
    );
    const lines = data.lines || [];
    logEl.textContent = lines.length ? lines.join("\n") : "No log lines yet.";
    logEl.scrollTop = logEl.scrollHeight;
  } catch (e) {
    logEl.textContent = `Failed to load log: ${e.message}`;
  }
}
