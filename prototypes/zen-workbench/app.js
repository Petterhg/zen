const $ = (id) => document.getElementById(id);
const icons = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  panel:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  folder: '<path d="M3 7V5h6l2 2h10v13H3Z"/>',
  terminal: '<path d="m4 6 5 5-5 5m8 1h7"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  spark:
    '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  branch:
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m0-5h5a7 7 0 0 0 7-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  history: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6m3-3v6l4 2"/>',
  focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
for (const el of document.querySelectorAll("[data-icon]"))
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[el.dataset.icon]}</svg>`;
const originalCode = `import { sleep } from './clock';
import type { RetryOptions } from './types';

/**
 * A retry belongs to the request that started it.
 * Keep the deadline close, and leave quietly on cancel.
 */
export async function retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { attempts = 3, signal } = options;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === attempts - 1) throw error;

      const delay = Math.min(200 * 2 ** attempt, 2_000);
      await sleep(delay, signal);
    }
  }

  throw new Error('Retry limit reached');
}
`;
const files = {
  "retry.ts": originalCode,
  "clock.ts": `/** The timer follows the caller's cancellation signal. */
export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
`,
  "types.ts": `export interface RetryOptions {
  /** Maximum attempts before returning the last failure. */
  attempts?: number;

  /** Abort the operation when the original request ends. */
  signal?: AbortSignal;
}
`,
};
const tasks = [
  {
    id: "ZEN-142",
    title: "Keep retries within the request deadline",
    project: "Gateway reliability",
    branch: "zen/142-request-deadline",
    intent:
      "A cancelled request should stop quietly. No extra retries, no work left running in the background.",
    resume:
      "We traced cancellation through the timer. Next: check the signal before starting another attempt.",
    note: "Cancellation should preserve the original error. Avoid wrapping it in a generic retry failure.",
  },
  {
    id: "ZEN-148",
    title: "Make service health easier to verify",
    project: "Gateway reliability",
    branch: "zen/148-service-health",
    intent:
      "Give deployments a small, trustworthy health check that verifies the service is ready for traffic.",
    resume:
      "Start by agreeing what readiness means. Keep liveness separate from external dependencies.",
    note: "A process being alive does not prove that its dependencies are ready.",
  },
  {
    id: "ZEN-156",
    title: "Explain a failed deployment in one place",
    project: "Developer experience",
    branch: "zen/156-deploy-evidence",
    intent:
      "Bring the failed check, relevant logs and deployment revision together without creating another dashboard.",
    resume:
      "Link every result to the commit and environment it actually tested.",
    note: "Unknown is a valid result. Never turn a missing check into a green status.",
  },
];
const key = "zen-workbench-demo-v1";
let state = {
  active: tasks[0].id,
  board: true,
  terminal: true,
  files: true,
  theme: "dark",
  assistance: 25,
  tasks: {},
};
try {
  const saved = JSON.parse(localStorage.getItem(key));
  if (
    saved &&
    tasks.some((t) => t.id === saved.active) &&
    typeof saved.tasks === "object"
  )
    state = { ...state, ...saved };
} catch {
  /* The demo works without browser storage. */
}
let boardTab = "task",
  voice = false,
  peer = false,
  following = false,
  focus = false,
  proposal = null,
  guest = false,
  toastTimer;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function task() {
  return tasks.find((t) => t.id === state.active);
}
function record() {
  if (!state.tasks[state.active])
    state.tasks[state.active] = {
      file: "retry.ts",
      buffers: { ...files },
      stage: 0,
      notes: [],
      sessions: [],
      tests: false,
      fixed: false,
      updated: null,
      driver: "You",
    };
  return state.tasks[state.active];
}
function save() {
  try {
    localStorage.setItem(key, JSON.stringify(state));
    $("bufferStatus").textContent = "Saved in this browser";
  } catch {
    $("bufferStatus").textContent =
      "Storage unavailable · changes last only while open";
    $("storageStatus").textContent = "Local demo · persistence unavailable";
  }
}
function notify(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 3800);
}
function highlight(s) {
  const parts =
    s.match(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b(?:export|async|function|const|let|for|try|catch|if|return|await|throw|new|import|from|type|interface)\b|\b\d[\d_]*\b|[\s\S]/g,
    ) || [];
  return parts
    .map((v) => {
      let cls =
        v.startsWith("//") || v.startsWith("/*")
          ? "comment"
          : /^["']/.test(v)
            ? "str"
            : /^[a-z]{2,}$/.test(v)
              ? "kw"
              : /^\d/.test(v)
                ? "num"
                : "";
      return cls ? `<span class="${cls}">${esc(v)}</span>` : esc(v);
    })
    .join("");
}
function renderCode() {
  const r = record();
  $("code").value = r.buffers[r.file];
  paintCode();
  $("crumbFile").textContent = r.file;
  $("fileList").innerHTML = Object.keys(files)
    .map(
      (f) =>
        `<button class="file-row ${r.file === f ? "active" : ""}" data-file="${f}"><span class="file-icon">TS</span>${f}</button>`,
    )
    .join("");
  $("tabs").innerHTML = Object.keys(files)
    .map(
      (f) =>
        `<button role="tab" aria-selected="${r.file === f}" class="${r.file === f ? "active" : ""}" data-file="${f}"><span class="file-icon">TS</span>${f}${r.buffers[f] !== files[f] ? '<span class="tab-dot" aria-label="Changed"></span>' : ""}</button>`,
    )
    .join("");
  for (const el of document.querySelectorAll("[data-file]"))
    el.onclick = () => {
      r.file = el.dataset.file;
      renderCode();
      save();
    };
  $("proposal").hidden = !proposal || r.file !== "retry.ts";
  $("changedStatus").textContent =
    Object.keys(files).filter((f) => r.buffers[f] !== files[f]).length +
    " changed files · local draft";
}
function paintCode() {
  const s = $("code").value;
  $("highlight").innerHTML = highlight(s) + "\n";
  $("lineNumbers").textContent = s
    .split("\n")
    .map((_, i) => i + 1)
    .join("\n");
  $("code").style.height = $("highlight").scrollHeight + "px";
}
function layout() {
  $("workboard").hidden = !state.board;
  $("files").hidden = !state.files;
  $("terminal").hidden = !state.terminal;
  $("showFiles").hidden = state.files && !focus;
  $("toggleBoard").setAttribute("aria-expanded", String(state.board && !focus));
  $("app").classList.toggle("focus-mode", focus);
  document.body.classList.toggle("light", state.theme === "light");
  $("focus").setAttribute("aria-pressed", String(focus));
}
function render() {
  const t = task(),
    r = record();
  $("taskTitle").textContent = t.title;
  $("taskPicker").innerHTML = `${t.id} <span>⌄</span>`;
  $("taskSubtitle").textContent =
    t.project + " · One task, from intent to verified change.";
  $("branchName").textContent = t.branch;
  $("stageLabel").textContent = [
    "In progress",
    "In review",
    "Ready to merge",
    "Delivery",
    "Verify",
    "Complete",
  ][r.stage];
  $("peerAvatar").hidden = !peer;
  $("collabCursor").hidden = !following;
  $("voiceLabel").textContent = voice ? "Pause & save" : "Resume pairing";
  $("wave").hidden = !voice;
  $("voiceCaption").textContent = voice
    ? "Demo voice session · microphone off"
    : "Your place is saved with this task.";
  $("voiceSettings").innerHTML =
    (state.assistance === 0
      ? "Voice only"
      : state.assistance < 50
        ? "Guide me"
        : "Draft with me") + " <span>⌄</span>";
  $("suggest").disabled = guest || state.assistance === 0;
  for (const id of ["voice", "voiceSettings", "runTests", "terminalCommand"])
    $(id).disabled = guest;
  $("acceptEdit").disabled =
    guest || Boolean(proposal && proposal.before !== r.buffers["retry.ts"]);
  $("rejectEdit").disabled = guest;
  if (guest)
    $("voiceCaption").textContent = "Guest view · host owns the assistant";
  layout();
  renderCode();
  renderBoard();
}
function renderBoard() {
  const t = task(),
    r = record();
  for (const b of document.querySelectorAll("[data-board]"))
    b.setAttribute("aria-selected", String(b.dataset.board === boardTab));
  if (boardTab === "task")
    $("boardContent").innerHTML = `
    <section class="board-block"><span class="eyebrow">THE INTENT</span><h3>${esc(t.intent)}</h3><ul class="checklist"><li><span class="check">✓</span> Understand the request lifecycle</li><li><span class="${r.fixed ? "check" : "pending"}">${r.fixed ? "✓" : ""}</span> ${t.id === "ZEN-142" ? "Stop before the next retry" : "Agree on the smallest useful change"}</li><li><span class="${r.tests ? "check" : "pending"}">${r.tests ? "✓" : ""}</span> Verify the behavior together</li></ul></section>
    <section class="board-block"><span class="eyebrow">WHERE WE LEFT OFF</span><div class="note">${esc(r.fixed ? "The proposal is accepted in this local draft. Next: verify the behavior before preparing a PR." : t.resume)}<small>Task context · ${t.id}</small></div></section>
    <section class="board-block"><span class="eyebrow">PAIRING SESSION</span><div class="session-card"><h3><span class="tiny-dot ${voice ? "" : "hollow"}"></span>${voice ? "Thinking together" : "Ready when you are"}</h3><p>Your decisions, notes and draft stay attached to this task when you leave.</p><div class="session-actions"><button class="primary" id="resumeSession">${voice ? "Pause & save" : "Resume session"}</button><span class="subtle">${r.sessions.length} saved moments</span></div></div></section>
    <section class="board-block"><span class="eyebrow">WORKING AGREEMENT</span><p class="body-copy">${state.assistance === 0 ? "Explain only. I write the code." : "One small step. Let me understand it before we move on."}</p><button class="text-button" id="sessionNotes">Open session notes <span>↗</span></button></section>`;
  if (boardTab === "delivery") {
    const stages = [
      ["Code", "Working draft in this task"],
      ["Review", "Your reviewer · rules + conventions"],
      ["Merge", "Review acknowledged; merge is a separate action"],
      ["Deliver", "Delivery agent · CI + deployed revision"],
      ["Verify", "SRE evidence + integration checks"],
      ["Next task", "Verified outcome, saved context"],
    ];
    const labels = [
      "Prepare demo PR",
      r.fixed ? "Acknowledge demo review" : "Apply review suggestion",
      "Simulate approved merge",
      "Track with delivery agent",
      "Run demo integration checks",
      "Choose next task",
    ];
    $("boardContent").innerHTML =
      `<section class="board-block"><span class="eyebrow">FROM INTENT TO VERIFIED</span><p class="body-copy">One thread through the whole change. Every result belongs to a revision.</p><div class="pipeline">${stages.map((v, i) => `<div class="stage ${i === r.stage ? "active" : i < r.stage ? "done" : ""}"><span class="stage-dot">${i < r.stage ? "✓" : i + 1}</span><div>${v[0]}<p>${v[1]}</p></div></div>`).join("")}</div><div class="note">${["Start with a small, reviewable change. Checks and review stay attached to this task.", "Zen reviewer · demo finding: cancellation needs to be checked before the next attempt.", "Demo review resolved. Merge still requires an explicit human action.", "Demo commit a41f29c · staging. A passing build alone does not establish deployment health.", "Demo staging revision a41f29c. Verify both environment and application behavior.", "Demo checks passed for a41f29c. Save the outcome and choose the next task."][r.stage]}</div><button class="primary stage-action" id="nextStage">${labels[r.stage]}</button>${r.stage === 4 ? '<button class="text-button" id="failCheck">Simulate a failed integration check</button>' : ""}<p class="modal-note">Simulation only. No PR, merge, deployment or cloud test is performed.</p></section>`;
  }
  if ($("resumeSession")) $("resumeSession").onclick = toggleVoice;
  if ($("sessionNotes")) $("sessionNotes").onclick = history;
  if ($("nextStage")) $("nextStage").onclick = advance;
  if ($("failCheck"))
    $("failCheck").onclick = () => {
      log("✕ fixture integration check failed · staging a41f29c");
      notify(
        "Demo check failed. Task stays in Verify; no next-issue transition.",
      );
    };
  for (const id of ["resumeSession", "nextStage", "failCheck"]) {
    if ($(id)) $(id).disabled = guest;
  }
}
function toggleVoice() {
  if (!hostAction()) return;
  voice = !voice;
  const r = record();
  if (!voice) {
    r.sessions.push({
      time: new Date().toISOString(),
      summary: r.fixed
        ? "Accepted a local cancellation guard; verification remains."
        : task().resume,
    });
    r.updated = new Date().toISOString();
    save();
  }
  render();
  notify(
    voice
      ? "Demo session resumed. Your microphone is off."
      : "Session context saved to this task.",
  );
}
function log(text) {
  const d = document.createElement("div");
  d.textContent = text;
  $("terminalOutput").append(d);
  $("terminalOutput").scrollTop = $("terminalOutput").scrollHeight;
}
function runChecks() {
  if (!hostAction()) return;
  record().tests = true;
  state.terminal = true;
  layout();
  log("❯ npm test -- retry");
  log("✓ fixture: 3 tests passed · simulated, code was not executed");
  save();
  renderBoard();
  notify("Demo test result recorded. No code or shell command was executed.");
}
function propose() {
  if (!hostAction()) return;
  if (state.assistance === 0) {
    notify("Voice-only mode: explain without writing code.");
    return;
  }
  const r = record();
  $("acceptEdit").disabled = false;
  $("proposalNote").textContent =
    "One-line proposal · applied only to the unchanged source";
  r.file = "retry.ts";
  if (r.buffers["retry.ts"].includes("    signal?.throwIfAborted();")) {
    notify("The example guard is already present.");
    return;
  }
  proposal = { task: task().id, before: r.buffers["retry.ts"] };
  renderCode();
  $("proposal").scrollIntoView({ block: "nearest" });
}
function accept() {
  if (!hostAction()) return;
  const r = record();
  if (!proposal) return;
  if (
    proposal.task !== task().id ||
    proposal.before !== r.buffers["retry.ts"]
  ) {
    proposal = null;
    renderCode();
    notify("Source changed. The stale proposal was discarded.");
    return;
  }
  const target = "  for (let attempt = 0; attempt < attempts; attempt++) {\n";
  if (!proposal.before.includes(target)) {
    proposal = null;
    renderCode();
    notify("Could not find the proposal anchor. No changes applied.");
    return;
  }
  r.buffers["retry.ts"] = proposal.before.replace(
    target,
    target + "    signal?.throwIfAborted();\n",
  );
  r.fixed = true;
  r.tests = false;
  invalidateAgentEvidence();
  proposal = null;
  save();
  render();
  notify("Accepted into the local draft. Verify before moving on.");
}
function advance() {
  if (!hostAction()) return;
  const r = record();
  if (r.stage === 5) {
    board();
    return;
  }
  if (r.stage === 1 && !r.fixed) {
    propose();
    notify(
      "Review suggestion opened in the editor. Accept it, then acknowledge review.",
    );
    return;
  }
  if (r.stage === 1 && r.fixed) {
    r.stage = 2;
  } else if (r.stage === 2) {
    openModal(
      "HUMAN HANDOFF",
      "Merge this demo change?",
      `<p class="body-copy">This simulates approval for ${task().id} at revision a41f29c. Real GitHub rules and review requirements would still apply.</p><button class="primary stage-action" id="confirmMerge">Simulate merge · no GitHub write</button>`,
    );
    $("confirmMerge").onclick = () => {
      if (!hostAction()) return;
      r.stage = 3;
      save();
      $("modal").close();
      render();
    };
    return;
  } else r.stage++;
  save();
  render();
}
function openModal(eyebrow, title, body) {
  $("modalEyebrow").textContent = eyebrow;
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = body;
  $("modal").showModal();
}
function selectTask(id) {
  if (!hostAction()) return;
  if (voice) toggleVoice();
  state.active = id;
  record();
  proposal = null;
  boardTab = "task";
  save();
  $("modal").close();
  render();
  $("terminalOutput").textContent = "Task workspace restored · demo terminal";
  notify("Restored " + id + " with its own draft, notes and session.");
}
function board() {
  openModal(
    "PROJECT · PLATFORM",
    "One thing at a time.",
    `<div class="task-board">${tasks.map((t) => `<button class="task-option ${t.id === state.active ? "selected" : ""}" data-task="${t.id}"><span>${t.id} · ${t.id === state.active ? "CURRENT TASK" : state.tasks[t.id] ? "SAVED WORKSPACE" : "UP NEXT"}</span><strong>${t.title}</strong><p>${t.project}</p></button>`).join("")}</div><p class="modal-note">Example Linear board. Switching tasks saves this workspace and restores the selected task’s draft and context.</p>`,
  );
  for (const el of document.querySelectorAll("[data-task]"))
    el.onclick = () => selectTask(el.dataset.task);
}
function history() {
  const r = record();
  openModal(
    "PERSISTENT TASK SESSION",
    task().id + " · our place in the work",
    `<p class="body-copy">${esc(task().resume)}</p><div class="modal-row"><div>Session scope<p>studio / gateway / ${task().id}</p></div><span class="subtle">LOCAL DEMO</span></div>${r.sessions.map((s) => `<div class="memory-item"><strong>${esc(new Date(s.time).toLocaleString())}</strong>${esc(s.summary)}</div>`).join("") || '<p class="modal-note">Pause a demo pairing session to save a moment here. Reloading the page preserves task notes and drafts; it never starts a microphone.</p>'}<p class="modal-note">A production session would retain approved decisions and a resumable summary. Raw audio recording is a separate, explicit choice.</p>`,
  );
}
function hostAction() {
  if (!guest) return true;
  notify(
    "The task host owns assistant controls. You can still edit shared code.",
  );
  return false;
}
function collaboration() {
  openModal(
    "SHARED TASK · DEMO",
    "Both can edit. One assistant.",
    `<p class="body-copy">One shared task workspace. Each person keeps their own cursor, tabs and appearance. You invited Mira, so the assistant remains yours.</p>
    <div class="modal-row"><div>You · task host<p>Can edit · assistant on/off, settings and specialists</p></div><span class="avatar">P</span></div>
    <div class="modal-row"><div>Mira · collaborator<p>${peer ? "Can edit shared files · can speak to the same assistant" : "Not connected"}</p></div><button id="joinPeer" class="primary" ${guest ? "disabled" : ""}>${peer ? "Remove demo peer" : "Simulate joining"}</button></div>
    ${peer ? `<div class="modal-row"><button id="followPeer" class="text-button">${following ? "Stop following" : "Follow Mira in editor"}</button><button id="peerEdit" class="text-button">Simulate Mira editing</button></div>` : ""}
    <div class="modal-row"><div>One assistant · host-owned<p>Inviting or following never starts a second assistant.</p></div><button id="previewGuest" class="primary">${guest ? "Return to host view" : "Preview guest view"}</button></div>
    <p class="modal-note">Shared editing and presence are simulated in this browser. Guest view disables assistant controls, not typing. Host memory stays private and is never copied into the room. In production, losing the host pauses the assistant; ownership never transfers automatically.</p>`,
  );
  $("joinPeer").onclick = () => {
    if (!hostAction()) return;
    peer = !peer;
    following = false;
    render();
    $("modal").close();
    collaboration();
  };
  $("previewGuest").onclick = () => {
    guest = !guest;
    peer = true;
    following = false;
    render();
    $("modal").close();
    notify(
      guest
        ? "Guest preview: edit freely; assistant controls belong to the host."
        : "Host view restored. Assistant ownership never changed.",
    );
  };
  if ($("followPeer"))
    $("followPeer").onclick = () => {
      following = !following;
      render();
      $("modal").close();
    };
  if ($("peerEdit"))
    $("peerEdit").onclick = () => {
      record().buffers["retry.ts"] +=
        "// Mira: also verify cancellation before the first attempt.\n";
      draftChanged();
      save();
      render();
      $("modal").close();
      notify(
        "Simulated collaborator edit. Earlier proposals and review evidence need revalidation.",
      );
    };
}
const specialists = {
  reviewer: {
    name: "Reviewer",
    purpose:
      "Run on command. Review the current change against your rules and conventions.",
    tools: "Diff · scoped code search · references · approved checks",
    rules:
      "Prioritize concrete regressions. Cite file, line and trigger. Read project conventions. Report coverage and uncertainty; never claim unrun tests passed.",
  },
  delivery: {
    name: "Delivery",
    purpose:
      "Merge an approved revision, then follow its CI and deployment to the target environment.",
    tools: "PR checks · approved merge · Actions · deployment status",
    rules:
      "Bind approvals to the exact revision. Respect repository rules. Track the deployed artifact. Stop and report failures; never treat merge as deployment success.",
  },
  sre: {
    name: "SRE",
    purpose:
      "Watch an environment over time. Bring back actionable errors, not a stream of progress.",
    tools: "Cloud logs · Sentry · deployment markers · integration results",
    rules:
      "Read only by default. Group duplicates, correlate with releases and cite evidence. Escalate new or worsening incidents. Never restart or roll back without authorization.",
  },
};
function agentState() {
  return (record().agentRuns ||= {});
}
function agents() {
  openModal(
    "HOST'S SPECIALISTS · DEMO",
    "One pair. Focused help.",
    `<p class="body-copy">These workers report to the same assistant. They do not open another voice session. The host defines their rules and tool access.</p>
    ${Object.entries(specialists)
      .map(
        ([id, a]) =>
          `<section class="agent-card"><div class="agent-title"><h3>${a.name}</h3><span class="subtle">${id === "sre" ? "BACKGROUND" : "ON COMMAND"}</span></div><p class="body-copy">${a.purpose}</p><p class="agent-result" data-result="${id}">${esc(agentState()[id] || "No demo run yet.")}</p><div class="agent-actions"><button class="primary" data-run="${id}" ${guest ? "disabled" : ""}>${id === "sre" ? (record().watching ? "Stop demo watch" : "Start demo watch") : "Run demo"}</button><button class="text-button" data-configure="${id}" ${guest ? "disabled" : ""}>Rules & tools</button>${id === "sre" && record().watching ? '<button class="text-button" id="injectIncident" ' + (guest ? "disabled" : "") + ">Simulate error</button>" : ""}</div></section>`,
      )
      .join("")}
    <p class="modal-note">Local UI fixtures only. Rules are saved in this browser; no model, GitHub, cloud logs or Sentry connection runs. Background monitoring in production requires the host computer to remain awake, or a separately authorized worker.</p>`,
  );
  for (const b of document.querySelectorAll("[data-run]"))
    b.onclick = () => {
      if (!hostAction()) return;
      const id = b.dataset.run;
      if (id === "reviewer")
        agentState().reviewer = record().fixed
          ? "Demo review: guard present. Tests and wider caller impact remain unchecked."
          : "Demo finding: check cancellation before starting the next attempt. retry.ts:14";
      if (id === "delivery") {
        agentState().delivery =
          "Demo tracking: awaiting an approved revision. No merge or deployment performed.";
        boardTab = "delivery";
        state.board = true;
      }
      if (id === "sre") {
        record().watching = !record().watching;
        agentState().sre = record().watching
          ? "Demo watch started · no live source connected."
          : "Demo watch stopped.";
      }
      save();
      render();
      $("modal").close();
      agents();
    };
  for (const b of document.querySelectorAll("[data-configure]"))
    b.onclick = () => configureAgent(b.dataset.configure);
  if ($("injectIncident"))
    $("injectIncident").onclick = () => {
      if (!hostAction()) return;
      agentState().sre =
        "Fixture incident: gateway 5xx increased after a41f29c in staging. Check logs and the retry change; causality is unverified.";
      save();
      $("modal").close();
      agents();
    };
}
function configureAgent(id) {
  if (!hostAction()) return;
  const a = specialists[id];
  $("modal").close();
  openModal(
    "SPECIALIST DEFINITION · LOCAL DEMO",
    a.name,
    `<label class="body-copy" for="agentRules">Rules and conventions</label><textarea id="agentRules" class="agent-rules" maxlength="3000">${esc(state.agentRules?.[id] || a.rules)}</textarea><p class="modal-note">Tool profile: ${a.tools}. A prompt cannot grant tool permissions; the host enforces the profile.</p><button class="primary" id="saveAgentRules">Save definition</button>`,
  );
  $("saveAgentRules").onclick = () => {
    if (!hostAction()) return;
    state.agentRules ||= {};
    state.agentRules[id] = $("agentRules").value.trim() || a.rules;
    save();
    $("modal").close();
    agents();
  };
}
function commands() {
  openModal(
    "COMMANDS",
    "A quieter way around.",
    `<div class="command-list"><button data-command="task">Choose a task <kbd>⌘K</kbd></button><button data-command="focus">Toggle focus mode <kbd>⌘⇧F</kbd></button><button data-command="board">Toggle workboard <kbd>⌘J</kbd></button><button data-command="terminal">Toggle terminal</button><button data-command="files">Toggle file tree</button><button data-command="history">Task session history</button><button data-command="agents">Specialist agents</button><button data-command="theme">Switch appearance</button></div>`,
  );
  for (const b of document.querySelectorAll("[data-command]"))
    b.onclick = () => {
      $("modal").close();
      ({
        task: board,
        focus: toggleFocus,
        board: toggleBoard,
        terminal: toggleTerminal,
        files: () => {
          state.files = !state.files;
          layout();
          save();
        },
        history,
        agents,
        theme: toggleTheme,
      })[b.dataset.command]();
    };
}
function toggleFocus() {
  focus = !focus;
  layout();
  notify(
    focus
      ? "Focus mode. Your task and voice controls stay with you."
      : "Workspace restored.",
  );
}
function toggleBoard() {
  focus = false;
  state.board = !state.board;
  layout();
  save();
}
function toggleTerminal() {
  focus = false;
  state.terminal = !state.terminal;
  layout();
  save();
}
function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  layout();
  save();
}
function invalidateAgentEvidence() {
  if (agentState().reviewer)
    agentState().reviewer = "Draft changed · run a new review.";
  if (agentState().delivery)
    agentState().delivery =
      "Draft changed · earlier approval cannot authorize this revision.";
}
function draftChanged() {
  record().tests = false;
  record().fixed = record().buffers["retry.ts"].includes(
    "    signal?.throwIfAborted();",
  );
  // Editing a verified draft invalidates that draft's demo delivery evidence.
  record().stage = 0;
  $("stageLabel").textContent = "In progress";
  invalidateAgentEvidence();
  renderBoard();
  following = false;
  $("collabCursor").hidden = true;
  save();
  $("changedStatus").textContent = "Local draft changed";
  if (proposal && record().file === "retry.ts") {
    $("acceptEdit").disabled = true;
    $("proposalNote").textContent =
      "Source changed · discard this stale proposal and request a new one.";
  }
}
$("code").addEventListener("input", () => {
  record().buffers[record().file] = $("code").value;
  draftChanged();
  paintCode();
});
$("openAgents").onclick = agents;
$("home").onclick = $("projectBoard").onclick = $("taskPicker").onclick = board;
$("voice").onclick = toggleVoice;
$("sessionHistory").onclick = history;
$("collaborate").onclick = collaboration;
$("focus").onclick = toggleFocus;
$("commands").onclick = commands;
$("toggleBoard").onclick = $("hideBoard").onclick = toggleBoard;
$("toggleTerminal").onclick = $("hideTerminal").onclick = toggleTerminal;
$("hideFiles").onclick = () => {
  state.files = false;
  layout();
  save();
};
$("showFiles").onclick = () => {
  focus = false;
  state.files = true;
  layout();
  save();
};
$("themeToggle").onclick = toggleTheme;
$("branchButton").onclick = () => {
  boardTab = "delivery";
  state.board = true;
  focus = false;
  render();
};
$("suggest").onclick = () => {
  $("acceptEdit").disabled = false;
  propose();
};
$("acceptEdit").onclick = accept;
$("rejectEdit").onclick = () => {
  if (!hostAction()) return;
  proposal = null;
  renderCode();
};
$("runTests").onclick = runChecks;
$("terminalTab").onclick = () => $("terminalCommand").focus();
$("terminalForm").onsubmit = (e) => {
  e.preventDefault();
  if (!hostAction()) return;
  const input = $("terminalCommand"),
    cmd = input.value.trim();
  input.value = "";
  if (!cmd) return;
  if (cmd === "clear") {
    $("terminalOutput").textContent = "";
    return;
  }
  if (cmd.startsWith("npm test")) runChecks();
  else if (cmd === "git status") {
    log("❯ git status");
    log("Demo branch " + task().branch + " · local browser draft only");
  } else {
    log("❯ " + cmd);
    log(
      "Demo shell: try npm test, git status, or clear. Nothing was executed.",
    );
  }
};
for (const b of document.querySelectorAll("[data-board]"))
  b.onclick = () => {
    boardTab = b.dataset.board;
    renderBoard();
  };
$("voiceSettings").onclick = () => {
  if (!hostAction()) return;
  openModal(
    "ASSISTANCE",
    "Set the pace.",
    `<p class="body-copy">At zero, your pair explains and you write. Increase this when you want a small, reviewable proposal.</p><input class="assistance" id="assistance" type="range" min="0" max="100" value="${state.assistance}" aria-label="Assistance level"><div class="detail-row"><span>Voice only</span><span>Draft with me</span></div><p class="modal-note">Changing assistance keeps the session intact.</p>`,
  );
  $("assistance").oninput = (e) => {
    state.assistance = Number(e.target.value);
    if (state.assistance === 0) proposal = null;
    save();
    render();
  };
};
$("closeModal").onclick = () => $("modal").close();
$("modal").addEventListener("click", (e) => {
  if (e.target === $("modal")) {
    const r = $("modal").getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      $("modal").close();
  }
});
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const k = e.key.toLowerCase();
  if (k === "k") {
    e.preventDefault();
    if (!$("modal").open) commands();
  }
  if (k === "j") {
    e.preventDefault();
    toggleBoard();
  }
  if (k === "f" && e.shiftKey) {
    e.preventDefault();
    toggleFocus();
  }
  if (k === "enter" && proposal) {
    e.preventDefault();
    accept();
  }
});
window.addEventListener("beforeunload", () => {
  save();
});
render();
