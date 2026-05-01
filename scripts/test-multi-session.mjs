// Test: Multiple sessions creating different diagrams, then editing them
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const API_BASE = 'http://127.0.0.1:3000';
const SESSION_A = 'session-alpha';
const SESSION_B = 'session-beta';
const SESSION_C = 'session-gamma';

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

// Helper: PUT JSON
async function apiPut(path, body, sessionId) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
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
  // Server uses: ~/../home/quangdang/.excalidraw_mcp/excalidraw.sqlite (via os.homedir())
  // Since HOME=/home/quangdang for the server process
  const DB_PATH = join('/home/quangdang', '.excalidraw_mcp/excalidraw.sqlite');
  const db = Database(DB_PATH);
  const rows = db.prepare(`
    SELECT id, data_json, is_deleted FROM elements
    WHERE diagram_id = ? AND is_deleted = 0
    ORDER BY updated_at ASC
  `).all(diagramId);
  db.close();
  return rows.map(r => ({ id: r.id, ...JSON.parse(r.data_json) }));
}

function getDiagramCount() {
  const Database = require('better-sqlite3');
  const DB_PATH = join('/home/quangdang', '.excalidraw_mcp/excalidraw.sqlite');
  const db = Database(DB_PATH);
  const count = db.prepare('SELECT COUNT(*) as c FROM diagrams').get().c;
  db.close();
  return count;
}

// Helper: create element via REST API
async function createElem(sessionId, diagramId, elem) {
  return apiPost('/api/elements', {
    sessionId,
    diagramId,
    ...elem
  }, sessionId);
}

// Helper: update element via API - PUT to /api/elements/:id
async function updateElem(sessionId, diagramId, elemId, updates) {
  return apiPut(`/api/elements/${elemId}`, {
    sessionId,
    diagramId,
    ...updates
  }, sessionId);
}

