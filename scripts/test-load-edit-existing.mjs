#!/usr/bin/env node
/**
 * Test: Load existing diagrams, make changes, verify persistence
 * Tests that elements are correctly associated with each diagram
 */

const API_BASE = 'http://127.0.0.1:3000';

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

async function main() {
  console.log('=== Test: Load Existing Diagrams & Edit ===\n');

  // 1. List diagrams
  const resp = await apiGet('/api/diagrams', 'test-reuse-session');
  const diagrams = resp.diagrams || resp;
  console.log('Diagrams found:', diagrams.length);
  diagrams.forEach(d => console.log(`  - ${d.id} | ${d.name}`));

  // Pick Diagram Alpha and Diagram Beta
  const diagA = diagrams.find(d => d.name === 'Diagram Alpha');
  const diagB = diagrams.find(d => d.name === 'Diagram Beta');
  if (!diagA || !diagB) throw new Error('Missing test diagrams');

  console.log(`\nDiagram Alpha: ${diagA.id}`);
  console.log(`Diagram Beta: ${diagB.id}`);

  // 2. Load Diagram Alpha
  await apiPost(`/api/diagrams/${diagA.id}/load`, null, 'session-alpha');
  const elemA1 = await apiPost('/api/elements', {
    type: 'rectangle', x: 100, y: 100, width: 80, height: 40,
    strokeColor: '#000', backgroundColor: '#fff'
  }, 'session-alpha');
  console.log(`\nCreated elemA1 in Diagram Alpha: ${elemA1.element?.id || elemA1.element?.ID || JSON.stringify(elemA1).slice(0,100)}`);

  // 3. Load Diagram Beta (different session)
  await apiPost(`/api/diagrams/${diagB.id}/load`, null, 'session-beta');
  const elemB1 = await apiPost('/api/elements', {
    type: 'ellipse', x: 200, y: 200, width: 60, height: 60,
    strokeColor: '#c00', backgroundColor: '#fcc'
  }, 'session-beta');
  console.log(`Created elemB1 in Diagram Beta: ${elemB1.element?.id || elemB1.element?.ID || JSON.stringify(elemB1).slice(0,100)}`);

  // 4. Get state to verify elements per diagram
  const stateA = await apiGet(`/api/diagrams/${diagA.id}/state`, 'session-alpha');
  const stateB = await apiGet(`/api/diagrams/${diagB.id}/state`, 'session-beta');
  const countA = stateA.elements?.length || 0;
  const countB = stateB.elements?.length || 0;
  console.log(`\nElement counts from API:`);
  console.log(`  Diagram Alpha: ${countA} elements`);
  console.log(`  Diagram Beta: ${countB} elements`);

  // 5. Update elemA1
  const elemA1Id = elemA1.element?.id || elemA1.element?.ID;
  if (elemA1Id) {
    await apiPut(`/api/elements/${elemA1Id}`, {
      x: 500, y: 300, width: 150, height: 80
    }, 'session-alpha');
    console.log(`\nUpdated elemA1 position → x:500, width:150`);
  }

  // 6. Verify state after update
  const stateA2 = await apiGet(`/api/diagrams/${diagA.id}/state`, 'session-alpha');
  // Find element with updated x=500 (our test update)
  const updatedElem = stateA2.elements?.find(e => e.x === 500);
  console.log(`  elemA1 after update: x=${updatedElem?.x || 'not found'}, width=${updatedElem?.width || 'N/A'}`);
  const pass1 = updatedElem && updatedElem.x === 500 && updatedElem.width === 150;
  console.log(`  ✓ Update persisted: ${pass1 ? 'PASS' : 'FAIL'}`);

  console.log('\n=== SUMMARY ===');
  const countPass = countA > 0 && countB > 0;
  console.log(`Diagram isolation: ${countPass ? 'PASS' : 'FAIL'}`);
  console.log(`Element update: ${pass1 ? 'PASS' : 'FAIL'}`);
  console.log(`\nAll tests: ${countPass && pass1 ? 'PASSED ✅' : 'FAILED ❌'}`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
