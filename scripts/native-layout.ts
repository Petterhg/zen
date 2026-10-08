/** Shared native geometry. Monaco receives the same dimensions as its DOM box. */
export function zenEditorGeometry(width: number, height: number) {
  const inset = width < 500 ? 12 : 28;
  const heading = height < 360 ? 48 : 96;
  return {
    inset,
    heading,
    width: Math.max(0, width - inset * 2),
    height: Math.max(0, height - heading),
  };
}

export function zenLayoutGroup(
  candidate: unknown,
  width: number,
  height: number,
) {
  const group = candidate as {
    element: HTMLElement;
    titleContainer: HTMLElement;
    editorContainer: HTMLElement;
    activeEditor?: { getName(): string; getDescription(): string | undefined };
    _register?(disposable: { dispose(): void }): void;
  };
  const geometry = zenEditorGeometry(width, height);
  let heading = group.element.querySelector<HTMLElement>(
    ":scope > .zen-file-heading",
  );
  if (!heading) {
    heading = group.element.ownerDocument.createElement("section");
    heading.className = "zen-file-heading";
    heading.setAttribute("aria-label", "Current file");
    const label = heading.ownerDocument.createElement("span");
    label.className = "zen-eyebrow";
    label.textContent = "CURRENT FILE";
    const title = heading.ownerDocument.createElement("h2");
    const description = heading.ownerDocument.createElement("p");
    heading.append(label, title, description);
    group.element.insertBefore(heading, group.titleContainer);
    const refresh = () => {
      const title = group.activeEditor?.getName() ?? "Your workspace";
      const description =
        group.activeEditor?.getDescription() ?? "One file, one step at a time.";
      if (heading!.querySelector("h2")!.textContent !== title)
        heading!.querySelector("h2")!.textContent = title;
      if (heading!.querySelector("p")!.textContent !== description)
        heading!.querySelector("p")!.textContent = description;
    };
    const observer = new MutationObserver(refresh);
    observer.observe(group.titleContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    group._register?.({ dispose: () => observer.disconnect() });
  }
  heading.style.height = geometry.heading + "px";
  heading.style.paddingLeft = heading.style.paddingRight =
    geometry.inset + "px";
  heading.classList.toggle("compact", height < 360);
  heading.querySelector("h2")!.textContent =
    group.activeEditor?.getName() ?? "Your workspace";
  heading.querySelector("p")!.textContent =
    group.activeEditor?.getDescription() ?? "One file, one step at a time.";
  group.titleContainer.style.marginLeft =
    group.titleContainer.style.marginRight = geometry.inset + "px";
  group.titleContainer.style.width = geometry.width + "px";
  group.editorContainer.style.marginLeft =
    group.editorContainer.style.marginRight = geometry.inset + "px";
  return geometry;
}

type ZenDisposable = { dispose(): void };
type ZenContext = {
  getContextKeyValue(key: string): unknown;
  onDidChangeContext(listener: () => void): ZenDisposable;
};
type ZenPart = {
  getContainer(): HTMLElement | undefined;
  contextKeyService?: ZenContext;
  layoutService: { isVisible(id: string): boolean; getPanelPosition(): number };
  instantiationService?: {
    invokeFunction<T>(
      fn: (accessor: {
        get(id: unknown): { executeCommand(id: string): Promise<unknown> };
      }) => T,
    ): T;
  };
  getMemento?(scope: number, target: number): Record<string, unknown>;
  viewDescriptorService?: {
    getViewContainerById(id: string): unknown;
    getViewContainerModel(container: unknown): {
      allViewDescriptors: ReadonlyArray<{ id: string }>;
      setVisible(id: string, visible: boolean): void;
    };
  };
  _register?(disposable: ZenDisposable): ZenDisposable;
};
type ZenStrip = { element: HTMLElement; context: ZenContext; update(): void };
const zenStrips = new WeakMap<Document, ZenStrip>();

/** Used by Part.layoutContents: reserve space before Monaco/xterm receive sizes. */
export function zenLayoutPart(
  candidate: unknown,
  width: number,
  height: number,
  commandServiceId: unknown,
): number {
  const part = candidate as ZenPart;
  const root = part.getContainer();
  if (
    root?.classList.contains("sidebar") &&
    part.viewDescriptorService &&
    part.getMemento
  ) {
    const saved = part.getMemento(0, 1);
    if (!saved.zenQuietExplorerV1) {
      const container = part.viewDescriptorService.getViewContainerById(
        "workbench.view.explorer",
      );
      if (container) {
        const model =
          part.viewDescriptorService.getViewContainerModel(container);
        if (
          ["outline", "timeline"].every((id) =>
            model.allViewDescriptors.some((view) => view.id === id),
          )
        ) {
          saved.zenQuietExplorerV1 = true;
          // Defer visibility changes until this layout transaction finishes.
          queueMicrotask(() => {
            model.setVisible("outline", false);
            model.setVisible("timeline", false);
          });
        }
      }
    }
  }
  if (
    !root ||
    !part.contextKeyService ||
    !part.instantiationService ||
    root.classList.contains("modal-editor-part")
  )
    return height;
  const isEditor = root.classList.contains("editor");
  const isPanel = root.classList.contains("panel");
  if (!isEditor && !isPanel) return height;
  const bottomPanel =
    part.layoutService.isVisible("workbench.parts.panel") &&
    part.layoutService.getPanelPosition() === 2;
  if ((bottomPanel && !isPanel) || (!bottomPanel && !isEditor)) return height;
  let strip = zenStrips.get(root.ownerDocument);
  if (!strip) {
    const doc = root.ownerDocument;
    const element = doc.createElement("section");
    element.className = "zen-pairing-strip";
    element.setAttribute("aria-label", "Pairing controls");
    const primary = doc.createElement("button");
    primary.className = "zen-strip-primary";
    const end = doc.createElement("button");
    end.textContent = "End";
    end.title = "End voice session";
    const status = doc.createElement("span");
    status.className = "zen-strip-status";
    status.setAttribute("aria-live", "polite");
    const terminal = doc.createElement("button");
    terminal.textContent = "Terminal";
    terminal.className = "zen-strip-secondary";
    const assistance = doc.createElement("button");
    assistance.title = "Choose how much your pair does";
    const board = doc.createElement("button");
    board.textContent = "Workboard";
    board.title = "Fold or restore workboard";
    const context = part.contextKeyService;
    const execute = (id: string) => {
      void part
        .instantiationService!.invokeFunction((accessor) =>
          accessor.get(commandServiceId).executeCommand(id),
        )
        .catch(() => {
          status.textContent = "Control unavailable · open the workboard";
        });
    };
    primary.addEventListener("click", () => {
      const state = context.getContextKeyValue("zen.voiceState");
      execute(
        state === "listening" || state === "muted"
          ? "pairCode.toggleVoiceMute"
          : "pairCode.startVoice",
      );
    });
    end.addEventListener("click", () => execute("pairCode.endVoice"));
    assistance.addEventListener("click", () =>
      execute("pairCode.chooseAssistance"),
    );
    terminal.addEventListener("click", () =>
      execute("workbench.action.terminal.toggleTerminal"),
    );
    board.addEventListener("click", () => execute("pairCode.toggleWorkboard"));
    element.append(primary, end, status, terminal, assistance, board);
    const update = () => {
      const state = context.getContextKeyValue("zen.voiceState");
      const available = context.getContextKeyValue("zen.available") === true;
      const connected = state === "listening" || state === "muted";
      primary.textContent =
        state === "muted"
          ? "Unmute"
          : state === "listening"
            ? "Mute microphone"
            : state === "connecting"
              ? "Connecting…"
              : "Start pairing";
      primary.disabled = !available || state === "connecting";
      end.hidden = !connected && state !== "connecting";
      assistance.disabled = board.disabled = !available;
      status.textContent = !available
        ? "Open a trusted workspace to pair"
        : state === "listening"
          ? "Listening · here with you"
          : state === "muted"
            ? "Microphone muted"
            : state === "connecting"
              ? "Connecting voice"
              : "Ready when you are";
      const level = Number(
        context.getContextKeyValue("zen.assistanceLevel") ?? 25,
      );
      assistance.textContent =
        (level === 0
          ? "Voice only"
          : level < 40
            ? "One small step"
            : level < 75
              ? "Work together"
              : "Draft it for me") + " ▾";
      element.dataset.voiceState =
        typeof state === "string" ? state : "disconnected";
    };
    strip = { element, context, update };
    zenStrips.set(doc, strip);
    const listener = context.onDidChangeContext(update);
    part._register?.({
      dispose() {
        listener.dispose();
        element.remove();
        zenStrips.delete(doc);
      },
    });
    update();
  }
  if (strip.element.parentElement !== root) root.appendChild(strip.element);
  strip.element.classList.toggle("narrow", width < 650);
  strip.element.classList.toggle("compact", width < 420);
  return Math.max(0, height - 44);
}

/** Only stock auxiliary tabs are unpinned. Custom tools and saved order survive. */
export function zenQuietPanelPins(serialized: string): string {
  try {
    const entries: Array<{ id: string; pinned?: boolean; visible?: boolean }> =
      JSON.parse(serialized);
    if (
      !Array.isArray(entries) ||
      entries.some((entry) => !entry || typeof entry.id !== "string")
    )
      return serialized;
    const secondary = [
      "workbench.panel.markers",
      "workbench.panel.output",
      "workbench.panel.repl",
      "~remote.forwardedPortsContainer",
    ];
    const next = entries.map((entry) =>
      secondary.includes(entry.id) ? { ...entry, pinned: false } : entry,
    );
    for (const id of secondary)
      if (!next.some((entry) => entry.id === id))
        next.push({ id, pinned: false, visible: true });
    return JSON.stringify(next);
  } catch {
    return serialized;
  }
}
