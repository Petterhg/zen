import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
  headless: true,
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const html = (await readFile("extension/media/panel.html", "utf8"))
    .replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "");
  await page.route("https://pair.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.goto("https://pair.test/");
  await page.addStyleTag({ path: "extension/media/panel.css" });
  await page.evaluate(() => {
    window.sent = [];
    window.peers = [];
    window.messages = [];
    window.tracks = [];
    window.host = (data) =>
      window.dispatchEvent(new MessageEvent("message", { data }));
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        window.messages.push(message);
        if (message.type === "ready")
          window.host({
            type: "configuration",
            openaiReady: true,
            backendReady: true,
            provider: "groq",
            inlineMode: "manual",
            shareContext: true,
          });
        if (message.type === "rpc")
          queueMicrotask(() =>
            window.host({
              type: "rpcResult",
              id: message.id,
              result: {
                sessionToken: window.peers.length,
                transport: { sdp: "answer" },
              },
            }),
          );
      },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        async getUserMedia() {
          const track = {
            enabled: true,
            stopped: false,
            stop() {
              this.stopped = true;
            },
          };
          window.tracks.push(track);
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
      },
    });
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.play = async function () {};
    window.outputRms = 0;
    window.AudioContext = class {
      state = "running";
      async resume() {}
      async close() {
        this.state = "closed";
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createAnalyser() {
        return {
          fftSize: 1024,
          getFloatTimeDomainData(samples) {
            samples.fill(window.outputRms);
          },
        };
      }
    };
    window.RTCPeerConnection = class extends EventTarget {
      constructor() {
        super();
        this.iceGatheringState = "complete";
        window.peers.push(this);
      }
      addTrack() {}
      createDataChannel() {
        const ch = new EventTarget();
        ch.readyState = "open";
        ch.send = (data) => window.sent.push(JSON.parse(data));
        ch.close = () => {
          ch.readyState = "closed";
        };
        ch.emit = (data) =>
          ch.dispatchEvent(
            new MessageEvent("message", { data: JSON.stringify(data) }),
          );
        this.channel = ch;
        return ch;
      }
      async createOffer() {
        return { type: "offer", sdp: "offer" };
      }
      async setLocalDescription(value) {
        this.localDescription = value;
      }
      async setRemoteDescription() {
        this.channel.emit({ type: "session.started" });
      }
      close() {}
    };
  });
  await page.addScriptTag({ path: "extension/media/live-protocol.js" });
  await page.addScriptTag({ path: "extension/media/panel.js" });
  await page.evaluate(() =>
    window.host({
      type: "indexStatus",
      state: "indexing",
      processed: 3,
      total: 10,
      currentFile: "src/main.py",
      repository: "demo",
      embedded: 4,
      reused: 2,
    }),
  );
  assert.match(await page.locator("#indexStatus").textContent(), /3 \/ 10/);
  assert.equal(await page.locator("#indexProgress").getAttribute("value"), "3");
  assert.match(
    await page.locator("#indexDetail").textContent(),
    /src\/main.py/,
  );
  await page.evaluate(() =>
    window.host({
      type: "indexStatus",
      state: "error",
      error: "Embedding request failed (429).",
    }),
  );
  assert.equal(await page.locator("#indexError").isVisible(), true);
  assert.match(await page.locator("#indexError").textContent(), /429/);
  await page.evaluate(() =>
    window.host({ type: "indexStatus", state: "ready", files: 8 }),
  );
  assert.equal(await page.locator("#indexProgress").isVisible(), false);
  assert.equal(await page.locator("#indexError").isVisible(), false);
  assert.equal(
    await page.locator("#assistanceLevel").getAttribute("step"),
    "1",
  );
  assert.equal(await page.locator("#assistanceLevel").inputValue(), "25");
  assert.equal(await page.locator("#assistanceLevel").isVisible(), false);
  await page.locator("#toggleSettings").click();
  await page.locator("#assistanceLevel").fill("0");
  assert.equal(
    await page.locator("#assistanceLabel").textContent(),
    "Voice only",
  );
  await page.locator("#assistanceLevel").dispatchEvent("change");
  assert.ok(
    await page.evaluate(() =>
      window.messages.some(
        (m) => m.type === "assistanceLevel" && m.level === 0,
      ),
    ),
  );
  await page.locator("#assistanceLevel").fill("100");
  assert.equal(
    await page.locator("#assistanceLabel").textContent(),
    "Draft it for me",
  );
  await page.evaluate(() =>
    window.host({
      type: "configuration",
      openaiReady: true,
      backendReady: true,
      provider: "groq",
      assistanceLevel: 25,
    }),
  );
  await page.locator("#connect").click();
  await page.waitForFunction(
    () =>
      document.getElementById("voiceStatus").textContent ===
      "Listening · GPT-Live",
  );
  const voiceBeforeAppearance = await page.evaluate(() => ({
    peers: window.peers.length,
    events: window.sent.length,
    stopped: window.tracks.filter((track) => track.stopped).length,
  }));
  await page.locator("#switchTheme").click();
  await page.locator("#foldWorkboard").click();
  await page.locator("#toggleSettings").click();
  await page.locator("#toggleSettings").click();
  await page.locator("#manageMemory").click();
  await page.locator("#resumePairing").click();
  assert.ok(
    await page.evaluate(() =>
      window.messages.some((m) => m.type === "resumePairing"),
    ),
  );
  await page.evaluate(() =>
    window.host({
      type: "checkpointLoaded",
      task: "<script>historical task</script>",
      fileChanged: true,
    }),
  );
  assert.match(
    await page.locator("#checkpointNote").innerText(),
    /file changed/,
  );
  assert.equal(await page.locator("#checkpointNote script").count(), 0);
  await page.evaluate(() => window.host({ type: "checkpointCleared" }));
  assert.equal(await page.locator("#checkpointNote").isVisible(), false);

  assert.ok(
    await page.evaluate(() =>
      window.messages.some((m) => m.type === "manageMemory"),
    ),
  );
  assert.deepEqual(
    await page.evaluate(() => ({
      peers: window.peers.length,
      events: window.sent.length,
      stopped: window.tracks.filter((track) => track.stopped).length,
    })),
    voiceBeforeAppearance,
  );
  assert.ok(
    await page.evaluate(() =>
      window.messages.some((m) => m.type === "toggleTheme"),
    ),
  );
  assert.ok(
    await page.evaluate(() =>
      window.messages.some((m) => m.type === "toggleWorkboard"),
    ),
  );
  await page.evaluate(() =>
    window.host({
      type: "liveAppend",
      sessionToken: 1,
      delegationId: null,
      mode: "instructions",
      passiveKey: "assistanceStyle",
      content: "Pairing style now 0/100. Coach one line, then wait.",
    }),
  );
  assert.ok(
    await page.evaluate(() =>
      window.sent.some(
        (e) =>
          e.type === "session.instructions.append" &&
          e.delegation_id === null &&
          e.content.includes("Coach one line"),
      ),
    ),
  );
  await page.evaluate(() => {
    window.host({
      type: "context",
      file: "a.ts",
      voiceContext: "Focus a.ts",
      contextId: 3,
    });
    const ch = window.peers[0].channel;
    ch.emit({
      type: "session.input_transcript.delta",
      delta: "Change ",
      start_ms: 10,
      end_ms: 100,
    });
    ch.emit({
      type: "session.output_transcript.delta",
      delta: "Mm-hm.",
      start_ms: 50,
      end_ms: 120,
    });
    ch.emit({
      type: "session.input_transcript.delta",
      delta: "this function.",
      start_ms: 110,
      end_ms: 200,
    });
    const context = window.sent.find(
      (e) => e.type === "session.thinking.append",
    );
    ch.emit({
      type: "session.thinking.appended",
      client_event_id: context.event_id,
      start_ms: 210,
      end_ms: 220,
    });
  });
  assert.equal(
    await page.locator("#transcripts, .turn, #proposalCode").count(),
    0,
  );
  assert.ok(
    await page.evaluate(() =>
      window.messages.some(
        (m) => m.type === "liveEvent" && m.event.delta === "this function.",
      ),
    ),
  );
  await page.evaluate(() => {
    const peer = window.peers[0];
    window.outputRms = 0.05;
    peer.dispatchEvent(
      Object.assign(new Event("track"), { streams: [new MediaStream()] }),
    );
    peer.channel.emit({
      type: "session.output_transcript.delta",
      delta: "Type the next line,",
      event_id: "typing-check-speech",
      start_ms: 300,
      end_ms: 500,
    });
    window.typingSentStart = window.sent.length;
    for (const level of [50, 25, 0])
      window.host({
        type: "liveAppend",
        sessionToken: 1,
        delegationId: null,
        mode: "instructions",
        passiveKey: "assistanceStyle",
        content: `Quiet slider update ${level}`,
      });
    for (let n = 1; n <= 10; n++) {
      window.host({
        type: "context",
        file: "a.ts",
        voiceContext: "Focus after typing " + n,
        contextId: 100 + n,
      });
      window.host({
        type: "liveAppend",
        passiveKey: "codeReferences",
        mode: "thinking",
        sessionToken: 1,
        delegationId: null,
        content: "Verified names " + n,
      });
    }
  });
  await page.waitForTimeout(1300); // Playback continues after the last transcript fragment.
  assert.ok(
    await page.evaluate(
      () =>
        !window.sent
          .slice(window.typingSentStart)
          .some((e) =>
            ["session.thinking.append", "session.instructions.append"].includes(
              e.type,
            ),
          ),
    ),
  );
  assert.ok(await page.evaluate(() => window.tracks[0].enabled)); // No typing-triggered microphone mute.
  await page.evaluate(() => {
    window.outputRms = 0;
  });
  await page.waitForFunction(() =>
    window.sent.some((e) => e.content === "Focus after typing 10"),
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.sent
        .slice(window.typingSentStart)
        .filter((e) => e.type === "session.instructions.append")
        .map((e) => e.content),
    ),
    ["Quiet slider update 0"],
  );

  assert.deepEqual(
    await page.evaluate(() =>
      window.sent
        .slice(window.typingSentStart)
        .filter((e) => e.type === "session.thinking.append")
        .map((e) => e.content),
    ),
    ["Focus after typing 10", "Verified names 10"],
  );
  await page.evaluate(() => {
    const event = window.sent.find(
      (e) => e.content === "Focus after typing 10",
    );
    window.peers[0].channel.emit({
      type: "session.thinking.appended",
      client_event_id: event.event_id,
      start_ms: 510,
      end_ms: 520,
    });
    window.outputRms = 0.05;
    window.host({
      type: "liveAppend",
      sessionToken: 1,
      delegationId: null,
      mode: "instructions",
      passiveKey: "assistanceStyle",
      content: "Quiet slider update during spoken input",
    });
    window.host({
      type: "context",
      file: "b.ts",
      voiceContext: "Explicit spoken target b.ts",
      contextId: 111,
    });
    window.peers[0].channel.emit({
      type: "session.input_transcript.delta",
      delta: "Explain this function",
      event_id: "spoken-target",
      start_ms: 530,
      end_ms: 540,
    });
  });
  assert.ok(
    await page.evaluate(() =>
      window.sent.some((e) => e.content === "Explicit spoken target b.ts"),
    ),
  );
  assert.equal(
    await page.evaluate(() =>
      window.sent.some(
        (e) => e.content === "Quiet slider update during spoken input",
      ),
    ),
    false,
  );
  await page.evaluate(() => {
    window.host({
      type: "context",
      file: "b.ts",
      contextId: 112,
      urgent: true,
      voiceContext: "Human completed line: app = FastAPI()",
    });
    const previous = window.sent.find(
      (e) => e.content === "Explicit spoken target b.ts",
    );
    window.peers[0].channel.emit({
      type: "session.thinking.appended",
      client_event_id: previous.event_id,
      start_ms: 550,
      end_ms: 560,
    });
  });
  assert.ok(
    await page.evaluate(() =>
      window.sent.some(
        (e) => e.content === "Human completed line: app = FastAPI()",
      ),
    ),
  );
  assert.ok(await page.evaluate(() => window.tracks[0].enabled));
  await page.evaluate(() => {
    const latest = window.sent.find(
      (e) => e.content === "Human completed line: app = FastAPI()",
    );
    window.peers[0].channel.emit({
      type: "session.thinking.appended",
      client_event_id: latest.event_id,
      start_ms: 570,
      end_ms: 580,
    });
    window.outputRms = 0;
  });
  await page.evaluate(() => {
    window.host({ type: "answer", text: "CHAT EXAMPLE MUST NOT APPEAR" });
    window.host({
      type: "proposal",
      file: "main.py",
      newText: "CODE MUST STAY IN EDITOR",
    });
    window.host({
      type: "research",
      article: {
        url: "https://docs.python.org/3/",
        title: "Python documentation",
        text: "<script>unsafe()</script>\nOfficial documentation",
      },
    });
    window.host({
      type: "research",
      article: { url: "javascript:alert(1)", title: "Bad link" },
    });
  });
  assert.match(await page.locator("#editStatus").textContent(), /⌘Enter/);
  assert.equal(await page.getByText("CHAT EXAMPLE MUST NOT APPEAR").count(), 0);
  assert.equal(await page.getByText("CODE MUST STAY IN EDITOR").count(), 0);
  assert.equal(await page.locator(".research-page").count(), 1);
  assert.match(await page.locator(".research-body").textContent(), /<script>/);
  assert.equal(await page.locator(".research-body script").count(), 0);
  await page.locator("#showTrace").click();
  assert.ok(
    await page.evaluate(() =>
      window.messages.some((m) => m.type === "showTrace"),
    ),
  );
  await page.locator(".research-source").click();
  assert.ok(
    await page.evaluate(() =>
      window.messages.some(
        (m) =>
          m.type === "openSource" && m.text === "https://docs.python.org/3/",
      ),
    ),
  );

  assert.ok(
    await page.evaluate(() =>
      window.messages.some(
        (m) =>
          m.type === "contextAcknowledged" &&
          m.contextId === 3 &&
          m.endMs === 220,
      ),
    ),
  );
  await page.locator("#mute").click();
  assert.equal(await page.evaluate(() => window.tracks[0].enabled), false);
  await page.evaluate(() =>
    window.peers[0].channel.emit({
      type: "session.input_audio.muted",
      client_event_id: "wrong",
    }),
  );
  assert.equal(await page.locator("#mute").isDisabled(), true);
  await page.evaluate(() =>
    window.peers[0].channel.emit({
      type: "session.input_audio.muted",
      client_event_id: window.sent.at(-1).event_id,
    }),
  );
  assert.equal(await page.locator("#mute").textContent(), "Unmute");
  await page.locator("#mute").click();
  assert.equal(await page.evaluate(() => window.tracks[0].enabled), false);
  await page.evaluate(() =>
    window.peers[0].channel.emit({
      type: "session.input_audio.unmuted",
      client_event_id: window.sent.at(-1).event_id,
    }),
  );
  assert.equal(await page.evaluate(() => window.tracks[0].enabled), true);
  await page.locator("#disconnect").click();
  assert.equal(await page.evaluate(() => window.tracks[0].stopped), true);
  assert.equal(await page.locator("#assistanceLevel").inputValue(), "25");
  await page.locator("#assistanceLevel").fill("0");
  assert.equal(
    await page.locator("#assistanceLabel").textContent(),
    "Voice only",
  );
  await page.locator("#assistanceLevel").dispatchEvent("change");
  assert.ok(
    await page.evaluate(() =>
      window.messages.some(
        (m) => m.type === "assistanceLevel" && m.level === 0,
      ),
    ),
  );
  await page.locator("#assistanceLevel").fill("100");
  assert.equal(
    await page.locator("#assistanceLabel").textContent(),
    "Draft it for me",
  );
  await page.evaluate(() =>
    window.host({
      type: "configuration",
      openaiReady: true,
      backendReady: true,
      provider: "groq",
      assistanceLevel: 25,
    }),
  );
  await page.locator("#connect").click();
  await page.waitForFunction(
    () =>
      window.peers.length === 2 &&
      document.getElementById("voiceStatus").textContent ===
        "Listening · GPT-Live",
  );
  await page.evaluate(() =>
    window.peers[0].channel.emit({
      type: "session.closed",
      usage: { seconds: 15 },
      reason: "old-session",
    }),
  );
  assert.equal(
    await page.locator("#voiceStatus").textContent(),
    "Listening · GPT-Live",
  );
  await page.evaluate(() =>
    window.host({ type: "error", message: "Old replacement failure" }),
  );
  assert.equal(
    await page
      .locator("#error")
      .evaluate((el) => el.classList.contains("hidden")),
    false,
  );
  await page.evaluate(() =>
    window.host({ type: "answer", status: "answer", text: "Recovered" }),
  );
  assert.equal(
    await page
      .locator("#error")
      .evaluate((el) => el.classList.contains("hidden")),
    true,
  );
  await page.evaluate(() =>
    window.peers[1].channel.emit({
      type: "error",
      error: { message: "Voice connection problem" },
    }),
  );
  await page.evaluate(() =>
    window.host({
      type: "answer",
      status: "answer",
      text: "Backend still works",
    }),
  );
  assert.equal(
    await page
      .locator("#error")
      .evaluate((el) => el.classList.contains("hidden")),
    false,
  );
  await page.locator("#followPair").uncheck();
  assert.ok(
    await page.evaluate(() =>
      window.messages.some(
        (m) => m.type === "followPair" && m.enabled === false,
      ),
    ),
  );
  await page.locator("#inlineMode").selectOption("off");
  assert.ok(
    await page.evaluate(() =>
      window.messages.some((m) => m.type === "inlineMode" && m.mode === "off"),
    ),
  );
  await page.locator("#disconnect").click();
  await page.evaluate(() =>
    window.peers[1].channel.emit({
      type: "session.closed",
      usage: { seconds: 8 },
      reason: "client_request",
    }),
  );
  assert.match(await page.locator("#deliveryStatus").textContent(), /8s/);
  assert.deepEqual(errors, []);
  console.log(
    "Panel lifecycle passed: hidden transcripts, research sources, editor-only proposals, context ack, mute matching, old-session isolation, close usage inline controls, typing/playback coalescing, and spoken-target refresh. Simulated transport; no microphone or provider calls.",
  );
} finally {
  await browser.close();
}
