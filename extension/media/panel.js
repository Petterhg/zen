(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const pending = new Map();
  const ledger = new PairLive.CommandLedger();
  const contextQuiet = new PairLive.PassiveContextWindow();
  let passiveTimer,
    pendingReferences,
    pendingStyle,
    playbackTimer,
    playbackContext,
    playbackSource,
    samplePlayback;
  let workerNotices = [];
  let latestContextId;
  let closing = false;
  let finalUsage = false;
  let usageSeconds = 0;
  let peer, events, microphone, closeTimer, startupTimer, muteTimer;
  let generation = 0,
    sessionToken = 0,
    ready = false,
    muted = false;
  let mode = "voice",
    backendReady = false;
  let openaiReady = false,
    lastVoiceContext = "",
    latestContext = "";
  const eventIds = new Set();

  function post(message) {
    vscode.postMessage(message);
  }
  let errorScope = "";
  function showError(message, scope = "voice") {
    errorScope = scope;
    $("error").textContent = message;
    $("error").classList.remove("hidden");
  }
  function clearError() {
    errorScope = "";
    $("error").classList.add("hidden");
  }
  function sendEvent(event, contextId) {
    if (!ready || closing || events?.readyState !== "open") return false;
    const id = crypto.randomUUID();
    try {
      if (event.type.endsWith(".append") || event.type.includes("input_audio."))
        ledger.track(id, event.type, contextId);
      events.send(JSON.stringify({ event_id: id, ...event }));
      return true;
    } catch {
      showError(
        "Voice update could not be delivered. Reconnect the voice session.",
      );
      return false;
    }
  }
  function rpc(method, params) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("The voice connection timed out."));
      }, 40000);
      pending.set(id, { resolve, reject, timeout });
      post({ type: "rpc", method, params, id });
    });
  }
  function setVoiceState(state) {
    const connected = state === "listening" || state === "muted";
    $("connect").classList.toggle("hidden", connected);
    $("connect").disabled =
      state === "connecting" || !(mode === "chat" ? backendReady : openaiReady);
    $("freshPairing").disabled =
      state === "connecting" || !(mode === "chat" ? backendReady : openaiReady);
    $("resumePairing").disabled =
      connected ||
      state === "connecting" ||
      !(mode === "chat" ? backendReady : openaiReady);
    $("connect").textContent =
      state === "connecting" ? "Connecting…" : "Start Pairing";
    $("mute").classList.toggle("hidden", !connected);
    $("disconnect").classList.toggle(
      "hidden",
      !connected && state !== "connecting",
    );
    $("statusDot").classList.toggle("connected", connected && !muted);
    $("voiceMark").classList.toggle("listening", connected && !muted);
    $("voiceMark").classList.toggle("muted", connected && muted);
    $("voiceTitle").textContent = connected
      ? muted
        ? "Microphone muted"
        : "Pairing together"
      : "Ready when you are";
    $("voiceDescription").textContent = connected
      ? muted
        ? "Your microphone is muted."
        : "Keep coding. I’m listening."
      : "Start when you’re ready.";
    $("voiceStatus").textContent =
      state === "connecting"
        ? "Connecting to GPT-Live…"
        : connected
          ? muted
            ? "Connected · microphone muted"
            : "Listening · GPT-Live"
          : "Voice is disconnected";
    $("mute").textContent = muted ? "Unmute" : "Mute";
    if (mode === "chat") {
      $("voiceTitle").textContent = "Thinking together";
      $("voiceStatus").textContent = "Chat · microphone off";
    }
    post({ type: "voiceState", text: state, sessionToken });
  }
  let urgentContext = false;
  function syncContext(force = false) {
    if (force === true) urgentContext = true;
    clearTimeout(passiveTimer);
    if (!ready || closing) return;
    samplePlayback?.(); // Recheck audio immediately; a slider can arrive between meter ticks.
    const delay = contextQuiet.remaining(Date.now());
    if (!urgentContext && delay > 0) {
      passiveTimer = setTimeout(syncContext, delay);
      return;
    }
    // A slider update is trusted policy but never an urgent playback interruption.
    if (pendingStyle) {
      if (delay > 0) passiveTimer = setTimeout(syncContext, delay);
      else if (
        sendEvent({
          type: "session.instructions.append",
          delegation_id: null,
          content: pendingStyle.content,
        })
      )
        pendingStyle = undefined;
    }
    if (workerNotices.length && delay === 0) {
      const notice = workerNotices.shift();
      sendEvent({
        type: "session.thinking.append",
        delegation_id: null,
        content: notice.content,
      });
      if (workerNotices.length) passiveTimer = setTimeout(syncContext, 1000);
    }
    if (ledger.pendingContext) return;
    urgentContext = false;
    if (
      latestContext &&
      latestContext !== lastVoiceContext &&
      sendEvent(
        {
          type: "session.thinking.append",
          delegation_id: null,
          content: latestContext,
        },
        latestContextId,
      )
    )
      lastVoiceContext = latestContext;
    if (
      pendingReferences &&
      sendEvent({
        type: "session.thinking.append",
        delegation_id: null,
        content: pendingReferences.content,
      })
    )
      pendingReferences = undefined;
  }
  function monitorPlayback(stream) {
    window.clearInterval(playbackTimer);
    playbackSource?.disconnect();
    samplePlayback = undefined;
    try {
      if (!playbackContext) return; // Transcript quiet window remains the fallback.
      const analyser = playbackContext.createAnalyser();
      analyser.fftSize = 1024;
      const samples = new Float32Array(analyser.fftSize);
      playbackSource = playbackContext.createMediaStreamSource(stream);
      playbackSource.connect(analyser); // Meter only; the audio element remains the sole player.
      samplePlayback = () => {
        if (playbackContext?.state !== "running") return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((sum, value) => sum + value * value, 0) /
            samples.length,
        );
        if (rms > 0.008) contextQuiet.speech(Date.now());
      };
      playbackTimer = window.setInterval(samplePlayback, 50);
    } catch {
      /* Transcript quiet window still protects updates if metering is unavailable. */
    }
  }
  function cleanup() {
    clearTimeout(passiveTimer);
    window.clearInterval(playbackTimer);
    playbackSource?.disconnect();
    playbackSource = undefined;
    void playbackContext?.close().catch(() => {});
    playbackContext = undefined;
    samplePlayback = undefined;
    pendingReferences = undefined;
    workerNotices = [];
    contextQuiet.reset();
    pendingStyle = undefined;
    clearTimeout(closeTimer);
    clearTimeout(muteTimer);
    $("mute").disabled = false;
    ledger.clear();
    closing = false;
    clearTimeout(startupTimer);
    microphone?.getTracks().forEach((track) => track.stop());
    microphone = undefined;
    const oldEvents = events,
      oldPeer = peer;
    events = undefined;
    peer = undefined;
    oldEvents?.close();
    oldPeer?.close();
    $("audio").pause();
    $("audio").srcObject = null;
    ready = false;
    muted = false;
    lastVoiceContext = "";
    urgentContext = false;
    $("playAudio").classList.add("hidden");
    setVoiceState("disconnected");
  }
  function stop() {
    generation++;
    // Stop local capture and playback immediately, while allowing a short graceful protocol close.
    microphone?.getTracks().forEach((track) => track.stop());
    $("audio").pause();
    $("audio").srcObject = null;
    post({ type: "disconnect" });
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("Voice connection canceled."));
    }
    pending.clear();
    if (ready && events?.readyState === "open") {
      sendEvent({ type: "session.close" });
      closing = true;
      ready = false;
      setVoiceState("disconnected");
      const closingPeer = peer;
      closeTimer = setTimeout(() => {
        if (peer !== closingPeer) return;
        $("deliveryStatus").textContent =
          `Voice closed locally · final usage unconfirmed (last ${Math.ceil(usageSeconds)}s)`;
        cleanup();
      }, 5000);
    } else cleanup();
  }
  async function start() {
    clearError();
    cleanup();
    const current = ++generation;
    eventIds.clear();
    finalUsage = false;
    usageSeconds = 0;
    $("deliveryStatus").textContent = "";
    setVoiceState("connecting");
    try {
      const connection = new RTCPeerConnection();
      peer = connection;
      if (window.AudioContext) {
        playbackContext = new window.AudioContext();
        void playbackContext.resume().catch(() => {});
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (current !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        connection.close();
        return;
      }
      microphone = stream;
      stream
        .getAudioTracks()
        .forEach((track) => connection.addTrack(track, stream));
      connection.addEventListener("track", (event) => {
        if (current !== generation) return;
        const remote = event.streams?.[0] ?? new MediaStream([event.track]);
        $("audio").srcObject = remote;
        monitorPlayback(remote);
        $("audio")
          .play()
          .catch(() => $("playAudio").classList.remove("hidden"));
      });
      events = connection.createDataChannel("oai-events");
      events.addEventListener("message", ({ data }) => {
        if (peer !== connection) return;
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          showError("The voice service sent an invalid event.");
          return;
        }
        if (event.event_id && eventIds.has(event.event_id)) return;
        if (event.event_id) eventIds.add(event.event_id);
        if (eventIds.size > 2000)
          eventIds.delete(eventIds.values().next().value);
        if (
          event.type === "session.usage.updated" ||
          event.type === "session.closed"
        ) {
          usageSeconds = event.usage?.seconds ?? usageSeconds;
          finalUsage = event.type === "session.closed";
          post({
            type: "liveUsage",
            seconds: usageSeconds,
            final: finalUsage,
            sessionToken,
          });
        }
        if (event.type === "session.closed") {
          $("deliveryStatus").textContent =
            `Voice ended · ${Math.ceil(usageSeconds)}s · ${event.reason ?? "closed"}`;
          post({ type: "disconnect" });
          cleanup();
          return;
        }
        const acknowledged = ledger.receive(event);
        if (acknowledged?.contextId !== undefined) {
          if (acknowledged.accepted)
            post({
              type: "contextAcknowledged",
              contextId: acknowledged.contextId,
              endMs: event.end_ms,
              sessionToken,
            });
          else {
            lastVoiceContext = "";
            urgentContext = false;
            $("deliveryStatus").textContent =
              "Editor context was not delivered. Reconnect before relying on voice selection.";
          }
          if (acknowledged.accepted) syncContext();
        }
        if (acknowledged?.type.includes("input_audio."))
          clearTimeout(muteTimer);
        if (acknowledged && !acknowledged.accepted) {
          $("mute").disabled = false;
          if (acknowledged.type.includes("input_audio.")) {
            showError(
              "Microphone control failed. Reconnect the voice session.",
            );
            stop();
            return;
          }
        }
        if (closing || current !== generation) return;
        if (event.type === "session.started") {
          clearTimeout(startupTimer);
          ready = true;
          setVoiceState("listening");
          syncContext();
        }
        if (event.type === "error")
          showError(
            "The voice service rejected an update. " +
              (event.error?.code ??
                "Check the session and reconnect if needed."),
          );
        if (
          event.type === "session.input_audio.muted" &&
          acknowledged?.accepted
        ) {
          muted = true;
          setVoiceState("muted");
          $("mute").disabled = false;
        }
        if (
          event.type === "session.input_audio.unmuted" &&
          acknowledged?.accepted
        ) {
          muted = false;
          microphone?.getAudioTracks().forEach((track) => {
            track.enabled = true;
          });
          setVoiceState("listening");
          $("mute").disabled = false;
        }
        if (event.type === "session.output_transcript.delta")
          contextQuiet.speech(Date.now());
        // A real spoken request needs the latest focus; typing alone never forces delivery.
        if (
          event.type === "session.input_transcript.delta" &&
          event.delta?.trim()
        )
          syncContext(true);
        // Keep every transcript fragment in host history/trace, without a chat surface.
        post({ type: "liveEvent", event, sessionToken });
      });
      events.addEventListener("close", () => {
        if (peer !== connection) return;
        if (!finalUsage)
          $("deliveryStatus").textContent =
            "Connection closed · final usage unconfirmed";
        post({ type: "disconnect" });
        cleanup();
      });
      connection.addEventListener("connectionstatechange", () => {
        if (
          current === generation &&
          ["failed", "disconnected"].includes(connection.connectionState)
        ) {
          showError("Voice connection interrupted. Reconnect when ready.");
          stop();
        }
      });
      await connection.setLocalDescription(await connection.createOffer());
      if (connection.iceGatheringState !== "complete")
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            connection.removeEventListener("icegatheringstatechange", onState);
            reject(new Error("ICE negotiation timed out."));
          }, 10000);
          function onState() {
            if (connection.iceGatheringState === "complete") {
              clearTimeout(timeout);
              connection.removeEventListener(
                "icegatheringstatechange",
                onState,
              );
              resolve();
            }
          }
          connection.addEventListener("icegatheringstatechange", onState);
          onState();
        });
      if (current !== generation) return;
      const result = await rpc("createSession", {
        sdp: connection.localDescription.sdp,
      });
      if (current !== generation) return;
      sessionToken = result.sessionToken;
      await connection.setRemoteDescription({
        type: "answer",
        sdp: result.transport.sdp,
      });
      startupTimer = setTimeout(() => {
        if (current === generation && !ready) {
          showError("GPT-Live did not finish starting.");
          stop();
        }
      }, 20000);
    } catch (error) {
      if (current !== generation) return;
      stop();
      showError(
        error instanceof Error ? error.message : "Could not connect voice.",
      );
    }
  }
  $("connect").addEventListener("click", start);
  $("disconnect").addEventListener("click", stop);
  $("mute").addEventListener("click", () => {
    if (!ready) return;
    $("mute").disabled = true;
    if (!muted)
      microphone?.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    sendEvent({
      type: muted ? "session.input_audio.unmute" : "session.input_audio.mute",
    });
    muteTimer = setTimeout(() => {
      showError(
        "Microphone control was not acknowledged. Reconnect the voice session.",
      );
      stop();
    }, 5000);
  });
  $("playAudio").addEventListener("click", () => {
    $("audio")
      .play()
      .then(() => $("playAudio").classList.add("hidden"))
      .catch(() => showError("Audio playback is blocked."));
  });
  // Appearance and folding never touch the transport, microphone or backend job.
  for (const [id, type] of [
    ["switchTheme", "toggleTheme"],

    ["applyLayout", "applyLayout"],
    ["agentSettings", "agentSettings"],
    ["manageMemory", "manageMemory"],
    ["resumePairing", "resumePairing"],
    ["freshPairing", "freshPairing"],
  ]) {
    $(id).addEventListener("click", () => post({ type }));
  }
  $("toggleSettings").addEventListener("click", () => {
    $("pairingSettings").open = !$("pairingSettings").open;
    if ($("pairingSettings").open)
      $("pairingSettings").scrollIntoView({ block: "nearest" });
  });
  $("pairingSettings").addEventListener("toggle", () => {
    $("toggleSettings").setAttribute(
      "aria-expanded",
      String($("pairingSettings").open),
    );
  });
  for (const id of ["configure", "setupKeys"])
    $(id).addEventListener("click", () => post({ type: "configure" }));
  for (const type of ["cancel"])
    $(type).addEventListener("click", () => {
      clearError();
      post({ type });
    });
  function showAssistance(level) {
    const band = level === 0 ? 0 : Math.ceil(level / 25);
    const labels = [
      "Voice only",
      "One small step",
      "Build together",
      "Draft a section",
      "Draft it for me",
    ];
    const descriptions = [
      "Voice guidance only. Explain your next line or action, then wait. No AI code or suggestions.",
      "Explain one small step, then wait. Tiny previews when requested.",
      "Explain and build one logical piece at a time, then pause for review.",
      "Draft one section, explain its role, then wait for review.",
      "Draft the requested code, then ask what you want clarified.",
    ];
    $("assistanceLabel").textContent = labels[band];
    $("assistanceLevel").setAttribute("aria-valuetext", labels[band]);
    $("assistanceDescription").textContent = descriptions[band];
  }
  $("assistanceLevel").addEventListener("input", () =>
    showAssistance(Number($("assistanceLevel").value)),
  );
  $("assistanceLevel").addEventListener("change", () =>
    post({
      type: "assistanceLevel",
      level: Number($("assistanceLevel").value),
    }),
  );
  showAssistance(25);
  $("inlineMode").addEventListener("change", () =>
    post({ type: "inlineMode", mode: $("inlineMode").value }),
  );
  function renderTranscript(entries) {
    const log = $("transcript");
    log.replaceChildren();
    for (const entry of entries) {
      const item = document.createElement("article");
      const label = document.createElement("strong");
      label.textContent = entry.role === "user" ? "You" : "Zen";
      const content = document.createElement("p");
      content.textContent = entry.text;
      item.append(label, content);
      log.append(item);
    }
    log.scrollTop = log.scrollHeight;
  }
  function showMode(next) {
    mode = next;
    $("chatView").classList.toggle("hidden", mode !== "chat");
    document.body.classList.toggle("chat-mode", mode === "chat");
    $("voiceMode").setAttribute("aria-pressed", String(mode === "voice"));
    $("chatMode").setAttribute("aria-pressed", String(mode === "chat"));
    setVoiceState(ready ? "listening" : "disconnected");
  }
  for (const next of ["voice", "chat"]) {
    $(next + "Mode").addEventListener("click", () => {
      if (mode === next) return;
      // Close fully before allowing a text request: an old close event must not cancel it.
      if (next === "chat") {
        stop();
        cleanup();
      }
      $("send").disabled = true;
      post({ type: "conversationMode", mode: next });
    });
  }
  function sendTyped() {
    const text = $("message").value.trim();
    if (!text || mode !== "chat" || $("send").disabled) return;
    clearError();
    $("message").value = "";
    post({ type: "typed", text });
  }
  $("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    sendTyped();
  });
  $("message").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendTyped();
    }
  });
  $("refreshIndex").addEventListener("click", () =>
    post({ type: "refreshIndex" }),
  );
  window.addEventListener("message", ({ data }) => {
    if (data.type === "conversationMode") {
      showMode(data.mode);
      $("send").disabled = !backendReady;
    }
    if (data.type === "transcript") renderTranscript(data.entries);
    if (data.type === "indexStatus") {
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
        ? `${data.error} Fix the cause, then press ↻ to retry.`
        : "";
      $("indexError").classList.toggle("hidden", !data.error);
      $("indexStatus").title =
        "Shared local Turso · OpenAI small / 768. Totals cover this window’s registered checkouts; files checked includes unchanged or excluded candidates.";
    }
    if (data.type === "rpcResult") {
      const entry = pending.get(data.id);
      if (!entry) return;
      clearTimeout(entry.timeout);
      pending.delete(data.id);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data.result);
    }
    if (data.type === "taskIntent") {
      $("taskIntentText").textContent = String(data.text ?? "").slice(0, 320);
      $("taskIntent").classList.toggle("hidden", !data.text);
    }
    if (data.type === "conversationAvailable") {
      $("resumePairing").classList.toggle("hidden", !data.available);
      $("resumePairing").title = data.available
        ? "Load saved context; current files will be checked again"
        : "";
    }
    if (data.type === "checkpointLoaded") {
      $("checkpointNote").textContent =
        "Previous pairing loaded" +
        (data.fileChanged ? " · file changed; recheck needed" : "") +
        ": " +
        String(data.task).slice(0, 120) +
        (String(data.task).length > 120 ? "…" : "");
      $("checkpointNote").title = String(data.task);
      $("checkpointNote").classList.remove("hidden");
    }
    if (data.type === "checkpointCleared") {
      $("checkpointNote").textContent = "";
      $("checkpointNote").classList.add("hidden");
    }
    if (data.type === "configuration") {
      openaiReady = data.openaiReady;
      backendReady = data.backendReady;
      $("send").disabled = !backendReady;
      $("connect").disabled = !openaiReady;
      $("freshPairing").disabled = !(mode === "chat"
        ? backendReady
        : openaiReady);
      $("resumePairing").disabled =
        ready || !(mode === "chat" ? backendReady : openaiReady);
      $("inlineMode").value = data.inlineMode ?? "manual";
      $("assistanceLevel").value = data.assistanceLevel ?? 25;
      showAssistance(data.assistanceLevel ?? 25);
      $("setup").classList.toggle(
        "hidden",
        data.openaiReady && data.backendReady,
      );
      $("setup").querySelector("span").textContent = !data.openaiReady
        ? "Add an OpenAI key for voice pairing."
        : !data.backendReady
          ? "Add a Cerebras key for code reasoning."
          : "Models connected.";
      $("contextSharing").textContent = data.shareContext
        ? "Editor context on"
        : "Context off";
      $("shareContext").checked = data.shareContext;
      $("followPair").checked = data.followPair ?? true;
    }
    if (data.type === "context") {
      $("contextFile").textContent = data.file;
      $("workspaceLabel").textContent = data.workspace || "YOUR WORKSPACE";
      $("selectionBadge").textContent = data.selectionLines
        ? `${data.selectionLines} lines`
        : "";
      if (latestContext !== data.voiceContext) contextQuiet.edit(Date.now());
      latestContext = data.voiceContext;
      latestContextId = data.contextId;
      syncContext(data.urgent === true);
    }
    if (data.type === "answer" && errorScope === "backend") clearError();
    if (data.type === "answer" && data.status === "clarification")
      $("editStatus").textContent = String(data.speech || data.text).slice(
        0,
        350,
      );
    if (data.type === "research") showResearch(data.article);
    if (data.type === "researchHistory") data.articles.forEach(showResearch);
    if (data.type === "contextStatus") {
      $("contextStatus").textContent = data.text || "";
      $("contextStatus").classList.toggle("hidden", data.state !== "working");
    }
    if (data.type === "backendStatus") {
      $("backendActivity").classList.toggle("hidden", data.state !== "working");
      $("backendActivity").querySelectorAll("span")[1].textContent = data.tool
        ? `Inspecting · ${data.tool}`
        : "Thinking about your code…";
    }
    if (data.type === "error") showError(data.message, "backend");
    if (data.type === "stopVoice") {
      $("taskIntentText").textContent = "";
      $("taskIntent").classList.add("hidden");
      if (peer) stop();
      else cleanup();
    }
    // Starting a new session cannot use the previous transport token: the host
    // increments it on disconnect. Mute/end still target only the current session.
    if (
      data.type === "voiceControl" &&
      data.action === "start" &&
      (!peer || closing)
    ) {
      showMode("voice");
      void start();
    }
    if (data.type === "voiceControl" && data.sessionToken === sessionToken) {
      if (data.action === "mute") $("mute").click();
      if (data.action === "end") stop();
    }
    if (data.type === "liveAppend" && data.sessionToken === sessionToken) {
      if (data.passiveKey === "workerCompletion" && data.mode === "thinking") {
        workerNotices.push(data);
        workerNotices = workerNotices.slice(-32);
        syncContext();
      } else if (
        data.passiveKey === "assistanceStyle" &&
        data.mode === "instructions"
      ) {
        pendingStyle = data;
        syncContext();
      } else if (
        data.passiveKey === "codeReferences" &&
        data.mode === "thinking"
      ) {
        pendingReferences = data;
        syncContext();
      } else
        sendEvent({
          type: `session.${data.mode}.append`,
          delegation_id: data.delegationId,
          content: data.content,
        });
    }
    if (data.type === "proposal")
      $("editStatus").textContent =
        `Preview in ${data.file} · accept with ⌘Enter`;
    if (data.type === "proposalStale")
      $("editStatus").textContent = "File changed · ask for a fresh preview.";
    if (data.type === "proposalRejected")
      $("editStatus").textContent = "Preview rejected.";
    if (data.type === "proposalApplied")
      $("editStatus").textContent = "Edit accepted · undo with ⌘Z.";
  });
  function showResearch(article) {
    let url;
    try {
      url = new URL(article.url);
    } catch {
      return;
    }
    if (url.protocol !== "https:" || url.username || url.password) return;
    $("researchEmpty").classList.add("hidden");
    $("researchSection").classList.remove("hidden");
    const container = $("researchPages");
    const previous = Array.from(container.children).find(
      (el) => el.dataset.url === url.href,
    );
    previous?.remove();
    const card = document.createElement("details");
    card.className = "research-page";
    card.dataset.url = url.href;
    card.open = !!article.text;
    const title = document.createElement("summary");
    title.textContent = (article.title || url.hostname).slice(0, 180);
    const source = document.createElement("button");
    source.className = "text-button research-source";
    source.textContent = url.hostname + " ↗";
    source.addEventListener("click", () =>
      post({ type: "openSource", text: url.href }),
    );
    const body = document.createElement("div");
    body.className = "research-body";
    body.textContent = String(
      article.text || "Search result · ask your pair to read this page.",
    ).slice(0, 11000);
    card.append(title, source, body);
    container.prepend(card);
    while (container.children.length > 8) container.lastElementChild.remove();
  }
  $("showTrace").addEventListener("click", () => post({ type: "showTrace" }));
  $("followPair").addEventListener("change", () =>
    post({ type: "followPair", enabled: $("followPair").checked }),
  );
  $("shareContext").addEventListener("change", () =>
    post({ type: "shareContext", enabled: $("shareContext").checked }),
  );
  $("clearResearch").addEventListener("click", () => {
    $("researchPages").replaceChildren();
    $("researchEmpty").classList.remove("hidden");
    $("researchSection").classList.add("hidden");
    post({ type: "clearResearch" });
  });
  window.addEventListener("beforeunload", stop);
  post({ type: "ready" });

  let workerRuns = [],
    workerDetail,
    selectedRun,
    workerTab = "task";
  function renderWorkerInspector() {
    const run = workerDetail?.id === selectedRun ? workerDetail : undefined;
    $("workerInspector").classList.toggle("hidden", !run);
    if (!run) return;
    $("workerTitle").textContent = run.agent.name;
    $("workerMeta").textContent =
      `${run.state} · ${run.mode} · ${run.agent.model} · ${run.agent.reasoningEffort}\n${run.id}`;
    $("workerStop").classList.toggle(
      "hidden",
      !["running", "queued"].includes(run.state),
    );
    $("workerContent").textContent =
      workerTab === "task"
        ? `Delegated task\n${run.task}\n\nScope: ${run.scope ?? "Not specified"}\n\nSystem instructions (profile captured at launch)\n${run.instructions}`
        : workerTab === "activity"
          ? (run.activity
              .map(
                (a) =>
                  `${new Date(a.time).toLocaleTimeString()} · ${a.tool}\n${JSON.stringify(a.arguments, null, 2)}${a.result ? "\n" + a.result : "\nStarted"}`,
              )
              .join("\n\n") || "No tool calls yet.") +
            (run.omitted
              ? `\n\n${run.omitted} older activity entries omitted.`
              : "")
          : (run.output ??
            (run.state === "cancelled"
              ? "Run cancelled."
              : "Waiting for the worker’s report…"));
    for (const button of $("workerTabs").querySelectorAll("button"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.tab === workerTab),
      );
  }
  $("workerSettings").addEventListener("click", () =>
    post({ type: "agentSettings" }),
  );
  $("workerStop").addEventListener("click", () => {
    if (selectedRun) post({ type: "stopAgentRun", id: selectedRun });
  });
  $("workerTabs").addEventListener("click", (event) => {
    const tab = event.target.closest("button")?.dataset.tab;
    if (!tab) return;
    workerTab = tab;
    renderWorkerInspector();
  });
  window.addEventListener("message", ({ data }) => {
    if (data.type === "agentAvailability") {
      $("workerChoices").replaceChildren(
        ...data.agents.map((agent) => {
          const label = document.createElement("label"),
            input = document.createElement("input"),
            name = document.createElement("span");
          input.type = "checkbox";
          input.checked = agent.enabled;
          input.addEventListener("change", () =>
            post({ type: "toggleAgent", id: agent.id, enabled: input.checked }),
          );
          name.textContent = agent.name;
          label.title = agent.description;
          label.append(input, name);
          return label;
        }),
      );
    }
    if (data.type === "agentRunDetail") {
      workerDetail = data.run;
      renderWorkerInspector();
    }
    if (data.type === "agentRuns") {
      workerRuns = data.runs;
      if (!workerRuns.length) workerNotices = [];
      if (!workerRuns.some((r) => r.id === selectedRun)) {
        selectedRun = workerRuns.at(-1)?.id;
        workerDetail = undefined;
        if (selectedRun) post({ type: "inspectAgentRun", id: selectedRun });
      }
      $("workerEmpty").classList.toggle("hidden", Boolean(workerRuns.length));
      $("workerList").replaceChildren(
        ...workerRuns
          .slice()
          .reverse()
          .map((run) => {
            const button = document.createElement("button");
            button.className = "worker-row";
            button.textContent = `${run.agent.name} · ${run.state} · ${run.id.slice(0, 6)}\n${run.task.slice(0, 100)}`;
            button.setAttribute("aria-pressed", String(run.id === selectedRun));
            button.addEventListener("click", () => {
              selectedRun = run.id;
              workerDetail = undefined;
              post({ type: "inspectAgentRun", id: run.id });
              for (const row of $("workerList").children)
                row.setAttribute("aria-pressed", String(row === button));
              renderWorkerInspector();
            });
            return button;
          }),
      );
      renderWorkerInspector();
    }
  });
})();
