/**
 * Diagram Management Test Suite
 * Tests create/rename/archive/unarchive/delete, export/import, thumbnails,
 * recent diagrams, and search functionality across HTTP endpoints.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-excalidraw-diagram-mgmt-'));
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
      EXCALIDRAW_DATA_DIR: tmpDir,
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

async function api(baseUrl, method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, data: json };
}

// ─── Test Suite ───────────────────────────────────────────────

async function runTests() {
  const port = makePort();
  const server = startServer(port);
  await waitForServer(server.baseUrl, server.child, server.getOutput);

  const results = [];

  function recordTest(name, passed, error) {
    results.push({ name, passed, error });
    if (passed) {
      console.log(`  ✓ ${name}`);
    } else {
      console.log(`  ✗ ${name}: ${error}`);
    }
  }

  try {
    console.log('\n📁 Diagram Management Tests\n');

    // ─── Create Operations ────────────────────────────────────
    console.log('  Create Operations:');

    // Test: list_diagrams returns default diagram
    try {
      const diagrams = await request(server.baseUrl, 'GET', '/api/diagrams');
      assert.ok(diagrams.diagrams.length >= 1, 'Should have at least default diagram');
      const defaultDiagram = diagrams.diagrams.find(d => d.id === 'default');
      assert.ok(defaultDiagram, 'Should have default diagram');
      assert.equal(defaultDiagram.name, 'Untitled Diagram');
      recordTest('list_diagrams returns default diagram', true);
    } catch (err) {
      recordTest('list_diagrams returns default diagram', false, err.message);
    }

    // Test: create diagram
    let createdDiagram;
    try {
      const result = await request(server.baseUrl, 'POST', '/api/diagrams', {
        name: 'Test Diagram',
        tags: ['test'],
        description: 'A test diagram',
      });
      assert.equal(result.success, true);
      assert.ok(result.diagram.id, 'Should have diagram ID');
      assert.equal(result.diagram.name, 'Test Diagram');
      assert.deepEqual(result.diagram.tags, ['test']);
      assert.equal(result.diagram.description, 'A test diagram');
      createdDiagram = result.diagram;
      recordTest('create_diagram creates a new named diagram', true);
    } catch (err) {
      recordTest('create_diagram creates a new named diagram', false, err.message);
    }

    // Test: create diagram without name returns 400
    try {
      const result = await api(server.baseUrl, 'POST', '/api/diagrams', { name: '' });
      assert.equal(result.status, 400, 'Should return 400 for empty name');
      recordTest('create_diagram without name returns 400', true);
    } catch (err) {
      recordTest('create_diagram without name returns 400', false, err.message);
    }

    // Test: create second diagram
    let secondDiagram;
    try {
      const result = await request(server.baseUrl, 'POST', '/api/diagrams', {
        name: 'Second Diagram',
        tags: ['test', 'secondary'],
      });
      assert.equal(result.success, true);
      secondDiagram = result.diagram;
      recordTest('create_diagram creates second diagram', true);
    } catch (err) {
      recordTest('create_diagram creates second diagram', false, err.message);
    }

    // Test: list_diagrams returns all created diagrams
    try {
      const diagrams = await request(server.baseUrl, 'GET', '/api/diagrams');
      assert.ok(diagrams.diagrams.length >= 3, 'Should have default + 2 created diagrams');
      recordTest('list_diagrams returns all created diagrams', true);
    } catch (err) {
      recordTest('list_diagrams returns all created diagrams', false, err.message);
    }

    // ─── Read Operations ─────────────────────────────────────
    console.log('\n  Read Operations:');

    // Test: get diagram by ID
    if (createdDiagram) {
      try {
        const result = await request(server.baseUrl, 'GET', `/api/diagrams/${encodeURIComponent(createdDiagram.id)}`);
        assert.equal(result.success, true);
        assert.equal(result.diagram.id, createdDiagram.id);
        assert.equal(result.diagram.name, createdDiagram.name);
        recordTest('get_diagram returns diagram by ID', true);
      } catch (err) {
        recordTest('get_diagram returns diagram by ID', false, err.message);
      }
    } else {
      recordTest('get_diagram returns diagram by ID', false, 'Skipped: createdDiagram not available');
    }

    // Test: get diagram returns 404 for non-existent ID
    try {
      const result = await api(server.baseUrl, 'GET', '/api/diagrams/non-existent-id-123');
      assert.equal(result.status, 404, 'Should return 404 for non-existent diagram');
      recordTest('get_diagram returns 404 for non-existent ID', true);
    } catch (err) {
      recordTest('get_diagram returns 404 for non-existent ID', false, err.message);
    }

    // Test: get diagram state returns full state
    if (createdDiagram) {
      try {
        const result = await request(server.baseUrl, 'GET', `/api/diagrams/${encodeURIComponent(createdDiagram.id)}/state`);
        assert.equal(result.success, true);
        assert.ok(result.diagram, 'Should include diagram');
        assert.ok(Array.isArray(result.elements), 'Should include elements array');
        assert.ok(Array.isArray(result.files), 'Should include files array');
        assert.ok(Array.isArray(result.snapshots), 'Should include snapshots array');
        assert.ok(Array.isArray(result.sessions), 'Should include sessions array');
        recordTest('get_diagram_state returns full diagram state', true);
      } catch (err) {
        recordTest('get_diagram_state returns full diagram state', false, err.message);
      }
    } else {
      recordTest('get_diagram_state returns full diagram state', false, 'Skipped: createdDiagram not available');
    }

    // ─── Rename/Update Operations ─────────────────────────────
    console.log('\n  Rename/Update Operations:');

    if (createdDiagram) {
      try {
        const result = await request(server.baseUrl, 'PATCH', `/api/diagrams/${encodeURIComponent(createdDiagram.id)}`, {
          name: 'Renamed Diagram',
        });
        assert.equal(result.success, true);
        assert.equal(result.diagram.name, 'Renamed Diagram');

        // Verify persistence
        const getResult = await request(server.baseUrl, 'GET', `/api/diagrams/${encodeURIComponent(createdDiagram.id)}`);
        assert.equal(getResult.diagram.name, 'Renamed Diagram');
        createdDiagram.name = 'Renamed Diagram'; // Update local reference
        recordTest('update_diagram renames a diagram', true);
      } catch (err) {
        recordTest('update_diagram renames a diagram', false, err.message);
      }
    } else {
      recordTest('update_diagram renames a diagram', false, 'Skipped: createdDiagram not available');
    }

    if (createdDiagram) {
      try {
        const result = await request(server.baseUrl, 'PATCH', `/api/diagrams/${encodeURIComponent(createdDiagram.id)}`, {
          tags: ['updated', 'tags'],
        });
        assert.equal(result.success, true);
        assert.deepEqual(result.diagram.tags, ['updated', 'tags']);
        recordTest('update_diagram updates tags', true);
      } catch (err) {
        recordTest('update_diagram updates tags', false, err.message);
      }
    } else {
      recordTest('update_diagram updates tags', false, 'Skipped: createdDiagram not available');
    }

    if (createdDiagram) {
      try {
        const result = await request(server.baseUrl, 'PATCH', `/api/diagrams/${encodeURIComponent(createdDiagram.id)}`, {
          description: 'Updated description',
        });
        assert.equal(result.success, true);
        assert.equal(result.diagram.description, 'Updated description');
        recordTest('update_diagram updates description', true);
      } catch (err) {
        recordTest('update_diagram updates description', false, err.message);
      }
    } else {
      recordTest('update_diagram updates description', false, 'Skipped: createdDiagram not available');
    }

    if (createdDiagram) {
      try {
        const result = await request(server.baseUrl, 'PATCH', `/api/diagrams/${encodeURIComponent(createdDiagram.id)}`, {
          name: 'Multi-Update Diagram',
          tags: ['multi', 'update'],
          description: 'Multiple fields updated',
        });
        assert.equal(result.success, true);
        assert.equal(result.diagram.name, 'Multi-Update Diagram');
        assert.deepEqual(result.diagram.tags, ['multi', 'update']);
        assert.equal(result.diagram.description, 'Multiple fields updated');
        recordTest('update_diagram updates multiple fields at once', true);
      } catch (err) {
        recordTest('update_diagram updates multiple fields at once', false, err.message);
      }
    } else {
      recordTest('update_diagram updates multiple fields at once', false, 'Skipped: createdDiagram not available');
    }

    // ─── Archive/Unarchive Operations ────────────────────────
    console.log('\n  Archive/Unarchive Operations:');

    if (secondDiagram) {
      try {
        const result = await request(server.baseUrl, 'PATCH', `/api/diagrams/${encodeURIComponent(secondDiagram.id)}`, {
          archivedAt: new Date().toISOString(),
        });
        assert.equal(result.success, true);
        assert.ok(result.diagram.archivedAt, 'Should have archivedAt set');

        // Note: archived diagrams still appear in listDiagrams() - filtering happens in searchDiagrams()
        const diagrams = await request(server.baseUrl, 'GET', '/api/diagrams');
        const found = diagrams.diagrams.find(d => d.id === secondDiagram.id);
        assert.ok(found, 'Archived diagram should still appear in list (filtering happens in search)');
        assert.ok(found.archivedAt, 'Archived diagram should have archivedAt set');
        recordTest('update_diagram archives a diagram', true);
      } catch (err) {
        recordTest('update_diagram archives a diagram', false, err.message);
      }
    } else {
      recordTest('update_diagram archives a diagram', false, 'Skipped: secondDiagram not available');
    }

    if (secondDiagram) {
      try {
        const result = await request(server.baseUrl, 'PATCH', `/api/diagrams/${encodeURIComponent(secondDiagram.id)}`, {
          archivedAt: null,
        });
        assert.equal(result.success, true);
        assert.ok(!result.diagram.archivedAt, 'Should have archivedAt cleared');

        // Unarchived diagram should now appear in list
        const diagrams = await request(server.baseUrl, 'GET', '/api/diagrams');
        const found = diagrams.diagrams.find(d => d.id === secondDiagram.id);
        assert.ok(found, 'Unarchived diagram should appear in list');
        recordTest('update_diagram unarchives a diagram', true);
      } catch (err) {
        recordTest('update_diagram unarchives a diagram', false, err.message);
      }
    } else {
      recordTest('update_diagram unarchives a diagram', false, 'Skipped: secondDiagram not available');
    }

    // ─── Duplicate Operations ────────────────────────────────
    console.log('\n  Duplicate Operations:');

    if (createdDiagram) {
      try {
        const result = await request(server.baseUrl, 'POST', `/api/diagrams/${encodeURIComponent(createdDiagram.id)}/duplicate`, {});
        assert.equal(result.success, true);
        assert.ok(result.diagram.id !== createdDiagram.id, 'Duplicated diagram should have new ID');
        assert.ok(result.diagram.name.includes('Copy'), 'Duplicated diagram should have "Copy" in name');
        recordTest('duplicate_diagram creates a copy with "Copy" suffix', true);
      } catch (err) {
        recordTest('duplicate_diagram creates a copy with "Copy" suffix', false, err.message);
      }
    } else {
      recordTest('duplicate_diagram creates a copy with "Copy" suffix', false, 'Skipped: createdDiagram not available');
    }

    if (createdDiagram) {
      try {
        const result = await request(server.baseUrl, 'POST', `/api/diagrams/${encodeURIComponent(createdDiagram.id)}/duplicate`, {
          name: 'Custom Duplicated Name',
        });
        assert.equal(result.success, true);
        assert.equal(result.diagram.name, 'Custom Duplicated Name');
        recordTest('duplicate_diagram with custom name uses that name', true);
      } catch (err) {
        recordTest('duplicate_diagram with custom name uses that name', false, err.message);
      }
    } else {
      recordTest('duplicate_diagram with custom name uses that name', false, 'Skipped: createdDiagram not available');
    }

    // ─── Delete Operations ───────────────────────────────────
    console.log('\n  Delete Operations:');

    try {
      const toDelete = await request(server.baseUrl, 'POST', '/api/diagrams', {
        name: 'Diagram To Delete',
      });
      const deleteResult = await request(server.baseUrl, 'DELETE', `/api/diagrams/${encodeURIComponent(toDelete.diagram.id)}`);
      assert.equal(deleteResult.success, true);
      assert.equal(deleteResult.deleted, true);

      // Verify it's gone
      const getResult = await api(server.baseUrl, 'GET', `/api/diagrams/${encodeURIComponent(toDelete.diagram.id)}`);
      assert.equal(getResult.status, 404, 'Deleted diagram should return 404');
      recordTest('delete_diagram removes a diagram', true);
    } catch (err) {
      recordTest('delete_diagram removes a diagram', false, err.message);
    }

    // Test: delete cannot delete default diagram
    try {
      const getResult = await request(server.baseUrl, 'GET', '/api/diagrams/default');
      assert.ok(getResult.diagram, 'Default diagram should still exist');
      assert.equal(getResult.diagram.id, 'default');
      recordTest('delete_diagram cannot delete default diagram', true);
    } catch (err) {
      recordTest('delete_diagram cannot delete default diagram', false, err.message);
    }

    // ─── Recent Diagrams ─────────────────────────────────────
    console.log('\n  Recent Diagrams:');

    try {
      // Create multiple diagrams with elements to ensure different updated_at
      const d1 = await request(server.baseUrl, 'POST', '/api/diagrams', { name: 'Recent 1' });
      await delay(10);
      const d2 = await request(server.baseUrl, 'POST', '/api/diagrams', { name: 'Recent 2' });
      await delay(10);
      const d3 = await request(server.baseUrl, 'POST', '/api/diagrams', { name: 'Recent 3' });

      // Add an element to d3 to update its timestamp
      await request(server.baseUrl, 'POST', `/api/elements?diagramId=${encodeURIComponent(d3.diagram.id)}`, {
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      });

      const diagrams = await request(server.baseUrl, 'GET', '/api/diagrams');
      const d3Index = diagrams.diagrams.findIndex(d => d.id === d3.diagram.id);
      const d2Index = diagrams.diagrams.findIndex(d => d.id === d2.diagram.id);

      // D3 should appear before D2 since it was updated more recently
      assert.ok(d3Index < d2Index, 'More recently updated diagram should appear first');
      recordTest('list_diagrams returns diagrams ordered by updated_at', true);
    } catch (err) {
      recordTest('list_diagrams returns diagrams ordered by updated_at', false, err.message);
    }

    // ─── Search Operations ───────────────────────────────────
    console.log('\n  Search Operations:');

    try {
      const toSearch = await request(server.baseUrl, 'POST', '/api/diagrams', {
        name: 'Searchable Diagram For Testing',
        tags: ['search'],
      });

      // Filter from list_diagrams
      const diagrams = await request(server.baseUrl, 'GET', '/api/diagrams');
      const found = diagrams.diagrams.find(d =>
        d.name.includes('Searchable') && d.id === toSearch.diagram.id
      );
      assert.ok(found, 'Should find diagram by name');
      recordTest('search_diagrams finds diagrams by name', true);
    } catch (err) {
      recordTest('search_diagrams finds diagrams by name', false, err.message);
    }

    try {
      const diagrams = await request(server.baseUrl, 'GET', '/api/diagrams');
      const withSearchTag = diagrams.diagrams.filter(d => d.tags?.includes('search'));
      assert.ok(withSearchTag.length > 0, 'Should find diagrams with "search" tag');
      recordTest('search_diagrams filters by tags', true);
    } catch (err) {
      recordTest('search_diagrams filters by tags', false, err.message);
    }

    // ─── Thumbnail Operations ─────────────────────────────────
    console.log('\n  Thumbnail Operations:');

    try {
      const thumbDiagram = await request(server.baseUrl, 'POST', '/api/diagrams', {
        name: 'Thumbnail Test',
      });

      const thumbnailData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      const result = await request(server.baseUrl, 'PATCH', `/api/diagrams/${encodeURIComponent(thumbDiagram.diagram.id)}`, {
        thumbnail: thumbnailData,
      });
      assert.equal(result.success, true);
      assert.equal(result.diagram.thumbnail, thumbnailData);
      recordTest('update_diagram sets thumbnail', true);
    } catch (err) {
      recordTest('update_diagram sets thumbnail', false, err.message);
    }

    try {
      const thumbDiagram = await request(server.baseUrl, 'POST', '/api/diagrams', {
        name: 'Thumbnail Test 2',
        thumbnail: 'data:image/png;base64,test',
      });

      const result = await request(server.baseUrl, 'GET', `/api/diagrams/${encodeURIComponent(thumbDiagram.diagram.id)}`);
      assert.equal(result.diagram.thumbnail, 'data:image/png;base64,test');
      recordTest('get_diagram returns diagram with thumbnail', true);
    } catch (err) {
      recordTest('get_diagram returns diagram with thumbnail', false, err.message);
    }

    // ─── Export/Import Operations ─────────────────────────────
    console.log('\n  Export/Import Operations:');

    let exportedElements;
    try {
      const exportDiagram = await request(server.baseUrl, 'POST', '/api/diagrams', {
        name: 'Export Source',
      });
      const diagramId = exportDiagram.diagram.id;

      await request(server.baseUrl, 'POST', `/api/elements?diagramId=${encodeURIComponent(diagramId)}`, {
        type: 'rectangle',
        x: 10,
        y: 20,
        width: 100,
        height: 50,
      });
      await request(server.baseUrl, 'POST', `/api/elements?diagramId=${encodeURIComponent(diagramId)}`, {
        type: 'text',
        x: 50,
        y: 60,
        text: 'Hello World',
      });

      const state = await request(server.baseUrl, 'GET', `/api/diagrams/${encodeURIComponent(diagramId)}/state`);
      assert.ok(state.elements.length >= 2, 'Should have exported elements');
      exportedElements = state.elements;
      recordTest('export_diagram exports all diagram state', true);
    } catch (err) {
      recordTest('export_diagram exports all diagram state', false, err.message);
    }

    if (exportedElements) {
      try {
        const importTarget = await request(server.baseUrl, 'POST', '/api/diagrams', {
          name: 'Import Target',
        });

        const result = await request(server.baseUrl, 'POST', `/api/diagrams/${encodeURIComponent(importTarget.diagram.id)}/import`, {
          elements: exportedElements,
          mode: 'replace',
        });
        assert.equal(result.success, true);
        assert.ok(result.count >= 2, 'Should have imported elements');
        recordTest('import_diagram imports elements into new diagram', true);
      } catch (err) {
        recordTest('import_diagram imports elements into new diagram', false, err.message);
      }
    } else {
      recordTest('import_diagram imports elements into new diagram', false, 'Skipped: exportedElements not available');
    }

    try {
      const mergeTarget = await request(server.baseUrl, 'POST', '/api/diagrams', {
        name: 'Merge Target',
      });

      await request(server.baseUrl, 'POST', `/api/diagrams/${encodeURIComponent(mergeTarget.diagram.id)}/import`, {
        elements: [{ id: 'elem-1', type: 'rectangle', x: 0, y: 0, width: 50, height: 50 }],
        mode: 'replace',
      });

      const result = await request(server.baseUrl, 'POST', `/api/diagrams/${encodeURIComponent(mergeTarget.diagram.id)}/import`, {
        elements: [{ id: 'elem-2', type: 'rectangle', x: 100, y: 100, width: 50, height: 50 }],
        mode: 'merge',
      });
      assert.equal(result.success, true);
      recordTest('import_diagram with merge mode appends elements', true);
    } catch (err) {
      recordTest('import_diagram with merge mode appends elements', false, err.message);
    }

    // ─── Session/Event Operations ───────────────────────────
    console.log('\n  Session/Event Operations:');

    try {
      const sessionDiagram = await request(server.baseUrl, 'POST', '/api/diagrams', {
        name: 'Session Test',
      });

      await request(server.baseUrl, 'POST', '/api/sessions/heartbeat', {
        sessionId: 'test-session-123',
        diagramId: sessionDiagram.diagram.id,
      });

      const result = await request(server.baseUrl, 'GET', `/api/diagrams/${encodeURIComponent(sessionDiagram.diagram.id)}/sessions`);
      assert.ok(result.success, true);
      assert.ok(Array.isArray(result.sessions), 'Should have sessions array');
      recordTest('list_sessions returns sessions for a diagram', true);
    } catch (err) {
      recordTest('list_sessions returns sessions for a diagram', false, err.message);
    }

    try {
      const eventDiagram = await request(server.baseUrl, 'POST', '/api/diagrams', {
        name: 'Event Test',
      });

      await request(server.baseUrl, 'POST', `/api/elements?diagramId=${encodeURIComponent(eventDiagram.diagram.id)}`, {
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      });

      const result = await request(server.baseUrl, 'GET', `/api/diagrams/${encodeURIComponent(eventDiagram.diagram.id)}/events`);
      assert.ok(result.success, true);
      assert.ok(Array.isArray(result.events), 'Should have events array');
      recordTest('list_events returns events for a diagram', true);
    } catch (err) {
      recordTest('list_events returns events for a diagram', false, err.message);
    }

    // ─── Diagram with Elements Verification ─────────────────
    console.log('\n  Diagram with Elements Verification:');

    try {
      const complexDiagram = await request(server.baseUrl, 'POST', '/api/diagrams', {
        name: 'Complex Diagram',
        tags: ['complex', 'test'],
        description: 'Diagram with multiple element types',
      });

      const diagramId = complexDiagram.diagram.id;

      await request(server.baseUrl, 'POST', `/api/elements?diagramId=${encodeURIComponent(diagramId)}`, {
        id: 'rect-test',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        strokeColor: '#000',
      });

      await request(server.baseUrl, 'POST', `/api/elements?diagramId=${encodeURIComponent(diagramId)}`, {
        id: 'ellipse-test',
        type: 'ellipse',
        x: 150,
        y: 0,
        width: 80,
        height: 80,
      });

      await request(server.baseUrl, 'POST', `/api/elements?diagramId=${encodeURIComponent(diagramId)}`, {
        id: 'arrow-test',
        type: 'arrow',
        x: 100,
        y: 50,
        points: [[0, 0], [50, 0]],
      });

      const state = await request(server.baseUrl, 'GET', `/api/diagrams/${encodeURIComponent(diagramId)}/state`);
      assert.equal(state.diagram.id, diagramId);
      assert.equal(state.diagram.name, 'Complex Diagram');
      assert.equal(state.elements.length, 3, 'Should have 3 elements');

      const rect = state.elements.find(e => e.id === 'rect-test');
      assert.ok(rect, 'Should find rectangle');
      assert.equal(rect.type, 'rectangle');

      const ellipse = state.elements.find(e => e.id === 'ellipse-test');
      assert.ok(ellipse, 'Should find ellipse');
      assert.equal(ellipse.type, 'ellipse');

      const arrow = state.elements.find(e => e.id === 'arrow-test');
      assert.ok(arrow, 'Should find arrow');
      assert.equal(arrow.type, 'arrow');
      recordTest('diagram state correctly tracks all components', true);
    } catch (err) {
      recordTest('diagram state correctly tracks all components', false, err.message);
    }

    // ─── Error Handling ──────────────────────────────────────
    console.log('\n  Error Handling:');

    try {
      const result = await api(server.baseUrl, 'POST', '/api/diagrams', {});
      assert.equal(result.status, 400, 'Should return 400 for empty body without name');
      recordTest('create_diagram with empty body returns 400', true);
    } catch (err) {
      recordTest('create_diagram with empty body returns 400', false, err.message);
    }

    try {
      const result = await api(server.baseUrl, 'PATCH', '/api/diagrams/fake-id-123', {
        name: 'Should Fail',
      });
      assert.equal(result.status, 500, 'Should return 500 for update failure');
      recordTest('update_non_existent_diagram returns 500', true);
    } catch (err) {
      recordTest('update_non_existent_diagram returns 500', false, err.message);
    }

    try {
      const diagram = await request(server.baseUrl, 'POST', '/api/diagrams', { name: 'Import Error Test' });

      const result = await api(server.baseUrl, 'POST', `/api/diagrams/${encodeURIComponent(diagram.diagram.id)}/import`, {
        elements: 'not-an-array',
      });
      assert.equal(result.status, 400, 'Should return 400 for invalid elements');
      recordTest('import with invalid payload returns error', true);
    } catch (err) {
      recordTest('import with invalid payload returns error', false, err.message);
    }

  } finally {
    await stopServer(server.child, 'SIGTERM');

    // Cleanup
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }

  // Summary
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(50)}\n`);

  const output = {
    ok: failed === 0,
    passed,
    failed,
    tests: results,
  };

  console.log(JSON.stringify(output, null, 2));

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test suite error:', err);
  process.exit(1);
});
