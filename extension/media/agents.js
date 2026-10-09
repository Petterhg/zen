(() => {
  const host = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const ids = ["explorer", "deep_research"];
  let ready = false;
  $("keys").addEventListener("click", () =>
    host.postMessage({ type: "configureKeys" }),
  );
  $("profiles").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!ready) return;
    const agents = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          enabled: $(id + "-enabled").checked,
          model: $(id + "-model").value,
          reasoningEffort: $(id + "-effort").value,
          instructions: $(id + "-instructions").value,
        },
      ]),
    );
    $("save").disabled = true;
    $("status").textContent = "Saving…";
    $("status").classList.remove("error");
    host.postMessage({ type: "save", agents });
  });
  window.addEventListener("message", ({ data }) => {
    if (data.type === "settings") {
      $("keyStatus").textContent = data.togetherReady
        ? "Together key configured for research."
        : "Add a Together API key to enable research. Pairing remains on Cerebras.";
      if (data.agents) {
        for (const id of ids) {
          const agent = data.agents[id];
          $(id + "-model").replaceChildren(
            ...data.models.map((model) => {
              const option = document.createElement("option");
              option.value = model;
              option.textContent = model;
              return option;
            }),
          );
          $(id + "-enabled").checked = agent.enabled;
          $(id + "-model").value = agent.model;
          $(id + "-effort").value = agent.reasoningEffort;
          $(id + "-instructions").value = agent.instructions;
        }
        ready = true;
        $("save").disabled = false;
      }
      if (data.error) {
        $("status").textContent = data.error;
        $("status").classList.add("error");
      }
    }
    if (data.type === "saved" || data.type === "error") {
      $("status").textContent = data.text;
      $("status").classList.toggle("error", data.type === "error");
      $("save").disabled = !ready;
    }
  });
  host.postMessage({ type: "ready" });
})();
