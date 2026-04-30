import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-excalidraw-persist-'));
const dbPath = path.join(tmpDir, 'excalidraw.sqlite');

function makePort() {
  return 3210 + Math.floor(Math.random() * 200);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function startServer(port) {
  const child = spawn('node', ['dist/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      EXCALIDRAW_DB_PATH: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    output += chunk.toString();
  });

  return {
    child,
    getOutput: () => output,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

async function waitForServer(baseUrl, child, getOutput) {
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}\n${getOutput()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/diagrams`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry until deadline
    }

    await delay(250);
  }

  throw new Error(`Server did not start in time\n${getOutput()}`);
}

async function stopServer(child, signal = 'SIGTERM') {
  if (child.exitCode !== null) {
    return;
  }

  child.kill(signal);
  await new Promise(resolve => child.once('exit', resolve));
}

async function request(baseUrl, method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function seedDiagram(baseUrl) {
  const created = await request(baseUrl, 'POST', '/api/diagrams', {
    name: 'Persistence Test',
    tags: ['test'],
    description: 'verify persistence',
  });
  const diagramId = created.diagram.id;
  const sessionId = 'session-a';

  await request(baseUrl, 'POST', `/api/elements?diagramId=${encodeURIComponent(diagramId)}`, {
    sessionId,
    id: 'rect-1',
    type: 'rectangle',
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    strokeColor: '#000000',
    backgroundColor: '#ffffff',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    fontSize: 20,
    fontFamily: 2,
    text: 'hello',
  });

  await request(baseUrl, 'POST', `/api/files?diagramId=${encodeURIComponent(diagramId)}`, {
    sessionId,
    files: [{
      id: 'file-1',
      dataURL: 'data:image/png;base64,AA==',
      mimeType: 'image/png',
      created: Date.now(),
    }],
  });

  await request(baseUrl, 'POST', `/api/snapshots?diagramId=${encodeURIComponent(diagramId)}`, {
    sessionId,
    name: 'snap-1',
  });

  await request(baseUrl, 'POST', '/api/sessions/heartbeat', {
    sessionId,
    diagramId,
  });

  return { diagramId, sessionId };
}

async function assertPersistedState(baseUrl, diagramId) {
  const state = await request(baseUrl, 'GET', `/api/diagrams/${encodeURIComponent(diagramId)}/state`);
  assert.equal(state.diagram.id, diagramId);
  assert.equal(state.elements.length, 1);
  assert.equal(state.elements[0].id, 'rect-1');
  assert.equal(state.files.length, 1);
  assert.equal(state.snapshots.some(snapshot => snapshot.name === 'snap-1'), true);
  return state;
}

async function runCleanRestartScenario() {
  const first = startServer(makePort());
  await waitForServer(first.baseUrl, first.child, first.getOutput);
  const { diagramId, sessionId } = await seedDiagram(first.baseUrl);

  const seededState = await assertPersistedState(first.baseUrl, diagramId);
  assert.equal(seededState.sessions.some(session => session.id === sessionId && session.activeDiagramId === diagramId), true);

  await stopServer(first.child, 'SIGTERM');

  const second = startServer(makePort());
  try {
    await waitForServer(second.baseUrl, second.child, second.getOutput);

    const diagrams = await request(second.baseUrl, 'GET', '/api/diagrams');
    assert.equal(diagrams.diagrams.some(diagram => diagram.id === diagramId), true);

    const restartedState = await assertPersistedState(second.baseUrl, diagramId);
    assert.equal(restartedState.sessions.some(session => session.id === sessionId && session.activeDiagramId === diagramId), true);

    const reopenedSessionId = 'session-reopen';
    await request(second.baseUrl, 'POST', '/api/sessions/heartbeat', {
      sessionId: reopenedSessionId,
      diagramId,
    });

    const viaReopenedSession = await request(second.baseUrl, 'GET', `/api/elements?sessionId=${encodeURIComponent(reopenedSessionId)}`);
    assert.equal(viaReopenedSession.elements.length, 1);
    assert.equal(viaReopenedSession.elements[0].id, 'rect-1');

    const restored = await request(second.baseUrl, 'POST', `/api/diagrams/${encodeURIComponent(diagramId)}/restore`, {
      sessionId: reopenedSessionId,
      snapshotName: 'snap-1',
    });
    assert.equal(restored.success, true);
    assert.equal(restored.restoredFrom, 'snap-1');

    const restoredState = await assertPersistedState(second.baseUrl, diagramId);
    assert.equal(restoredState.sessions.some(session => session.id === reopenedSessionId && session.activeDiagramId === diagramId), true);

    return { diagramId, reopenedSessionId };
  } finally {
    await stopServer(second.child, 'SIGTERM');
  }
}

async function runCrashRecoveryScenario() {
  const first = startServer(makePort());
  await waitForServer(first.baseUrl, first.child, first.getOutput);
  const { diagramId } = await seedDiagram(first.baseUrl);

  await stopServer(first.child, 'SIGKILL');

  const second = startServer(makePort());
  try {
    await waitForServer(second.baseUrl, second.child, second.getOutput);
    const state = await assertPersistedState(second.baseUrl, diagramId);

    const reopenedSessionId = 'session-after-crash';
    await request(second.baseUrl, 'POST', '/api/sessions/heartbeat', {
      sessionId: reopenedSessionId,
      diagramId,
    });

    const viaReopenedSession = await request(second.baseUrl, 'GET', `/api/elements?sessionId=${encodeURIComponent(reopenedSessionId)}`);
    assert.equal(viaReopenedSession.elements.length, 1);
    assert.equal(viaReopenedSession.elements[0].id, 'rect-1');
    assert.equal(state.diagram.id, diagramId);

    return { diagramId, reopenedSessionId };
  } finally {
    await stopServer(second.child, 'SIGTERM');
  }
}

const cleanRestart = await runCleanRestartScenario();
const crashRecovery = await runCrashRecoveryScenario();

console.log(JSON.stringify({
  ok: true,
  dbPath,
  cleanRestart,
  crashRecovery,
}, null, 2));
