(() => {
  const host = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let models = [],
    revision,
    ready = false;
  const cards = new Map();
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
            input.type === "checkbox" ? input.checked : input.value,
          ]),
        ),
      ]),
    );
    $("save").disabled = true;
    $("status").textContent = "Saving…";
    $("status").classList.remove("error");
    host.postMessage({ type: "save", agents, revision });
  });
  window.addEventListener("message", ({ data }) => {
    if (data.type === "settings") {
      $("keyStatus").textContent = data.togetherReady
        ? "Together key configured."
        : "Add a Together API key for workers. Pairing remains on Cerebras.";
      if (data.agents) {
        models = data.models;
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
