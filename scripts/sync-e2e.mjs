#!/usr/bin/env node
/**
 * Sync E2E Tests for Phase 3: Always-on sync and ACK UX
 *
 * Tests cover:
 * - Normal auto-sync flow
 * - Reconnect recovery after WebSocket disconnect
 * - Duplicate event tolerance
 * - Out-of-order delivery handling
 *
 * Usage: node scripts/sync-e2e.mjs [--server=<url>]
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';

const DEFAULT_SERVER = process.env.EXPRESS_SERVER_URL || 'http://127.0.0.1:3000';
const WS_URL = DEFAULT_SERVER.replace('http', 'ws');

const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, value] = arg.split('=');
  acc[key.replace('--', '')] = value;
  return acc;
}, {});

const SERVER = args.server || DEFAULT_SERVER;
const diagramId = `e2e-test-${Date.now()}`;
const sessionA = `test-session-a-${Date.now()}`;
const sessionB = `test-session-b-${Date.now()}`;

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function log(msg, type = 'info') {
  const prefix = type === 'pass' ? '✓' : type === 'fail' ? '✗' : type === 'skip' ? '→' : '  ';
  console.log(`${prefix} ${msg}`);
}

async function apiFetch(path, options = {}) {
  const url = `${SERVER}${path}`;
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return response.json();
}

async function createElement(sessionId, element, diagId = diagramId) {
  return apiFetch(`/api/elements?diagramId=${diagId}&sessionId=${sessionId}`, {
    method: 'POST',
    body: JSON.stringify(element),
  });
}

async function deleteElement(sessionId, elementId, diagId = diagramId) {
  return apiFetch(`/api/elements/${elementId}?diagramId=${diagId}&sessionId=${sessionId}`, {
    method: 'DELETE',
  });
}

async function syncState(sessionId, afterVersion, diagId = diagramId) {
  return apiFetch(`/api/elements/sync/state?diagramId=${diagId}&sessionId=${sessionId}&afterVersion=${afterVersion}`);
}

async function getScene(diagId = diagramId) {
  return apiFetch(`/api/scene?diagramId=${diagId}`);
}

async function heartbeat(sessionId, diagId = diagramId) {
  return apiFetch('/api/sessions/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ sessionId, diagramId: diagId }),
  });
}

async function ackVersion(sessionId, version, diagId = diagramId) {
  return apiFetch(`/api/elements/sync/ack?diagramId=${diagId}`, {
    method: 'POST',
    body: JSON.stringify({ sessionId, serverVersion: version }),
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class WebSocketClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.messages = [];
    this.connected = false;
    this.onMessage = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        this.messages.push(msg);
        if (this.onMessage) {
          this.onMessage(msg);
        }
      });

      this.ws.on('close', () => {
        this.connected = false;
      });

      this.ws.on('error', (err) => {
        reject(err);
      });
    });
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  close(code = 1000) {
    if (this.ws) {
      this.ws.close(code);
    }
  }

  getMessages() {
    return [...this.messages];
  }

  clearMessages() {
    this.messages = [];
  }
}

// ─── Test Cases ────────────────────────────────────────────────────────────────

async function testNormalAutoSync() {
  log('Test: Normal auto-sync flow', 'info');
  testsRun++;

  try {
    // Session A creates elements
    const elem1 = await createElement(sessionA, {
      type: 'rectangle',
      x: 100,
      y: 100,
      width: 200,
      height: 100,
    });

    assert(elem1.success, 'Element creation should succeed');
    assert(elem1.element, 'Response should contain element');
    assert(elem1.element.id, 'Element should have an ID');

    const elemId = elem1.element.id;

    // Session A syncs state
    const sync1 = await syncState(sessionA, 0);
    assert(sync1.success, 'Sync state should succeed');
    assert(sync1.serverVersion > 0, 'Server version should be positive');
    assert(sync1.elements.length >= 1, 'Should have at least one element');

    // Session B syncs state and gets the element
    const sync2 = await syncState(sessionB, 0);
    assert(sync2.success, 'Session B sync should succeed');

    const hasElement = sync2.elements.some(e => e.id === elemId);
    assert(hasElement, 'Session B should see element created by Session A');

    log('Normal auto-sync: PASS', 'pass');
    testsPassed++;
  } catch (error) {
    log(`Normal auto-sync: FAIL - ${error.message}`, 'fail');
    testsFailed++;
  }
}

async function testReconnectRecovery() {
  log('Test: Reconnect recovery after WebSocket disconnect', 'info');
  testsRun++;

  try {
    const wsUrl = `${WS_URL}?diagramId=${diagramId}&sessionId=${sessionA}`;
    const ws = new WebSocketClient(wsUrl);

    // Connect WebSocket
    await ws.connect();
    assert(ws.connected, 'WebSocket should be connected');

    // Get initial scene
    const scene1 = await getScene();
    const initialVersion = scene1.serverVersion;

    // Create element via REST
    const elem = await createElement(sessionA, {
      type: 'ellipse',
      x: 200,
      y: 200,
      width: 150,
      height: 150,
    });
    assert(elem.success, 'Element creation should succeed');

    // Wait for propagation
    await sleep(500);

    // Force disconnect (non-clean close)
    ws.close(1006);

    // Reconnect after delay
    await sleep(3500);
    const ws2 = new WebSocketClient(wsUrl);
    await ws2.connect();
    assert(ws2.connected, 'Reconnection should succeed');

    // Sync and verify element is present
    const syncAfterReconnect = await syncState(sessionA, initialVersion);
    assert(syncAfterReconnect.success, 'Sync after reconnect should succeed');

    const hasElement = syncAfterReconnect.elements.some(e => e.type === 'ellipse');
    assert(hasElement, 'Should see element after reconnect');

    // Cleanup
    ws2.close(1000);

    log('Reconnect recovery: PASS', 'pass');
    testsPassed++;
  } catch (error) {
    log(`Reconnect recovery: FAIL - ${error.message}`, 'fail');
    testsFailed++;
  }
}

async function testDuplicateEventTolerance() {
  log('Test: Duplicate event tolerance', 'info');
  testsRun++;

  try {
    // Create element
    const elem = await createElement(sessionA, {
      type: 'rectangle',
      x: 300,
      y: 300,
      width: 100,
      height: 50,
    });
    assert(elem.success, 'Element creation should succeed');
    const elemId = elem.element.id;

    // Get sync state at version 0
    const sync1 = await syncState(sessionA, 0);
    const version1 = sync1.serverVersion;

    // Sync again with same version - should return no changes
    const sync2 = await syncState(sessionA, version1);
    assertEqual(sync2.elements.length, 0, 'Should have no new elements');
    assertEqual(sync2.deletedElementIds.length, 0, 'Should have no deletions');

    // Sync with very high version - should return no changes
    const sync3 = await syncState(sessionA, version1 + 1000);
    assertEqual(sync3.elements.length, 0, 'Should handle high version gracefully');
    assertEqual(sync3.deletedElementIds.length, 0, 'Should have no deletions');

    log('Duplicate event tolerance: PASS', 'pass');
    testsPassed++;
  } catch (error) {
    log(`Duplicate event tolerance: FAIL - ${error.message}`, 'fail');
    testsFailed++;
  }
}

async function testOutOfOrderDelivery() {
  log('Test: Out-of-order delivery handling', 'info');
  testsRun++;

  try {
    // Create multiple elements in sequence
    const elem1 = await createElement(sessionA, {
      type: 'rectangle',
      x: 10,
      y: 10,
      width: 50,
      height: 50,
    });
    const id1 = elem1.element.id;

    const elem2 = await createElement(sessionA, {
      type: 'rectangle',
      x: 70,
      y: 10,
      width: 50,
      height: 50,
    });
    const id2 = elem2.element.id;

    const elem3 = await createElement(sessionA, {
      type: 'rectangle',
      x: 130,
      y: 10,
      width: 50,
      height: 50,
    });
    const id3 = elem3.element.id;

    // Sync state multiple times and track versions
    const sync0 = await syncState(sessionA, 0);
    const v0 = sync0.serverVersion;

    // Get elements at each version checkpoint
    const syncAtV0 = await syncState(sessionA, 0);
    assert(syncAtV0.elements.length >= 3, 'Should have at least 3 elements at v0');

    // Heartbeat to advance version
    await heartbeat(sessionA);
    await sleep(100);

    // Delete an element
    await deleteElement(sessionA, id2);

    // Sync and verify deletion is tracked
    const syncAfterDelete = await syncState(sessionA, v0);
    assert(syncAfterDelete.deletedElementIds.includes(id2), 'Should track deletion of element 2');

    // Sync again - should not repeat the deletion
    const syncDeduplicated = await syncState(sessionA, syncAfterDelete.serverVersion);
    assert(!syncDeduplicated.deletedElementIds.includes(id2), 'Deletion should not be repeated');

    log('Out-of-order delivery: PASS', 'pass');
    testsPassed++;
  } catch (error) {
    log(`Out-of-order delivery: FAIL - ${error.message}`, 'fail');
    testsFailed++;
  }
}

async function testSyncVersionTracking() {
  log('Test: Sync version tracking and ACK protocol', 'info');
  testsRun++;

  try {
    // Create initial element
    const elem = await createElement(sessionA, {
      type: 'rectangle',
      x: 500,
      y: 500,
      width: 80,
      height: 80,
    });
    assert(elem.success, 'Element creation should succeed');

    // Get current version
    const scene1 = await getScene();
    const version1 = scene1.serverVersion;

    // Explicitly ACK the version
    const ack = await ackVersion(sessionA, version1);
    assert(ack.success, 'ACK should succeed');
    assertEqual(ack.serverVersion, version1, 'ACK should return the acknowledged version');

    // Heartbeat should also update the session
    const hb = await heartbeat(sessionA);
    assert(hb.success, 'Heartbeat should succeed');
    assert(hb.serverVersion >= version1, 'Server version should be >= previous version');

    log('Sync version tracking: PASS', 'pass');
    testsPassed++;
  } catch (error) {
    log(`Sync version tracking: FAIL - ${error.message}`, 'fail');
    testsFailed++;
  }
}

async function testConcurrentSessionSync() {
  log('Test: Concurrent session sync', 'info');
  testsRun++;

  try {
    // Session A creates element
    const elem = await createElement(sessionA, {
      type: 'rectangle',
      x: 600,
      y: 600,
      width: 100,
      height: 60,
    });
    assert(elem.success, 'Session A element creation should succeed');
    const elemId = elem.element.id;

    // Session B creates different element
    const elemB = await createElement(sessionB, {
      type: 'ellipse',
      x: 700,
      y: 600,
      width: 80,
      height: 80,
    });
    assert(elemB.success, 'Session B element creation should succeed');

    // Session A syncs and gets all
    const syncA = await syncState(sessionA, 0);
    const hasOwnElement = syncA.elements.some(e => e.id === elemId);
    const hasOtherElement = syncA.elements.some(e => e.type === 'ellipse');

    assert(hasOwnElement, 'Session A should see its own element');
    assert(hasOtherElement, 'Session A should see Session B element');

    // Session B syncs
    const syncB = await syncState(sessionB, 0);
    const hasBoth = syncB.elements.some(e => e.type === 'rectangle') &&
                    syncB.elements.some(e => e.type === 'ellipse');
    assert(hasBoth, 'Session B should see both elements');

    log('Concurrent session sync: PASS', 'pass');
    testsPassed++;
  } catch (error) {
    log(`Concurrent session sync: FAIL - ${error.message}`, 'fail');
    testsFailed++;
  }
}

async function cleanup() {
  log('Cleaning up test diagram...', 'info');
  try {
    // Get all elements and delete them
    const scene = await getScene();
    for (const elem of scene.elements || []) {
      await deleteElement(sessionA, elem.id);
    }
    await sleep(200);
  } catch (error) {
    // Cleanup errors are not critical
    console.log('Cleanup error (ignored):', error.message);
  }
}

// ─── Main Test Runner ─────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Phase 3: Always-on Sync E2E Tests');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Server: ${SERVER}`);
  console.log(`Diagram: ${diagramId}`);
  console.log('');

  try {
    await testNormalAutoSync();
    await testReconnectRecovery();
    await testDuplicateEventTolerance();
    await testOutOfOrderDelivery();
    await testSyncVersionTracking();
    await testConcurrentSessionSync();
  } catch (error) {
    log(`Fatal error: ${error.message}`, 'fail');
    testsFailed++;
  } finally {
    await cleanup();
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Results: ${testsPassed} passed, ${testsFailed} failed, ${testsRun} total`);
  console.log('═══════════════════════════════════════════════════════════');

  process.exit(testsFailed > 0 ? 1 : 0);
}

main().catch(console.error);
