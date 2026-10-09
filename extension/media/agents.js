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
  const assignmentCards = new Map();
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
    for (const name of catalog.filter(
      (n) =>
        ![
          "delegate_to_agents",
          "agent_run",
          "code_focus",
          "working_context",
        ].includes(n),
    )) {
      const item = field(
        id + "-tool-" + name,
        name,
        "checkbox",
        agent.tools?.includes(name),
      );
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
    for (const tool of contracts) {
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
    for (const name of catalog) {
      const row = document.createElement("div");
      row.className = "tool-row";
      const label = document.createElement("strong");
      label.textContent = name;
      const enabled = field(
          "enabled-" + name,
          "Available",
          "checkbox",
          !policy.disabled?.includes(name),
        ),
        main = field(
          "main-" + name,
          "Main",
          "checkbox",
          policy.mainTools?.includes(name),
        );
      row.append(label, enabled.wrapper, main.wrapper);
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
  $("agentsTab").onclick = () => {
    $("profiles").hidden = false;
    $("toolsPage").hidden = true;
    $("agentsTab").setAttribute("aria-pressed", "true");
    $("toolsTab").setAttribute("aria-pressed", "false");
  };
  $("toolsTab").onclick = () => {
    $("profiles").hidden = true;
    $("toolsPage").hidden = false;
    $("agentsTab").setAttribute("aria-pressed", "false");
    $("toolsTab").setAttribute("aria-pressed", "true");
  };
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
      disabled: [...assignmentCards]
        .filter(([, v]) => !v.enabled.checked)
        .map(([k]) => k),
      mainTools: [...assignmentCards]
        .filter(([, v]) => v.main.checked)
        .map(([k]) => k),
    });
  $("testTool").onclick = () => {
    $("testResult").textContent = "Running…";
    send("testTool", {
      name: $("toolSelect").value,
      input: $("testInput").value,
    });
  };
  window.addEventListener("message", ({ data }) => {
    if (data.type === "testResult")
      $("testResult").textContent =
        data.output + "\n\n" + JSON.stringify(data.history, null, 2);
    if (data.type === "settings") {
      $("keyStatus").textContent = data.togetherReady
        ? "Together key configured."
        : "Add a Together API key for workers. Pairing remains on Cerebras.";
      if (data.agents) {
        models = data.models;
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
