const TOOL_CATALOG = [
  {
    id: "figma",
    name: "Figma",
    description: "UI and UX design",
    iconUrl: "https://static.figma.com/app/icon/1/favicon.svg",
    openUrl: "https://www.figma.com/",
    downloadUrl: "",
    roles: ["UI/UX Designer"],
    enabled: true,
  },
  {
    id: "figjam",
    name: "FigJam",
    description: "Flows, planning and design ideas",
    iconUrl: "https://static.figma.com/app/icon/1/favicon.svg",
    openUrl: "https://www.figma.com/figjam/",
    downloadUrl: "",
    roles: ["UI/UX Designer"],
    enabled: true,
  },
  {
    id: "canva",
    name: "Canva",
    description: "Quick graphics and visual assets",
    iconUrl: "https://static.canva.com/static/images/favicon-1.ico",
    openUrl: "https://www.canva.com/",
    downloadUrl: "",
    roles: ["UI/UX Designer"],
    enabled: true,
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    description: "AI support for ideas and work",
    iconUrl: "https://chatgpt.com/favicon.ico",
    openUrl: "https://chatgpt.com/",
    downloadUrl: "",
    roles: ["UI/UX Designer"],
    enabled: true,
  },
  {
    id: "vscode",
    name: "Visual Studio Code",
    description: "Code editor",
    iconUrl: "https://code.visualstudio.com/favicon.ico",
    openUrl: "https://vscode.dev/",
    downloadUrl: "https://code.visualstudio.com/download",
    roles: ["iOS Developer", "Android Developer"],
    enabled: true,
  },
  {
    id: "github",
    name: "GitHub",
    description: "Code repositories and version control",
    iconUrl: "https://github.githubassets.com/favicons/favicon.svg",
    openUrl: "https://github.com/",
    downloadUrl: "",
    roles: ["iOS Developer", "Android Developer"],
    enabled: true,
  },
  {
    id: "chatgpt-developer",
    name: "ChatGPT",
    description: "AI support for coding and questions",
    iconUrl: "https://chatgpt.com/favicon.ico",
    openUrl: "https://chatgpt.com/",
    downloadUrl: "",
    roles: ["iOS Developer", "Android Developer"],
    enabled: true,
  },
  {
    id: "xcode",
    name: "Xcode",
    description: "Build and test iOS apps",
    iconUrl: "https://developer.apple.com/favicon.ico",
    openUrl: "https://developer.apple.com/xcode/",
    downloadUrl: "https://apps.apple.com/app/xcode/id497799835",
    roles: ["iOS Developer"],
    enabled: true,
  },
  {
    id: "testflight",
    name: "TestFlight",
    description: "Test iOS app builds",
    iconUrl: "https://developer.apple.com/favicon.ico",
    openUrl: "https://developer.apple.com/testflight/",
    downloadUrl: "https://apps.apple.com/app/testflight/id899247664",
    roles: ["iOS Developer"],
    enabled: true,
  },
  {
    id: "android-studio",
    name: "Android Studio",
    description: "Build and test Android apps",
    iconUrl: "https://developer.android.com/static/images/favicons/favicon.png",
    openUrl: "https://developer.android.com/studio",
    downloadUrl: "https://developer.android.com/studio",
    roles: ["Android Developer"],
    enabled: true,
  },
];

const BLOCKED_TOOL_TERMS = [
  "codex",
  "code x",
  "mongodb",
  "database",
  "backend admin",
  "server",
  "stripe secret",
  "environment variable",
  "admin-only",
  "infrastructure",
];

export function listWorkspaceToolsForEmployee(employee) {
  if (!employee || employee.access !== "employee") return [];
  const role = String(employee.title || "").trim();
  return TOOL_CATALOG
    .filter(tool => tool.enabled && tool.roles.includes(role))
    .filter(tool => !isBlockedTool(tool))
    .map(serializeTool);
}

function serializeTool(tool) {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    iconUrl: tool.iconUrl,
    openUrl: tool.openUrl,
    downloadUrl: tool.downloadUrl,
    workAccountEmail: tool.workAccountEmail || "",
    enabled: Boolean(tool.enabled),
  };
}

function isBlockedTool(tool) {
  const text = [tool.id, tool.name, tool.description, tool.openUrl, tool.downloadUrl].join(" | ").toLowerCase();
  return BLOCKED_TOOL_TERMS.some(term => text.includes(term));
}
