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
  group: {
    element: HTMLElement;
    titleContainer: HTMLElement;
    editorContainer: HTMLElement;
    activeEditor?: { getName(): string; getDescription(): string | undefined };
  },
  width: number,
  height: number,
) {
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
