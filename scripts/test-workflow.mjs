#!/usr/bin/env node

/**
 * MCP Excalidraw Test Script
 * Tests: single session, multiple sessions, session restart, list diagrams,
 *        diagram reuse vs create, edge cases
 */

import { spawn } from 'child_process';
import { execSync } from 'child_process';
import path from 'path';

const SERVER_PATH = '/data/projects/mcp_excalidraw/dist/index.js';
const DB_PATH = path.join(process.env.HOME || '/home/quangdang', '.excalidraw_mcp/excalidraw.sqlite');
const NODE_BIN = '/home/quangdang/.nvm/versions/node/v24.14.0/bin/node';

const tests = [];
const sessions = [];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function recordTest(name, passed, error = null) {
  tests.push({ name, passed, error });
  const status = passed ? '✓' : '✗';
  const errMsg = error ? ` | ERROR: ${error}` : '';
  console.log(`${status} ${name}${errMsg}`);
}

function sqlite(query) {
  try {
    const result = execSync(`sqlite3 "${DB_PATH}" "${query}"`, { 
      encoding: 'utf8',
      timeout: 5000 
    });
    return result.trim();
  } catch (e) {
    return '';
  }
}

async function cleanDB() {
  log('Cleaning database...');
  sqlite("DELETE FROM elements");
  sqlite("DELETE FROM diagrams WHERE name != 'default'");
  sqlite("DELETE FROM snapshots");
  sqlite("DELETE FROM sessions");
  log('Database cleaned');
}

// Parse MCP response - tools/call wraps result in { content: [{ type: "text", text: "..." }] }
function parseResponse(result, toolName) {
  if (!result) return result;
  
  // Extract text from content wrapper if present
  let text = result;
  if (result?.content && Array.isArray(result.content) && result.content[0]?.text) {
    text = result.content[0].text;
  }
  
  // Parse JSON if text looks like JSON
  if (typeof text === 'string') {
    // Handle multi-line JSON responses
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e) {
        // Return raw text if JSON parse fails
        return text;
      }
    }
    return text;
  }
  
  return result;
}

function createMCPClient() {
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE_BIN, [SERVER_PATH], {
      env: {
        ...process.env,
        EXPRESS_SERVER_URL: 'http://127.0.0.1:3000',
        ENABLE_CANVAS_SYNC: 'true',
        NODE_DISABLE_COLORS: '1',
        NO_COLOR: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let id = 1;
    const pending = new Map();
    let initialized = false;
    let outputBuffer = '';

    proc.stdout.on('data', (data) => {
      outputBuffer += data.toString();
      const lines = outputBuffer.split('\n');
      outputBuffer = lines.pop() || '';
      
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.id && pending.has(response.id)) {
            const { resolve, reject } = pending.get(response.id);
            pending.delete(response.id);
            if (response.error) {
              reject(new Error(response.error.message || JSON.stringify(response.error)));
            } else {
              resolve(response.result);
            }
          }
        } catch (e) {
          // Ignore non-JSON output
        }
      }
    });

    proc.stderr.on('data', () => {});
    proc.on('error', reject);

    const client = {
      async call(method, params = {}) {
        return new Promise((res, rej) => {
          const msg = {
            jsonrpc: '2.0',
            id: id++,
            method,
            params
          };
          pending.set(msg.id, { resolve: res, reject: rej });
          proc.stdin.write(JSON.stringify(msg) + '\n');
          
          setTimeout(() => {
            if (pending.has(msg.id)) {
              pending.delete(msg.id);
              rej(new Error(`Timeout calling ${method}`));
            }
          }, 10000);
        });
      },
      
      async tool(name, args = {}) {
        const result = await this.call('tools/call', { name, arguments: args });
        return parseResponse(result, name);
      },
      
      async init() {
        if (initialized) return;
        
        await this.call('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        });
        
        proc.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
          params: {}
        }) + '\n');
        
        initialized = true;
        await new Promise(r => setTimeout(r, 200));
      },
      
      destroy() {
        proc.kill();
      }
    };

    setTimeout(async () => {
      try {
        await client.init();
        resolve(client);
      } catch (e) {
        reject(e);
      }
    }, 800);
  });
}

