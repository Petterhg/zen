(() => {
  const host = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let models = [],
    revision,
    ready = false;
  const cards = new Map();
  let catalog = [],
    toolDefinitions = {},
    policy = {},
    grants = [],
    contracts = [];
  let coreTools = [],
    toolPresentation = {};
  const assignmentCards = new Map();
  function toolInfo(name) {
    return (
      toolPresentation[name] ?? {
        title: name.replaceAll("_", " "),
        description:
          toolDefinitions[name]?.description ??
          contracts.find((t) => t.name === name)?.description ??
          "No description supplied.",
        group: "Custom tools",
      }
    );
  }
  function toolLabel(name) {
    const info = toolInfo(name),
      label = document.createElement("span"),
      title = document.createElement("strong"),
      description = document.createElement("small");
    title.textContent = info.title;
    description.textContent = info.description;
    label.className = "tool-description";
    label.title = name;
    label.append(title, description);
    return label;
  }

  function field(id, label, kind, value, choices) {
    const wrapper = document.createElement("label");
    wrapper.textContent = label;
    const input = document.createElement(
      kind === "textarea" ? "textarea" : choices ? "select" : "input",
    );
    input.id = id;
    if (kind === "checkbox") {
      input.type = "checkbox";
      input.checked = value;
    } else {
      if (choices)
        for (const choice of choices) {
          const option = document.createElement("option");
          option.value = choice;
          option.textContent = choice;
          input.append(option);
        }
      input.value = value ?? "";
    }
    if (kind === "textarea") {
      input.rows = 4;
      input.maxLength = 8000;
    }
    wrapper.append(input);
    return { wrapper, input };
  }
  function add(id, agent) {
    const card = document.createElement("details");
    card.open = cards.size === 0;
    card.className = "profile";
    card.dataset.agent = id;
    const head = document.createElement("summary");
    head.className = "profile-heading";
    const title = document.createElement("h2");
    title.textContent = agent.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      cards.delete(id);
      card.remove();
    });
    head.append(title, remove);
    card.append(head);
    const fields = {};
    for (const [key, label, kind, choices] of [
      ["name", "Name", "text"],
      [
        "description",
        "Description · when the main agent should use this worker",
        "textarea",
      ],
      ["enabled", "Available to the main agent", "checkbox"],
      ["model", "Together model", "select", models],
      [
        "reasoningEffort",
        "Reasoning depth",
        "select",
        ["none", "low", "medium", "high"],
      ],
      ["mode", "Default execution", "select", ["foreground", "background"]],
      [
        "orientation",
        "Use for automatic service orientation (optional, one agent)",
        "checkbox",
      ],
      ["workspace", "Workspace", "select", ["shared", "isolated-worktree"]],
      ["instructions", "Instructions", "textarea"],
    ]) {
      const item = field(
        id + "-" + (key === "reasoningEffort" ? "effort" : key),
        label,
        kind,
        agent[key],
        choices,
      );
      if (key === "name") {
        item.input.maxLength = 80;
        item.input.required = true;
        item.input.addEventListener(
          "input",
          () => (title.textContent = item.input.value),
        );
      }
      if (key === "description") {
        item.input.maxLength = 2000;
        item.input.required = true;
      }
      if (key === "orientation")
        item.input.addEventListener("change", () => {
          if (item.input.checked)
            for (const [, other] of cards)
              if (other !== fields) other.orientation.checked = false;
        });
      fields[key] = item.input;
      card.append(item.wrapper);
    }
    const tools = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Assigned tools";
    tools.append(legend);
    fields.tools = [];
    for (const name of catalog.filter((n) => !coreTools.includes(n))) {
      const item = field(
        id + "-tool-" + name,
        "",
        "checkbox",
        agent.tools?.includes(name),
      );
      item.input.setAttribute("aria-label", toolInfo(name).title);
      item.wrapper.className = "agent-tool";
      item.wrapper.append(toolLabel(name));
      fields.tools.push({ name, input: item.input });
      tools.append(item.wrapper);
    }
    card.append(tools);
    const identity = document.createElement("p");
    identity.className = "note";
    identity.textContent = "Agent ID: " + id;
    card.append(identity);
    cards.set(id, fields);
    $("agentList").append(card);
  }
  $("add").addEventListener("click", () => {
    if (!ready) return;
    const id = "agent-" + crypto.randomUUID().slice(0, 8);
    add(id, {
      name: "New agent",
      description: "",
      enabled: true,
      model: models[0],
      reasoningEffort: "medium",
      mode: "foreground",
      orientation: false,
      instructions: "",
      workspace: "shared",
      tools: [],
    });
    $(id + "-name").closest("details").open = true;
    $(id + "-name").focus();
    $(id + "-name").select();
  });
  $("keys").addEventListener("click", () =>
    host.postMessage({ type: "configureKeys" }),
  );
  $("reload").addEventListener("click", () =>
    host.postMessage({ type: "ready" }),
  );
  $("profiles").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!ready) return;
    const agents = Object.fromEntries(
      [...cards].map(([id, fields]) => [
        id,
        Object.fromEntries(
          Object.entries(fields).map(([key, input]) => [
            key,
            key === "tools"
              ? input.filter((t) => t.input.checked).map((t) => t.name)
              : input.type === "checkbox"
                ? input.checked
                : input.value,
          ]),
        ),
      ]),
    );
    $("save").disabled = true;
    $("status").textContent = "Saving…";
    $("status").classList.remove("error");
    host.postMessage({ type: "save", agents, revision });
  });
  function renderTools() {
    $("builtinSelect").replaceChildren();
    for (const tool of contracts.filter((t) => !coreTools.includes(t.name))) {
      const option = document.createElement("option");
      option.value = tool.name;
      option.textContent = tool.name;
      $("builtinSelect").append(option);
    }
    const showContract = () => {
      const tool = contracts.find((t) => t.name === $("builtinSelect").value);
      $("builtinContract").textContent = tool
        ? JSON.stringify(tool, null, 2)
        : "No contract available in this context.";
    };
    $("builtinSelect").onchange = showContract;
    showContract();
    assignmentCards.clear();
    $("toolAssignments").replaceChildren();
    let group;
    for (const name of catalog.filter((n) => !coreTools.includes(n))) {
      const info = toolInfo(name);
      if (group !== info.group) {
        group = info.group;
        const heading = document.createElement("h3");
        heading.textContent = group;
        $("toolAssignments").append(heading);
      }
      const row = document.createElement("div");
      row.className = "tool-row";
      const label = toolLabel(name);
      const enabled = field(
          "enabled-" + name,
          "Enabled",
          "checkbox",
          !policy.disabled?.includes(name),
        ),
        main = field(
          "main-" + name,
          "Use in conversation",
          "checkbox",
          policy.mainTools?.includes(name),
        );
      enabled.input.setAttribute("aria-label", `Enable ${info.title}`);
      main.input.setAttribute(
        "aria-label",
        `Use ${info.title} in conversation`,
      );
      const controls = document.createElement("div");
      controls.className = "tool-controls";
      controls.append(enabled.wrapper, main.wrapper);
      row.append(label, controls);
      $("toolAssignments").append(row);
      assignmentCards.set(name, { enabled: enabled.input, main: main.input });
    }
    const previous = $("toolSelect").value;
    $("toolSelect").replaceChildren();
    for (const name of Object.keys(toolDefinitions)) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      $("toolSelect").append(option);
    }
    if (toolDefinitions[previous]) $("toolSelect").value = previous;
    selectTool();
  }
  function selectTool() {
    const name = $("toolSelect").value;
    $("toolDefinition").value = toolDefinitions[name]
      ? JSON.stringify(toolDefinitions[name], null, 2)
      : "";
    $("grantStatus").textContent = grants.includes(name)
      ? "Local execution allowed for this exact definition."
      : "Local execution not allowed.";
  }
  function send(type, extra = {}) {
    host.postMessage({ type, revision, ...extra });
  }
  const sections = {
    general: {
      page: "generalPage",
      title: "General",
      description: "Your editor, your way of working.",
    },
    agents: {
      page: "profiles",
      title: "Agents",
      description: "Choose who helps, when they work, and what they can do.",
    },
    tools: {
      page: "toolsPage",
      title: "Tools",
      description: "Give each agent the capabilities it needs.",
    },
  };
  function navigate(section) {
    if (!Object.hasOwn(sections, section)) return;
    for (const [name, item] of Object.entries(sections)) {
      $(item.page).hidden = name !== section;
      $(name + "Tab").setAttribute("aria-pressed", String(name === section));
    }
    $("pageTitle").textContent = sections[section].title;
    $("pageDescription").textContent = sections[section].description;
    $("definitionActions").hidden = section === "general";
    window.scrollTo(0, 0);
  }
  for (const section of Object.keys(sections))
    $(section + "Tab").onclick = () => navigate(section);
  for (const key of [
    "theme",
    "inlineMode",
    "shareContext",
    "followPair",
    "indexEnabled",
  ])
    $(key).onchange = () => {
      $("generalStatus").textContent = "Saving…";
      send("generalChange", {
        key,
        value: $(key).type === "checkbox" ? $(key).checked : $(key).value,
      });
    };
  for (const action of [
    "applyLayout",
    "manageMemory",
    "showTrace",
    "refreshIndex",
    "editorSettings",
    "keyboardSettings",
  ])
    $(action).onclick = () => send("generalAction", { action });
  for (const type of ["definitions", "import", "export"])
    $(type).onclick = () => send(type);
  $("toolSelect").onchange = selectTool;
  $("newTool").onclick = () => {
    $("toolSelect").selectedIndex = -1;
    $("toolDefinition").value = JSON.stringify(
      {
        version: 1,
        name: "run_checks",
        description: "Run repository checks and return a compact result.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        runtime: {
          type: "command",
          command: ["node", "tools/run-checks.mjs"],
          workingDirectory: "task-worktree",
          protocol: "json-stdio",
          timeoutMs: 120000,
        },
      },
      null,
      2,
    );
    $("grantStatus").textContent =
      "Save the definition before granting execution.";
  };
  $("saveTool").onclick = () =>
    send("saveTool", { definition: $("toolDefinition").value });
  for (const type of ["deleteTool", "grant", "revoke"])
    $(type).onclick = () => send(type, { name: $("toolSelect").value });
  $("savePolicy").onclick = () =>
    send("savePolicy", {
      disabled: [
        ...(policy.disabled ?? []).filter((n) => !assignmentCards.has(n)),
        ...[...assignmentCards]
          .filter(([, v]) => !v.enabled.checked)
          .map(([k]) => k),
      ],
      mainTools: [
        ...(policy.mainTools ?? []).filter((n) => !assignmentCards.has(n)),
        ...[...assignmentCards]
          .filter(([, v]) => v.main.checked)
          .map(([k]) => k),
      ],
    });
  $("testTool").onclick = () => {
    $("testResult").textContent = "Running…";
    send("testTool", {
      name: $("toolSelect").value,
      input: $("testInput").value,
    });
  };
  function renderIndex(data) {
    const active = [
      "starting",
      "connecting",
      "scanning",
      "indexing",
      "updating",
      "embedding",
    ].includes(data.state);
    const label = {
      starting: "Shared code index starting…",
      connecting: "Connecting to shared code index…",
      scanning: "Scanning repository…",
      indexing: `Indexing · ${data.processed ?? 0} / ${data.total ?? "?"} files checked`,
      updating: "Updating changed files…",
      embedding: "Updating semantic search…",
      ready: data.pendingEmbeddings
        ? `Search ready · ${data.pendingEmbeddings} files awaiting embeddings`
        : `Code index ready · ${data.files} files`,
      paused: "Code index paused",
      untrusted: "Code index waiting for workspace trust",
      error:
        data.files > 0 && data.pendingEmbeddings > 0
          ? "Text search ready · embeddings need attention"
          : "Code index needs attention",
    };
    $("indexStatus").textContent =
      label[data.state] || `Code index ${data.state}`;
    const progress = $("indexProgress");
    progress.classList.toggle("hidden", !active);
    if (data.state === "indexing" && data.total > 0) {
      progress.max = data.total;
      progress.value = data.processed || 0;
    } else progress.removeAttribute("value");
    $("indexDetail").textContent =
      data.state === "paused"
        ? "Enable Code Index and Share Editor Context in settings to resume."
        : data.state === "connecting"
          ? "One shared index on this computer. Connecting or recovering the local service; totals are unavailable until it responds."
          : data.state === "untrusted"
            ? "Trust this workspace to enable indexing."
            : [
                data.shared && "Shared on this computer",
                data.repository,
                data.pendingEmbeddings > 0 &&
                  "Changed files searchable by text now; embeddings after 30 min quiet (60 min maximum)",
                data.pendingEmbeddings > 0 &&
                  Number.isFinite(data.nextEmbeddingAt) &&
                  `Next embeddings ${new Date(data.nextEmbeddingAt).toLocaleTimeString()}`,
                data.migrationDeferred &&
                  "Old index cleanup will finish after older Zen windows close",
                active && data.currentFile,
                data.coverageKnown &&
                  `${data.files} files · ${data.chunks} chunks stored`,
                data.processed !== undefined &&
                  `${data.embedded ?? 0} chunks embedded · ${data.reused ?? 0} cached chunks reused this pass`,
                data.updatedAt &&
                  `Updated ${new Date(data.updatedAt).toLocaleTimeString()}`,
              ]
                .filter(Boolean)
                .join(" · ");
    $("indexError").textContent = data.error
      ? `${data.error} Fix the cause, then choose Refresh index to retry.`
      : "";
    $("indexError").classList.toggle("hidden", !data.error);
    $("indexStatus").title =
      "Shared local Turso · OpenAI small / 768. Totals cover this window’s registered checkouts; files checked includes unchanged or excluded candidates.";
  }
  window.addEventListener("message", ({ data }) => {
    if (data.type === "navigate") navigate(data.section);
    if (["generalSaved", "generalError"].includes(data.type)) {
      $("generalStatus").textContent = data.text;
      $("generalStatus").classList.toggle(
        "error",
        data.type === "generalError",
      );
    }
    if (data.type === "general") {
      for (const key of [
        "theme",
        "inlineMode",
        "shareContext",
        "followPair",
        "indexEnabled",
      ]) {
        if (data[key] === undefined) continue;
        if ($(key).type === "checkbox") $(key).checked = data[key];
        else $(key).value = data[key];
      }
      $("contextFile").textContent = data.contextFile ?? "No shared file";
      if (data.indexStatus) renderIndex(data.indexStatus);
    }

    if (data.type === "testResult")
      $("testResult").textContent =
        data.output + "\n\n" + JSON.stringify(data.history, null, 2);
    if (data.type === "settings") {
      $("keyStatus").textContent = data.togetherReady
        ? "Together key configured."
        : "Add a Together API key for workers. Pairing remains on Cerebras.";
      if (data.agents) {
        models = data.models;
        coreTools = data.coreTools ?? [];
        toolPresentation = data.toolPresentation ?? {};
        catalog = [...(data.builtin ?? []), ...Object.keys(data.tools ?? {})];
        toolDefinitions = data.tools ?? {};
        policy = data.policy ?? {};
        grants = data.grants ?? [];
        contracts = data.contracts ?? [];
        renderTools();
        revision = data.revision;
        cards.clear();
        $("agentList").replaceChildren();
        for (const [id, agent] of Object.entries(data.agents)) add(id, agent);
        ready = true;
        $("save").disabled = false;
      }
      $("status").textContent = data.error ?? "";
      $("status").classList.toggle("error", Boolean(data.error));
    }
    if (["saved", "error"].includes(data.type)) {
      $("status").textContent = data.text;
      $("status").classList.toggle("error", data.type === "error");
      $("save").disabled = !ready;
    }
  });
  host.postMessage({ type: "ready" });
})();
