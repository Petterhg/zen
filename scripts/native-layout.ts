/** Monaco receives the same dimensions as its inset DOM box. No duplicate file heading. */
export function zenEditorGeometry(width: number, height: number) {
  const inset = width < 500 ? 12 : 28;
  return {
    inset,
    heading: 0,
    width: Math.max(0, width - inset * 2),
    height: Math.max(0, height),
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
  };
  const geometry = zenEditorGeometry(width, height);
  group.element.querySelector(":scope > .zen-file-heading")?.remove();
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

/** Native title-bar navigation; pairing itself lives only in the workboard. */
export function zenLayoutPart(
  candidate: unknown,
  _width: number,
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
    !root?.classList.contains("titlebar") ||
    !part.instantiationService ||
    !part.contextKeyService
  )
    return height;
  if (!root.querySelector(".zen-workboard-toggle")) {
    const button = root.ownerDocument.createElement("button");
    button.className = "zen-workboard-toggle";
    button.textContent = "Workboard";
    button.title = "Show or hide your pair (⌘⌥J)";
    button.setAttribute("aria-label", "Toggle workboard");
    const update = () =>
      button.setAttribute(
        "aria-expanded",
        String(part.layoutService.isVisible("workbench.parts.auxiliarybar")),
      );
    button.addEventListener("click", () => {
      void part
        .instantiationService!.invokeFunction((accessor) =>
          accessor
            .get(commandServiceId)
            .executeCommand("pairCode.toggleWorkboard"),
        )
        .then(update, () => {});
    });
    root.appendChild(button);
    const listener = part.contextKeyService.onDidChangeContext(update);
    part._register?.({
      dispose() {
        listener.dispose();
        button.remove();
      },
    });
    update();
  }
  return height;
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
