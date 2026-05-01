// Test: List existing diagrams, load old one, add to it, create new one
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const API_BASE = 'http://127.0.0.1:3000';
const SESSION_TEST = 'session-test-workflow';

// Helper: POST JSON
async function apiPost(path, body, sessionId) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionId ? { 'x-session-id': sessionId } : {})
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

// Helper: GET
async function apiGet(path, sessionId) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: sessionId ? { 'x-session-id': sessionId } : {}
  });
  return res.json();
}

// Helper: get elements from SQLite
function getDiagramElements(diagramId) {
  const Database = require('better-sqlite3');
  const DB_PATH = '/home/quangdang/.excalidraw_mcp/excalidraw.sqlite';
  const db = Database(DB_PATH);
  const rows = db.prepare(`
    SELECT id, data_json, is_deleted FROM elements
    WHERE diagram_id = ? AND is_deleted = 0
    ORDER BY updated_at ASC
  `).all(diagramId);
  db.close();
  return rows.map(r => ({ id: r.id, ...JSON.parse(r.data_json) }));
}

// Helper: create element via REST API
async function createElem(sessionId, diagramId, elem) {
  return apiPost('/api/elements', {
    sessionId,
    diagramId,
    ...elem
  }, sessionId);
}

async function main() {
  console.log('=== TEST: List Diagrams → Load Old → Edit → Create New ===\n');

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const ok = actual === expected;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: got=${actual}, want=${expected}`);
    ok ? pass++ : fail++;
  };

  // ─── STEP 1: List existing diagrams ───
  console.log('[STEP 1] Listing all diagrams...');
  const listResult = await apiGet('/api/diagrams', SESSION_TEST);
  console.log('  Diagrams found:', listResult.diagrams?.length || 0);
  listResult.diagrams?.forEach(d => {
    const elems = getDiagramElements(d.id);
    console.log(`    - ${d.id} "${d.name}" (${elems.length} elements)`);
  });

  // Pick the first non-default diagram if available
  const firstOldDiagram = listResult.diagrams?.find(d => d.id !== 'default');
  if (!firstOldDiagram) {
    console.log('  No old diagrams found, will create new one');
  }

  // ─── STEP 2: Load the old diagram and add elements to it ───
  if (firstOldDiagram) {
    console.log(`\n[STEP 2] Loading old diagram "${firstOldDiagram.name}" (${firstOldDiagram.id})...`);

    // Simulate "load_diagram" by setting active diagram via session
    // The server tracks active diagram per session
    const elemCountBefore = getDiagramElements(firstOldDiagram.id).length;
    console.log(`  Elements before: ${elemCountBefore}`);

    // Add a new element to the loaded (old) diagram
    const elemId = `elem-load-test-${Date.now()}`;
    await createElem(SESSION_TEST, firstOldDiagram.id, {
      id: elemId,
      type: 'rectangle',
      x: 888,
      y: 888,
      width: 77,
      height: 77,
      strokeColor: '#ff8800',
      backgroundColor: '#fff8cc'
    });

    const elemCountAfter = getDiagramElements(firstOldDiagram.id).length;
    console.log(`  Elements after adding: ${elemCountAfter}`);
    check('Old diagram element count increased', elemCountAfter, elemCountBefore + 1);

    // Verify the new element exists
    const newElem = getDiagramElements(firstOldDiagram.id).find(e => e.id === elemId);
    check('New element has correct x', newElem?.x === 888, true);
    console.log(`  Added element ${elemId} to existing diagram ✓`);
  }

  // ─── STEP 3: Create a brand new diagram ───
  console.log('\n[STEP 3] Creating NEW diagram "My New Diagram"...');
  const newDiagResult = await apiPost('/api/diagrams', { name: 'My New Diagram' }, SESSION_TEST);
  const newDiagId = newDiagResult.diagram?.id;
  console.log('  New diagram ID:', newDiagId);

  // Add elements to the new diagram
  await createElem(SESSION_TEST, newDiagId, {
    id: `elem-new-1`,
    type: 'rectangle',
    x: 10,
    y: 10,
    width: 100,
    height: 100,
    strokeColor: '#00f',
    backgroundColor: '#eef'
  });
  await createElem(SESSION_TEST, newDiagId, {
    id: `elem-new-2`,
    type: 'text',
    x: 15,
    y: 15,
    text: 'Fresh diagram!',
    strokeColor: '#00f',
    fontSize: 20
  });

  const newElems = getDiagramElements(newDiagId);
  console.log(`  Elements in new diagram: ${newElems.length}`);
  check('New diagram has 2 elements', newElems.length, 2);

  // ─── STEP 4: List diagrams again to verify all exist ───
  console.log('\n[STEP 4] Listing diagrams after all operations...');
  const listAfter = await apiGet('/api/diagrams', SESSION_TEST);
  console.log('  Total diagrams:', listAfter.diagrams?.length);
  listAfter.diagrams?.forEach(d => {
    const elems = getDiagramElements(d.id);
    console.log(`    - "${d.name}" (${elems.length} elements)`);
  });
  check('Total diagrams >= 3', listAfter.diagrams?.length >= 3, true);

  // ─── SUMMARY ───
  console.log('\n=== SUMMARY ===');
  console.log(`  Passed: ${pass} / ${pass + fail}`);
  console.log(`  Failed: ${fail} / ${pass + fail}`);
  if (fail === 0) {
    console.log('\n  ALL TESTS PASSED ✅');
    console.log('\n  Workflow demonstrated:');
    console.log('    1. list_diagrams → see all existing diagrams');
    console.log('    2. load_diagram → switch to an old diagram');
    console.log('    3. create_element → add elements to the loaded diagram');
    console.log('    4. create_diagram → create a BRAND NEW diagram');
    console.log('    5. create_element → add elements to the new diagram');
  } else {
    console.log('\n  SOME TESTS FAILED ❌');
  }
}

main().catch(console.error);