async function runTests() {
  log('='.repeat(60));
  log('MCP Excalidraw Test Suite');
  log('='.repeat(60));

  // Test 1: Single session
  log('\n--- Test 1: Single Session ---');
  {
    const client = await createMCPClient();
    sessions.push(client);
    
    try {
      const diagram = await client.tool('create_diagram', { 
        name: 'Test Single',
        tags: ['test']
      });
      recordTest('create_diagram creates new diagram', !!diagram?.diagram?.id, diagram ? null : 'diagram is null');
      const diagramId = diagram?.diagram?.id;

      const elem = await client.tool('create_element', {
        type: 'rectangle',
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        text: 'Start',
        strokeColor: '#000'
      });
      recordTest('create_element works', !!elem?.id);

      const diagrams = await client.tool('list_diagrams');
      recordTest('list_diagrams returns created diagram', 
        diagrams?.diagrams?.some?.(d => d.name === 'Test Single'));

      const state = await client.tool('get_diagram_state', { diagramId });
      recordTest('get_diagram_state returns elements', 
        state?.elements?.length > 0);

    } catch (e) {
      recordTest('Single session test', false, e.message);
    }
  }

  // Test 2: Multiple sessions
  log('\n--- Test 2: Multiple Sessions ---');
  {
    const client1 = await createMCPClient();
    const client2 = await createMCPClient();
    sessions.push(client1, client2);

    try {
      const diag1 = await client1.tool('create_diagram', { name: 'Multi 1' });
      const diag2 = await client2.tool('create_diagram', { name: 'Multi 2' });

      const id1 = diag1?.diagram?.id;
      const id2 = diag2?.diagram?.id;
      
      recordTest('Multiple sessions can create diagrams', 
        id1 && id2 && id1 !== id2);

      await client1.tool('create_element', {
        type: 'rectangle', x: 50, y: 50, width: 100, height: 50
      });

      await client2.tool('create_element', {
        type: 'rectangle', x: 200, y: 200, width: 100, height: 50
      });

      const state1 = await client1.tool('get_diagram_state', { diagramId: id1 });
      const state2 = await client2.tool('get_diagram_state', { diagramId: id2 });

      recordTest('Each session maintains separate state',
        (state1?.elements?.length > 0) && (state2?.elements?.length > 0));

    } catch (e) {
      recordTest('Multiple sessions test', false, e.message);
    }
  }

  // Test 3: Session restart / diagram reuse
  log('\n--- Test 3: Session Restart & Diagram Reuse ---');
  {
    const client1 = await createMCPClient();
    sessions.push(client1);

    try {
      const diagram = await client1.tool('create_diagram', { name: 'Persistent' });
      const diagramId = diagram?.diagram?.id;
      
      await client1.tool('create_element', {
        type: 'rectangle',
        x: 100,
        y: 100,
        width: 150,
        height: 80,
        text: 'Survives Restart'
      });
      
      client1.destroy();

      await new Promise(r => setTimeout(r, 500));

      const client2 = await createMCPClient();
      sessions.push(client2);

      await client2.tool('load_diagram', { diagramId });
      const state = await client2.tool('get_diagram_state', { diagramId });

      recordTest('Diagram persists after session restart', 
        state?.elements?.some?.(e => e.text === 'Survives Restart'));

    } catch (e) {
      recordTest('Session restart test', false, e.message);
    }
  }

  // Test 4: list_diagrams functionality
  log('\n--- Test 4: list_diagrams ---');
  {
    const client = await createMCPClient();
    sessions.push(client);

    try {
      await cleanDB();

      for (const name of ['Alpha', 'Beta', 'Gamma']) {
        await client.tool('create_diagram', { name });
      }

      const diagrams = await client.tool('list_diagrams');
      recordTest('list_diagrams returns all diagrams',
        diagrams?.diagrams?.length >= 3);

      const recent = await client.tool('list_recent_diagrams', { limit: 2 });
      recordTest('list_recent_diagrams respects limit',
        recent?.diagrams?.length <= 2);

      const search = await client.tool('search_diagrams', { query: 'Alpha' });
      recordTest('search_diagrams finds by name',
        search?.diagrams?.some?.(d => d.name === 'Alpha'));

    } catch (e) {
      recordTest('list_diagrams test', false, e.message);
    }
  }

  // Test 5: Diagram reuse vs creation
  log('\n--- Test 5: Diagram Reuse vs Creation ---');
  {
    const client = await createMCPClient();
    sessions.push(client);

    try {
      const newDiag = await client.tool('create_diagram', { name: 'Reuse Test' });
      const newDiagId = newDiag?.diagram?.id;
      
      await client.tool('create_element', {
        type: 'rectangle', x: 0, y: 0, width: 100, height: 50
      });

      const dupDiag = await client.tool('duplicate_diagram', { 
        diagramId: newDiagId,
        name: 'Duplicated'
      });
      const dupDiagId = dupDiag?.diagram?.id;
      
      recordTest('duplicate_diagram creates copy', !!dupDiagId);

      await client2.tool('set_active_diagram', { diagramId: dupDiagId });
      const active = await client2.tool('get_active_diagram');
      recordTest('set_active_diagram switches context', 
        active?.id === dupDiagId);

      const dupState = await client2.tool('get_diagram_state', { diagramId: dupDiagId });
      recordTest('Duplicated diagram has elements',
        dupState?.elements?.length > 0);

    } catch (e) {
      recordTest('Diagram reuse test', false, e.message);
    }
  }

  // Test 6: Edge cases
  log('\n--- Test 6: Edge Cases ---');
  {
    const client = await createMCPClient();
    sessions.push(client);

    try {
      // Empty name handling
      let emptyNameError = false;
      try {
        await client.tool('create_diagram', { name: '' });
      } catch (e) {
        emptyNameError = e.message?.includes('name') || e.message?.includes('empty') || e.message?.includes('required');
      }
      recordTest('Empty name rejected', emptyNameError);

      // Non-existent diagram
      const fakeResult = await client.tool('get_diagram', { diagramId: 'non-existent-id' });
      recordTest('Non-existent diagram handled', 
        !fakeResult?.id || fakeResult?.error);

      // Non-existent element
      const fakeElem = await client.tool('get_element', { id: 'fake-id' });
      recordTest('Non-existent element handled', 
        !fakeElem?.id || fakeElem?.error);

      // Update invalid element
      let updateError = false;
      try {
        await client.tool('update_element', { id: 'invalid', x: 0, y: 0 });
      } catch (e) {
        updateError = true;
      }
      recordTest('Update invalid element handled', updateError);

      // Delete invalid element
      let deleteError = false;
      try {
        await client.tool('delete_element', { id: 'fake' });
      } catch (e) {
        deleteError = true;
      }
      recordTest('Delete invalid element handled', deleteError);

    } catch (e) {
      recordTest('Edge case tests', false, e.message);
    }
  }

  // Test 7: Snapshot/restore
  log('\n--- Test 7: Snapshot & Restore ---');
  {
    const client = await createMCPClient();
    sessions.push(client);

    try {
      const diagram = await client.tool('create_diagram', { name: 'Snapshot Test' });
      const diagramId = diagram?.diagram?.id;

      await client.tool('create_element', {
        type: 'rectangle', x: 0, y: 0, width: 100, height: 50, text: 'Before'
      });

      await client.tool('snapshot_scene', { name: 'before-change' });

      await client.tool('create_element', {
        type: 'rectangle', x: 150, y: 0, width: 100, height: 50, text: 'After'
      });

      let state = await client.tool('get_diagram_state', { diagramId });
      recordTest('Snapshot captures state after changes', 
        state?.elements?.length === 2);

      await client.tool('restore_snapshot', { name: 'before-change', diagramId });

      state = await client.tool('get_diagram_state', { diagramId });
      recordTest('Restore reverts to snapshot',
        state?.elements?.some?.(e => e.text === 'Before') &&
        !state?.elements?.some?.(e => e.text === 'After'));

    } catch (e) {
      recordTest('Snapshot/restore test', false, e.message);
    }
  }

  // Test 8: Mermaid conversion
  log('\n--- Test 8: Mermaid Conversion ---');
  {
    const client = await createMCPClient();
    sessions.push(client);

    try {
      await client.tool('create_diagram', { name: 'Mermaid Test' });

      await client.tool('create_from_mermaid', {
        mermaidDiagram: 'graph TD; A-->B; B-->C'
      });

      const state = await client.tool('get_diagram_state');
      recordTest('Mermaid creates elements', 
        state?.elements?.length >= 4);

    } catch (e) {
      recordTest('Mermaid conversion', false, e.message);
    }
  }

  // Cleanup
  log('\n--- Cleanup ---');
  for (const s of sessions) {
    s.destroy();
  }
  sessions.length = 0;
  await cleanDB();

  // Summary
  log('\n' + '='.repeat(60));
  log('TEST SUMMARY');
  log('='.repeat(60));
  
  const passed = tests.filter(t => t.passed).length;
  const failed = tests.filter(t => !t.passed).length;
  
  console.log(`\nTotal: ${tests.length} | Passed: ${passed} | Failed: ${failed}`);
  
  if (failed > 0) {
    console.log('\nFailed tests:');
    tests.filter(t => !t.passed).forEach(t => {
      console.log(`  - ${t.name}: ${t.error || 'null'}`);
    });
  }
  
  console.log('\n' + '='.repeat(60));
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('Test suite error:', e);
  process.exit(1);
});
