import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { transformSync } from "esbuild";

function replace(file, before, after, marker) {
  const text = readFileSync(file, "utf8");
  if (text.includes(marker)) return;
  if (text.split(before).length !== 2)
    throw new Error(`Native layout patch no longer matches ${file}`);
  writeFileSync(file, text.replace(before, after));
}
export function patchRuntimeLayout(resources) {
  const file = path.join(
    resources,
    "out/vs/workbench/workbench.desktop.main.js",
  );
  const mainFile = path.join(resources, "out/main.js");
  replace(
    mainFile,
    'this._win=new Vi.BrowserWindow(Ee),Ge("code/didCreateCodeBrowserWindow")',
    'this._win=new Vi.BrowserWindow(Ee),process.platform==="darwin"&&this._win.setWindowButtonVisibility(false),Ge("code/didCreateCodeBrowserWindow")',
    'process.platform==="darwin"&&this._win.setWindowButtonVisibility(false)',
  );
  replace(
    file,
    'getHeight(i){return 22}getTemplateId(i){return"FileStat"}',
    'getHeight(i){return 28}getTemplateId(i){return"FileStat"}',
    'getHeight(i){return 28}getTemplateId(i){return"FileStat"}',
  );
  const helper = transformSync(
    readFileSync(
      new URL("./native-layout.ts", import.meta.url),
      "utf8",
    ).replaceAll("export function", "function"),
    { loader: "ts", target: "es2022" },
  ).code;
  const text = readFileSync(file, "utf8");
  const start = "/* zen-layout:start */",
    end = "/* zen-layout:end */";
  const expression =
    /\/\* zen-layout:start \*\/[\s\S]*?\/\* zen-layout:end \*\//;
  const block = `${start}\n${helper}\n${end}`;
  writeFileSync(
    file,
    text.includes(start)
      ? text.replace(expression, block)
      : text + "\n" + block,
  );
  replace(
    file,
    'this.element.classList.toggle("max-height-478px",t<=478);const o=this.titleControl.layout',
    'this.element.classList.toggle("max-height-478px",t<=478);const zenGeometry=zenLayoutGroup(this,e,t);e=zenGeometry.width;t=zenGeometry.height;s+=zenGeometry.heading;n+=zenGeometry.inset;const o=this.titleControl.layout',
    "const zenGeometry=zenLayoutGroup",
  );
  replace(
    file,
    "let t=this.isCommandCenterVisible||e?Jxe:30;",
    "let t=54;/* zen-titlebar-height */",
    "/* zen-titlebar-height */",
  );
  replace(
    file,
    "Ti.SIDEBAR_SIZE.defaultValue=Math.min(300,o.width/4)",
    "Ti.SIDEBAR_SIZE.defaultValue=Math.min(196,o.width/4)",
    "Ti.SIDEBAR_SIZE.defaultValue=Math.min(196",
  );
  replace(
    file,
    "Ti.AUXILIARYBAR_SIZE.defaultValue=s?Math.max(300,o.width/2):Math.min(300,o.width/4)",
    "Ti.AUXILIARYBAR_SIZE.defaultValue=s?Math.max(325,o.width/2):Math.min(325,o.width/3)",
    "Ti.AUXILIARYBAR_SIZE.defaultValue=s?Math.max(325",
  );
  replace(
    file,
    "Ti.SIDEBAR_SIZE.defaultValue=Math.min(196,o.width/4)",
    '(()=>{if(!this.storageService.getBoolean("zen.layout.reference.v1",0,false)){this.stateCache.set(Ti.SIDEBAR_SIZE.name,Math.min(196,o.width/4));this.stateCache.set(Ti.AUXILIARYBAR_SIZE.name,Math.min(325,o.width/3));this.stateCache.set(Ti.PANEL_SIZE.name,Math.min(210,o.height/3));this.storageService.store("zen.layout.reference.v1",true,0,1)}})(),Ti.SIDEBAR_SIZE.defaultValue=Math.min(196,o.width/4)',
    'getBoolean("zen.layout.reference.v1"',
  );
  replace(
    file,
    "(this.isCommandCenterVisible?Jxe:this.macTitlebarSize)/(this.preventZoom?c_(ye(this.element)):1)",
    "Math.max(54,this.macTitlebarSize)/(this.preventZoom?c_(ye(this.element)):1)",
    "Math.max(54,this.macTitlebarSize)",
  );
  replace(
    file,
    "layoutContents(i,e){return Ui(this.partLayout).layout(i,e)}",
    "layoutContents(i,e){return Ui(this.partLayout).layout(i,zenLayoutPart(this,i,e,Ie))}",
    "zenLayoutPart(this,i,e,Ie)",
  );
  replace(
    file,
    "Ti.SIDEBAR_SIZE.defaultValue=Math.min(196,o.width/4)",
    '(()=>{if(!this.storageService.getBoolean("zen.chrome.v2",0,false)){const key="workbench.panel.pinnedPanels";this.storageService.store(key,zenQuietPanelPins(this.storageService.get(key,0,"[]")),0,0);this.storageService.store("zen.chrome.v2",true,0,1)}})(),Ti.SIDEBAR_SIZE.defaultValue=Math.min(196,o.width/4)',
    'getBoolean("zen.chrome.v2"',
  );
}
export function patchSourceLayout(source) {
  replace(
    path.join(source, "src/vs/platform/windows/electron-main/windowImpl.ts"),
    "this._win = new electron.BrowserWindow(options);",
    'this._win = new electron.BrowserWindow(options);\n\t\t\tif (process.platform === "darwin") this._win.setWindowButtonVisibility(false);',
    "this._win.setWindowButtonVisibility(false)",
  );
  replace(
    path.join(
      source,
      "src/vs/workbench/contrib/files/browser/views/explorerViewer.ts",
    ),
    "static readonly ITEM_HEIGHT = 22;",
    "static readonly ITEM_HEIGHT = 28; // zen-explorer-spacing",
    "// zen-explorer-spacing",
  );
  const partFile = path.join(source, "src/vs/workbench/browser/part.ts");
  const partText = readFileSync(partFile, "utf8");
  if (!partText.includes("import { zenLayoutPart }"))
    writeFileSync(
      partFile,
      "import { zenLayoutPart } from './parts/editor/zenLayout.js';\nimport { ICommandService } from '../../platform/commands/common/commands.js';\n" +
        partText,
    );
  replace(
    partFile,
    "return partLayout.layout(width, height);",
    "return partLayout.layout(width, zenLayoutPart(this, width, height, ICommandService));",
    "zenLayoutPart(this, width, height, ICommandService)",
  );
  const layoutFile = path.join(source, "src/vs/workbench/browser/layout.ts");
  const layoutText = readFileSync(layoutFile, "utf8");
  if (!layoutText.includes("import { zenQuietPanelPins }"))
    writeFileSync(
      layoutFile,
      "import { zenQuietPanelPins } from './parts/editor/zenLayout.js';\n" +
        layoutText,
    );
  replace(
    path.join(
      source,
      "src/vs/workbench/electron-browser/parts/titlebar/titlebarPart.ts",
    ),
    "(this.isCommandCenterVisible ? DEFAULT_CUSTOM_TITLEBAR_HEIGHT : this.macTitlebarSize) /",
    "Math.max(54, DEFAULT_CUSTOM_TITLEBAR_HEIGHT, this.macTitlebarSize) /",
    "Math.max(54, DEFAULT_CUSTOM_TITLEBAR_HEIGHT, this.macTitlebarSize)",
  );
  replace(
    path.join(
      source,
      "src/vs/workbench/browser/parts/titlebar/titlebarPart.ts",
    ),
    "let value = this.isCommandCenterVisible || wcoEnabled ? DEFAULT_CUSTOM_TITLEBAR_HEIGHT : 30;",
    "let value = Math.max(54, DEFAULT_CUSTOM_TITLEBAR_HEIGHT); // zen-titlebar-height",
    "// zen-titlebar-height",
  );
  replace(
    path.join(source, "src/vs/workbench/browser/layout.ts"),
    "LayoutStateKeys.SIDEBAR_SIZE.defaultValue = Math.min(300, mainContainerDimension.width / 4);",
    "LayoutStateKeys.SIDEBAR_SIZE.defaultValue = Math.min(196, mainContainerDimension.width / 4);",
    "SIDEBAR_SIZE.defaultValue = Math.min(196",
  );
  replace(
    path.join(source, "src/vs/workbench/browser/layout.ts"),
    "LayoutStateKeys.AUXILIARYBAR_SIZE.defaultValue = auxiliaryBarForceMaximized ? Math.max(300, mainContainerDimension.width / 2) : Math.min(300, mainContainerDimension.width / 4);",
    "LayoutStateKeys.AUXILIARYBAR_SIZE.defaultValue = auxiliaryBarForceMaximized ? Math.max(325, mainContainerDimension.width / 2) : Math.min(325, mainContainerDimension.width / 3);",
    "AUXILIARYBAR_SIZE.defaultValue = auxiliaryBarForceMaximized ? Math.max(325",
  );
  replace(
    path.join(source, "src/vs/workbench/browser/layout.ts"),
    "LayoutStateKeys.SIDEBAR_SIZE.defaultValue = Math.min(196, mainContainerDimension.width / 4);",
    `if (!this.storageService.getBoolean('zen.layout.reference.v1', StorageScope.PROFILE, false)) {
      this.stateCache.set(LayoutStateKeys.SIDEBAR_SIZE.name, Math.min(196, mainContainerDimension.width / 4));
      this.stateCache.set(LayoutStateKeys.AUXILIARYBAR_SIZE.name, Math.min(325, mainContainerDimension.width / 3));
      this.stateCache.set(LayoutStateKeys.PANEL_SIZE.name, Math.min(210, mainContainerDimension.height / 3));
      this.storageService.store('zen.layout.reference.v1', true, StorageScope.PROFILE, StorageTarget.MACHINE);
    }
    LayoutStateKeys.SIDEBAR_SIZE.defaultValue = Math.min(196, mainContainerDimension.width / 4);`,
    "getBoolean('zen.layout.reference.v1'",
  );
  replace(
    layoutFile,
    "LayoutStateKeys.SIDEBAR_SIZE.defaultValue = Math.min(196, mainContainerDimension.width / 4);",
    `if (!this.storageService.getBoolean('zen.chrome.v2', StorageScope.PROFILE, false)) {
      const key = 'workbench.panel.pinnedPanels';
      this.storageService.store(key, zenQuietPanelPins(this.storageService.get(key, StorageScope.PROFILE, '[]')), StorageScope.PROFILE, StorageTarget.USER);
      this.storageService.store('zen.chrome.v2', true, StorageScope.PROFILE, StorageTarget.MACHINE);
    }
    LayoutStateKeys.SIDEBAR_SIZE.defaultValue = Math.min(196, mainContainerDimension.width / 4);`,
    "getBoolean('zen.chrome.v2'",
  );
  const directory = path.join(source, "src/vs/workbench/browser/parts/editor");
  copyFileSync(
    new URL("./native-layout.ts", import.meta.url),
    path.join(directory, "zenLayout.ts"),
  );
  const file = path.join(directory, "editorGroupView.ts");
  const oldGroup =
    "zenLayoutGroup({ element: this.element, titleContainer: this.titleContainer, editorContainer: this.editorContainer, activeEditor: this.activeEditor ?? undefined }, width, height)";
  writeFileSync(
    file,
    readFileSync(file, "utf8").replace(
      oldGroup,
      "zenLayoutGroup(this, width, height)",
    ),
  );
  const content = readFileSync(file, "utf8");
  if (!content.includes("import { zenLayoutGroup }"))
    writeFileSync(
      file,
      "import { zenLayoutGroup } from './zenLayout.js';\n" + content,
    );
  replace(
    file,
    "this.element.classList.toggle('max-height-478px', height <= 478);",
    "this.element.classList.toggle('max-height-478px', height <= 478);\n\t\tconst zenGeometry = zenLayoutGroup(this, width, height);\n\t\twidth = zenGeometry.width; height = zenGeometry.height; top += zenGeometry.heading; left += zenGeometry.inset;",
    "const zenGeometry = zenLayoutGroup",
  );
}