async function main() {
  console.log('=== TEST: Multi-Session / Multi-Diagram + Editing ===\n');

  // Clean DB - use /home/quangdang path to match server's os.homedir()
  {
    const Database = require('better-sqlite3');
    const DB_PATH = join('/home/quangdang', '.excalidraw_mcp/excalidraw.sqlite');
    const db = Database(DB_PATH);
    db.prepare('DELETE FROM elements').run();
    db.prepare('DELETE FROM diagrams').run();
    // diagram_sessions table may not exist in all schema versions
    try { db.prepare('DELETE FROM diagram_sessions').run(); } catch (_) {}
    db.close();
    console.log('✓ Cleaned DB\n');
  }

  let pass = 0, fail = 0;
  const check = (label, actual, expected) => {
    const ok = actual === expected;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: got=${actual}, want=${expected}`);
    ok ? pass++ : fail++;
  };

  // ─── SCENARIO A: Session Alpha creates Diagram Alpha ───
  console.log('[Session A] Creating Diagram Alpha...');
  const rA = await apiPost('/api/diagrams', { name: 'Diagram Alpha' }, SESSION_A);
  const dAId = rA.diagram?.id;
  console.log('  diagramId:', dAId);

  await createElem(SESSION_A, dAId, { id: 'elem-A1', type: 'rectangle', x: 100, y: 100, width: 80, height: 60, strokeColor: '#000', backgroundColor: '#fff' });
  await createElem(SESSION_A, dAId, { id: 'elem-A2', type: 'rectangle', x: 200, y: 200, width: 40, height: 40, strokeColor: '#0a0', backgroundColor: '#cfc' });
  console.log('  Created elem-A1, elem-A2');

  // ─── SCENARIO B: Session Beta creates Diagram Beta ───
  console.log('\n[Session B] Creating Diagram Beta...');
  const rB = await apiPost('/api/diagrams', { name: 'Diagram Beta' }, SESSION_B);
  const dBId = rB.diagram?.id;
  console.log('  diagramId:', dBId);

  await createElem(SESSION_B, dBId, { id: 'elem-B1', type: 'ellipse', x: 300, y: 300, width: 100, height: 80, strokeColor: '#c00', backgroundColor: '#fcc' });
  console.log('  Created elem-B1');

  // ─── SCENARIO C: Session Gamma creates Diagram Gamma ───
  console.log('\n[Session C] Creating Diagram Gamma...');
  const rC = await apiPost('/api/diagrams', { name: 'Diagram Gamma' }, SESSION_C);
  const dCId = rC.diagram?.id;
  console.log('  diagramId:', dCId);

  await createElem(SESSION_C, dCId, { id: 'elem-C1', type: 'rectangle', x: 50, y: 50, width: 200, height: 100, strokeColor: '#00c', backgroundColor: '#ccf' });
  await createElem(SESSION_C, dCId, { id: 'elem-C2', type: 'text', x: 60, y: 60, text: 'Hello from Gamma', strokeColor: '#00c', fontSize: 16 });
  console.log('  Created elem-C1, elem-C2');

  // ─── VERIFY: Each diagram has correct element counts ───
  console.log('\n=== VERIFY: Element Counts ===');
  check('Diagram Alpha has 2 elements', getDiagramElements(dAId).length, 2);
  check('Diagram Beta has 1 element', getDiagramElements(dBId).length, 1);
  check('Diagram Gamma has 2 elements', getDiagramElements(dCId).length, 2);
  check('Total diagrams in DB', getDiagramCount(), 3);

  // ─── EDIT EXISTING DIAGRAM A ───
  console.log('\n=== EDIT: Diagram Alpha ===');
  console.log('[Session A] Updating elem-A1 position to (500, 500)...');
  await updateElem(SESSION_A, dAId, 'elem-A1', { x: 500, y: 500, width: 150, height: 120 });

  const elemA1 = getDiagramElements(dAId).find(e => e.id === 'elem-A1');
  console.log('  elem-A1 after update:', JSON.stringify(elemA1).slice(0, 120));
  check('elem-A1 x updated to 500', elemA1?.x === 500, true);
  check('elem-A1 width updated to 150', elemA1?.width === 150, true);

  // Add new element to existing diagram A
  console.log('\n[Session A] Adding elem-A3 to Diagram Alpha...');
  await createElem(SESSION_A, dAId, { id: 'elem-A3', type: 'rectangle', x: 700, y: 700, width: 60, height: 60, strokeColor: '#f0f', backgroundColor: '#fdf' });
  check('Diagram Alpha now has 3 elements', getDiagramElements(dAId).length, 3);

  // ─── EDIT EXISTING DIAGRAM B ───
  console.log('\n=== EDIT: Diagram Beta ===');
  console.log('[Session B] Updating elem-B1...');
  await updateElem(SESSION_B, dBId, 'elem-B1', { x: 400, y: 400, width: 200, height: 160 });
  const elemB1 = getDiagramElements(dBId).find(e => e.id === 'elem-B1');
  check('elem-B1 x updated to 400', elemB1?.x === 400, true);
  check('Diagram Beta still has 1 element', getDiagramElements(dBId).length, 1);

  // ─── FINAL ───
  console.log('\n=== FINAL SUMMARY ===');
  console.log(`  Diagrams: ${getDiagramCount()}`);
  console.log(`  Diagram Alpha elements: ${getDiagramElements(dAId).length}`);
  console.log(`  Diagram Beta elements: ${getDiagramElements(dBId).length}`);
  console.log(`  Diagram Gamma elements: ${getDiagramElements(dCId).length}`);
  console.log(`\n  Passed: ${pass} / ${pass + fail}`);
  console.log(`  Failed: ${fail} / ${pass + fail}`);

  if (fail === 0) {
    console.log('\n  ALL TESTS PASSED ✅');
  } else {
    console.log('\n  SOME TESTS FAILED ❌');
  }
}

main().catch(console.error);
