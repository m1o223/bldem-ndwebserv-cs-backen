import test from "node:test";
import assert from "node:assert/strict";
import { createHealthServer } from "../src/server.js";
import { createAdminSession } from "../src/adminAuth.js";
import { listWorkspaceToolsForEmployee } from "../src/workspaceTools.js";

const env = {
  ALLOWED_ORIGINS: "http://localhost:3010,https://admin-bluemindwebservice.vercel.app",
  NODE_ENV: "development",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_M_PASSWORD_HASH: "$2a$10$placeholder",
  ADMIN_R_PASSWORD_HASH: "$2a$10$placeholder",
  ADMIN_SESSION_SECRET: "test-secret-with-at-least-thirty-two-characters",
};

const blockedTerms = [
  "codex",
  "code x",
  "mongodb",
  "database",
  "backend",
  "server",
  "stripe",
  "environment",
  "admin",
  "infrastructure",
];

function namesFor(role) {
  return listWorkspaceToolsForEmployee({ access: "employee", title: role }).map(tool => tool.name);
}

function assertNoBlockedTools(tools) {
  const serialized = JSON.stringify(tools).toLowerCase();
  for (const term of blockedTerms) {
    assert.equal(serialized.includes(term), false, `tool response should not expose ${term}`);
  }
}

async function withServer(run) {
  const server = createHealthServer(env);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("workspace tools are role-specific and exclude internal systems", () => {
  assert.deepEqual(namesFor("UI/UX Designer"), ["Figma", "FigJam", "Canva", "ChatGPT"]);
  assert.deepEqual(namesFor("iOS Developer"), ["Visual Studio Code", "GitHub", "ChatGPT", "Xcode", "TestFlight"]);
  assert.deepEqual(namesFor("Android Developer"), ["Visual Studio Code", "GitHub", "ChatGPT", "Android Studio"]);
  assert.deepEqual(listWorkspaceToolsForEmployee({ access: "admin", title: "Admin" }), []);
  assert.deepEqual(listWorkspaceToolsForEmployee({ access: "employee", title: "Unknown" }), []);

  assertNoBlockedTools(listWorkspaceToolsForEmployee({ access: "employee", title: "UI/UX Designer" }));
  assertNoBlockedTools(listWorkspaceToolsForEmployee({ access: "employee", title: "iOS Developer" }));
  assertNoBlockedTools(listWorkspaceToolsForEmployee({ access: "employee", title: "Android Developer" }));
});

test("workspace tools endpoint uses the authenticated employee role", async () => {
  await withServer(async base => {
    const ahmedSession = createAdminSession(env, {
      access: "employee",
      email: "ahmed@bluemind.com",
      employeeId: "AHMED",
      displayName: "Ahmed",
      title: "iOS Developer",
    });
    const ammarSession = createAdminSession(env, {
      access: "employee",
      email: "ammar@bluemind.com",
      employeeId: "AMMAR",
      displayName: "Ammar",
      title: "UI/UX Designer",
    });

    const headers = session => ({ Cookie: `bluemind_admin_session=${encodeURIComponent(session)}` });

    const iOSResponse = await fetch(`${base}/api/workspace/tools`, { headers: headers(ahmedSession) });
    assert.equal(iOSResponse.status, 200);
    const iOSJson = await iOSResponse.json();
    assert.deepEqual(iOSJson.tools.map(tool => tool.name), ["Visual Studio Code", "GitHub", "ChatGPT", "Xcode", "TestFlight"]);
    assert.equal(iOSJson.tools.some(tool => tool.name === "Android Studio"), false);
    assert.equal(iOSJson.tools.some(tool => tool.name === "Figma"), false);

    const designerResponse = await fetch(`${base}/api/employee/tools`, { headers: headers(ammarSession) });
    assert.equal(designerResponse.status, 200);
    const designerJson = await designerResponse.json();
    assert.deepEqual(designerJson.tools.map(tool => tool.name), ["Figma", "FigJam", "Canva", "ChatGPT"]);
    assertNoBlockedTools(designerJson.tools);

    const unauthenticated = await fetch(`${base}/api/workspace/tools`);
    assert.equal(unauthenticated.status, 401);
  });
});
