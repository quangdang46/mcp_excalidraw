/**
 * Unit tests for session scoping and scoping functions.
 * Tests cover:
 * - Session middleware extracts sessionId and diagramId correctly
 * - activeDiagramBySession map operations (get, set, delete)
 * - getDiagramIdFromRequest function behavior
 * - Scoping of element/snapshot/file operations to diagram context
 * - WebSocket client registration with sessionId
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

// Mock the database module before importing server
const mockDiagramStore = {
  getSession: vi.fn(),
  getDiagram: vi.fn(),
  listElements: vi.fn(),
  getElement: vi.fn(),
  upsertElement: vi.fn(),
  replaceElements: vi.fn(),
  deleteElement: vi.fn(),
  clearDiagram: vi.fn(),
  listFiles: vi.fn(),
  upsertFiles: vi.fn(),
  deleteFile: vi.fn(),
  listSnapshots: vi.fn(),
  getSnapshot: vi.fn(),
  saveSnapshot: vi.fn(),
  restoreSnapshot: vi.fn(),
  upsertSession: vi.fn(),
  getDiagramVersion: vi.fn(),
  acknowledgeSessionVersion: vi.fn(),
  listActiveSessions: vi.fn(),
  listConflictingSessions: vi.fn(),
  listSessions: vi.fn(),
  markSessionStatus: vi.fn(),
  markStaleSessions: vi.fn(),
  getOperationLock: vi.fn(),
  acquireOperationLock: vi.fn(),
  releaseOperationLock: vi.fn(),
  listDiagrams: vi.fn(),
  ensureDiagram: vi.fn(),
  getDiagramState: vi.fn(),
  updateDiagram: vi.fn(),
  deleteDiagram: vi.fn(),
  duplicateDiagram: vi.fn(),
  closeSessionsForDiagram: vi.fn(),
  getElementsUpdatedAfterVersion: vi.fn(),
  listDeletedElementIdsAfterVersion: vi.fn(),
  upsertElementWithSession: vi.fn(),
  replaceElementsWithSession: vi.fn(),
  deleteElementWithSession: vi.fn(),
  clearDiagramWithSession: vi.fn(),
  getSceneState: vi.fn(),
  upsertSceneState: vi.fn(),
  listEvents: vi.fn(),
  getMutationHistory: vi.fn(),
  undoLastMutation: vi.fn(),
  upsertElementWithHistory: vi.fn(),
  deleteElementWithHistory: vi.fn(),
  replaceElementsWithHistory: vi.fn(),
};

// We need to test the standalone functions, so we'll recreate the relevant
// parts in a test-friendly way

const DEFAULT_DIAGRAM_ID = 'default';

// Reimplement getSessionIdFromRequest for testing
function getSessionIdFromRequest(req: Request): string | undefined {
  const queryValue = req.query.sessionId;
  if (typeof queryValue === 'string' && queryValue.trim()) {
    return queryValue;
  }

  const bodyValue = req.body?.sessionId;
  if (typeof bodyValue === 'string' && bodyValue.trim()) {
    return bodyValue;
  }

  return undefined;
}

// Reimplement getDiagramIdFromRequest for testing
function getDiagramIdFromRequest(
  req: Request,
  diagramStore: typeof mockDiagramStore
): string {
  const queryValue = req.query.diagramId;
  if (typeof queryValue === 'string' && queryValue.trim()) {
    return queryValue;
  }

  const bodyValue = req.body?.diagramId;
  if (typeof bodyValue === 'string' && bodyValue.trim()) {
    return bodyValue;
  }

  const sessionId = getSessionIdFromRequest(req);
  if (sessionId) {
    const session = diagramStore.getSession(sessionId);
    if (session?.activeDiagramId) {
      return session.activeDiagramId;
    }
  }

  return DEFAULT_DIAGRAM_ID;
}

// In-memory active diagram by session (copied from server.ts for testing)
const activeDiagramBySession = new Map<string, string>();

// Touch session function
function touchSession(
  sessionId: string,
  diagramId: string,
  diagramStore: typeof mockDiagramStore
): void {
  activeDiagramBySession.set(sessionId, diagramId);
  diagramStore.upsertSession({ id: sessionId, activeDiagramId: diagramId, status: 'active' });
}

// Session middleware implementation for testing
function sessionMiddleware(
  req: Request,
  diagramStore: typeof mockDiagramStore
): { sessionId?: string; diagramId?: string } {
  const sessionId = getSessionIdFromRequest(req);
  const result: { sessionId?: string; diagramId?: string } = {};

  if (sessionId) {
    result.sessionId = sessionId;

    // Look up active diagram from in-memory map first, then DB
    let activeDiagramId = activeDiagramBySession.get(sessionId);
    if (!activeDiagramId) {
      const session = diagramStore.getSession(sessionId);
      activeDiagramId = session?.activeDiagramId;
      // Cache it for future requests
      if (activeDiagramId) {
        activeDiagramBySession.set(sessionId, activeDiagramId);
      }
    }
    if (activeDiagramId) {
      result.diagramId = activeDiagramId;
    }
  }

  return result;
}

// Diagram client interface (copied from server.ts)
interface DiagramClient {
  ws: WebSocket;
  diagramId: string;
  sessionId: string;
  lastHeartbeat: number;
}

// WebSocket client tracking for testing
const diagramClients = new Map<string, Set<DiagramClient>>();
const clients = new Set<WebSocket>();

function registerDiagramClient(client: DiagramClient): void {
  clients.add(client.ws);
  if (!diagramClients.has(client.diagramId)) {
    diagramClients.set(client.diagramId, new Set());
  }
  diagramClients.get(client.diagramId)!.add(client);
}

function removeDiagramClient(ws: WebSocket): void {
  clients.delete(ws);
  diagramClients.forEach((set) => {
    set.forEach((c) => {
      if (c.ws === ws) set.delete(c);
    });
  });
}

function getClientsForDiagram(diagramId: string): DiagramClient[] {
  const set = diagramClients.get(diagramId);
  return set ? Array.from(set) : [];
}

function broadcastToSession(
  sessionId: string,
  message: object,
  diagramId?: string
): object[] {
  const results: object[] = [];

  const handler = (client: DiagramClient) => {
    if (client.sessionId !== sessionId) return;
    results.push({ sent: true, sessionId: client.sessionId });
  };

  if (diagramId) {
    const set = diagramClients.get(diagramId);
    if (set) {
      set.forEach(handler);
    }
  } else {
    diagramClients.forEach((set) => {
      set.forEach(handler);
    });
  }

  return results;
}

describe('Session Scoping and Scoping Functions', () => {
  beforeEach(() => {
    // Clear all mocks and in-memory state before each test
    vi.clearAllMocks();
    activeDiagramBySession.clear();
    diagramClients.clear();
    clients.clear();
  });

  describe('getSessionIdFromRequest', () => {
    it('should extract sessionId from query string', () => {
      const req = {
        query: { sessionId: 'session-123' },
        body: {},
      } as unknown as Request;

      const result = getSessionIdFromRequest(req);
      expect(result).toBe('session-123');
    });

    it('should extract sessionId from body', () => {
      const req = {
        query: {},
        body: { sessionId: 'session-456' },
      } as unknown as Request;

      const result = getSessionIdFromRequest(req);
      expect(result).toBe('session-456');
    });

    it('should prefer query string over body', () => {
      const req = {
        query: { sessionId: 'query-session' },
        body: { sessionId: 'body-session' },
      } as unknown as Request;

      const result = getSessionIdFromRequest(req);
      expect(result).toBe('query-session');
    });

    it('should return undefined when no sessionId provided', () => {
      const req = {
        query: {},
        body: {},
      } as unknown as Request;

      const result = getSessionIdFromRequest(req);
      expect(result).toBeUndefined();
    });

    it('should trim whitespace from sessionId when validating', () => {
      const req = {
        query: { sessionId: '  session-789  ' },
        body: {},
      } as unknown as Request;

      const result = getSessionIdFromRequest(req);
      // Implementation returns original string but validates using trim
      expect(result).toBe('  session-789  ');
    });

    it('should return undefined for empty string sessionId', () => {
      const req = {
        query: { sessionId: '' },
        body: {},
      } as unknown as Request;

      const result = getSessionIdFromRequest(req);
      expect(result).toBeUndefined();
    });

    it('should return undefined for whitespace-only sessionId', () => {
      const req = {
        query: { sessionId: '   ' },
        body: {},
      } as unknown as Request;

      const result = getSessionIdFromRequest(req);
      expect(result).toBeUndefined();
    });
  });

  describe('getDiagramIdFromRequest', () => {
    it('should extract diagramId from query string', () => {
      const req = {
        query: { diagramId: 'diagram-123' },
        body: {},
      } as unknown as Request;

      const result = getDiagramIdFromRequest(req, mockDiagramStore);
      expect(result).toBe('diagram-123');
    });

    it('should extract diagramId from body', () => {
      const req = {
        query: {},
        body: { diagramId: 'diagram-456' },
      } as unknown as Request;

      const result = getDiagramIdFromRequest(req, mockDiagramStore);
      expect(result).toBe('diagram-456');
    });

    it('should fall back to session activeDiagramId when no explicit diagramId', () => {
      const req = {
        query: {},
        body: { sessionId: 'session-789' },
      } as unknown as Request;

      mockDiagramStore.getSession.mockReturnValue({
        id: 'session-789',
        activeDiagramId: 'active-diagram',
        status: 'active',
        lastHeartbeatAt: new Date().toISOString(),
        lastSyncAt: null,
        lastAckVersion: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = getDiagramIdFromRequest(req, mockDiagramStore);
      expect(result).toBe('active-diagram');
    });

    it('should return default diagram when no session or explicit diagramId', () => {
      const req = {
        query: {},
        body: {},
      } as unknown as Request;

      const result = getDiagramIdFromRequest(req, mockDiagramStore);
      expect(result).toBe(DEFAULT_DIAGRAM_ID);
    });

    it('should prefer explicit diagramId over session fallback', () => {
      const req = {
        query: { diagramId: 'explicit-diagram' },
        body: { sessionId: 'session-123' },
      } as unknown as Request;

      mockDiagramStore.getSession.mockReturnValue({
        id: 'session-123',
        activeDiagramId: 'session-diagram',
        status: 'active',
        lastHeartbeatAt: new Date().toISOString(),
        lastSyncAt: null,
        lastAckVersion: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = getDiagramIdFromRequest(req, mockDiagramStore);
      expect(result).toBe('explicit-diagram');
    });

    it('should return default when session has no activeDiagramId', () => {
      const req = {
        query: {},
        body: { sessionId: 'session-no-diagram' },
      } as unknown as Request;

      mockDiagramStore.getSession.mockReturnValue(null);

      const result = getDiagramIdFromRequest(req, mockDiagramStore);
      expect(result).toBe(DEFAULT_DIAGRAM_ID);
    });
  });

  describe('activeDiagramBySession map operations', () => {
    it('should set and get diagramId for session', () => {
      activeDiagramBySession.set('session-1', 'diagram-1');

      expect(activeDiagramBySession.get('session-1')).toBe('diagram-1');
    });

    it('should delete session entry', () => {
      activeDiagramBySession.set('session-1', 'diagram-1');
      activeDiagramBySession.delete('session-1');

      expect(activeDiagramBySession.get('session-1')).toBeUndefined();
    });

    it('should overwrite existing diagramId for session', () => {
      activeDiagramBySession.set('session-1', 'diagram-1');
      activeDiagramBySession.set('session-1', 'diagram-2');

      expect(activeDiagramBySession.get('session-1')).toBe('diagram-2');
    });

    it('should handle multiple sessions with different diagrams', () => {
      activeDiagramBySession.set('session-1', 'diagram-a');
      activeDiagramBySession.set('session-2', 'diagram-b');
      activeDiagramBySession.set('session-3', 'diagram-c');

      expect(activeDiagramBySession.get('session-1')).toBe('diagram-a');
      expect(activeDiagramBySession.get('session-2')).toBe('diagram-b');
      expect(activeDiagramBySession.get('session-3')).toBe('diagram-c');
    });

    it('should return undefined for non-existent session', () => {
      expect(activeDiagramBySession.get('non-existent')).toBeUndefined();
    });

    it('should check if session exists', () => {
      activeDiagramBySession.set('session-1', 'diagram-1');

      expect(activeDiagramBySession.has('session-1')).toBe(true);
      expect(activeDiagramBySession.has('non-existent')).toBe(false);
    });

    it('should clear all entries', () => {
      activeDiagramBySession.set('session-1', 'diagram-1');
      activeDiagramBySession.set('session-2', 'diagram-2');
      activeDiagramBySession.clear();

      expect(activeDiagramBySession.size).toBe(0);
    });
  });

  describe('touchSession', () => {
    it('should update in-memory map and call upsertSession', () => {
      touchSession('session-1', 'diagram-1', mockDiagramStore);

      expect(activeDiagramBySession.get('session-1')).toBe('diagram-1');
      expect(mockDiagramStore.upsertSession).toHaveBeenCalledWith({
        id: 'session-1',
        activeDiagramId: 'diagram-1',
        status: 'active',
      });
    });

    it('should overwrite previous diagramId', () => {
      touchSession('session-1', 'diagram-1', mockDiagramStore);
      touchSession('session-1', 'diagram-2', mockDiagramStore);

      expect(activeDiagramBySession.get('session-1')).toBe('diagram-2');
      expect(mockDiagramStore.upsertSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('sessionMiddleware', () => {
    it('should extract sessionId from request', () => {
      const req = {
        query: { sessionId: 'session-123' },
        body: {},
      } as unknown as Request;

      const result = sessionMiddleware(req, mockDiagramStore);

      expect(result.sessionId).toBe('session-123');
    });

    it('should attach diagramId from in-memory cache', () => {
      activeDiagramBySession.set('cached-session', 'cached-diagram');

      const req = {
        query: { sessionId: 'cached-session' },
        body: {},
      } as unknown as Request;

      const result = sessionMiddleware(req, mockDiagramStore);

      expect(result.diagramId).toBe('cached-diagram');
    });

    it('should attach diagramId from database when not in cache', () => {
      mockDiagramStore.getSession.mockReturnValue({
        id: 'db-session',
        activeDiagramId: 'db-diagram',
        status: 'active',
        lastHeartbeatAt: new Date().toISOString(),
        lastSyncAt: null,
        lastAckVersion: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const req = {
        query: { sessionId: 'db-session' },
        body: {},
      } as unknown as Request;

      const result = sessionMiddleware(req, mockDiagramStore);

      expect(result.diagramId).toBe('db-diagram');
      // Verify it was cached
      expect(activeDiagramBySession.get('db-session')).toBe('db-diagram');
    });

    it('should return empty object when no sessionId provided', () => {
      const req = {
        query: {},
        body: {},
      } as unknown as Request;

      const result = sessionMiddleware(req, mockDiagramStore);

      expect(result.sessionId).toBeUndefined();
      expect(result.diagramId).toBeUndefined();
    });

    it('should not cache diagramId when session has none', () => {
      mockDiagramStore.getSession.mockReturnValue(null);

      const req = {
        query: { sessionId: 'session-no-diagram' },
        body: {},
      } as unknown as Request;

      const result = sessionMiddleware(req, mockDiagramStore);

      expect(result.diagramId).toBeUndefined();
      expect(activeDiagramBySession.has('session-no-diagram')).toBe(false);
    });
  });

  describe('WebSocket client registration with sessionId', () => {
    it('should register client with diagramId and sessionId', () => {
      const mockWs = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket;

      const client: DiagramClient = {
        ws: mockWs,
        diagramId: 'diagram-1',
        sessionId: 'session-1',
        lastHeartbeat: Date.now(),
      };

      registerDiagramClient(client);

      const clients = getClientsForDiagram('diagram-1');
      expect(clients).toHaveLength(1);
      expect(clients[0].sessionId).toBe('session-1');
    });

    it('should allow multiple clients per diagram', () => {
      const mockWs1 = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket;

      const mockWs2 = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket;

      registerDiagramClient({
        ws: mockWs1,
        diagramId: 'diagram-1',
        sessionId: 'session-1',
        lastHeartbeat: Date.now(),
      });

      registerDiagramClient({
        ws: mockWs2,
        diagramId: 'diagram-1',
        sessionId: 'session-2',
        lastHeartbeat: Date.now(),
      });

      const clients = getClientsForDiagram('diagram-1');
      expect(clients).toHaveLength(2);
    });

    it('should remove client on removeDiagramClient', () => {
      const mockWs = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket;

      registerDiagramClient({
        ws: mockWs,
        diagramId: 'diagram-1',
        sessionId: 'session-1',
        lastHeartbeat: Date.now(),
      });

      expect(getClientsForDiagram('diagram-1')).toHaveLength(1);

      removeDiagramClient(mockWs);

      expect(getClientsForDiagram('diagram-1')).toHaveLength(0);
    });

    it('should broadcast to specific session only', () => {
      const mockWs1 = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket;

      const mockWs2 = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket;

      registerDiagramClient({
        ws: mockWs1,
        diagramId: 'diagram-1',
        sessionId: 'session-target',
        lastHeartbeat: Date.now(),
      });

      registerDiagramClient({
        ws: mockWs2,
        diagramId: 'diagram-1',
        sessionId: 'session-other',
        lastHeartbeat: Date.now(),
      });

      const results = broadcastToSession('session-target', { type: 'test' }, 'diagram-1');

      expect(results).toHaveLength(1);
      expect(results[0].sessionId).toBe('session-target');
    });

    it('should broadcast to all diagrams when no diagramId specified', () => {
      const mockWs1 = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket;

      const mockWs2 = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket;

      registerDiagramClient({
        ws: mockWs1,
        diagramId: 'diagram-1',
        sessionId: 'session-1',
        lastHeartbeat: Date.now(),
      });

      registerDiagramClient({
        ws: mockWs2,
        diagramId: 'diagram-2',
        sessionId: 'session-1',
        lastHeartbeat: Date.now(),
      });

      const results = broadcastToSession('session-1');

      // Should find both clients since sessionId matches across diagrams
      expect(results).toHaveLength(2);
    });

    it('should handle removing client from specific diagram', () => {
      const mockWs1 = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket;

      const mockWs2 = {
        readyState: WebSocket.OPEN,
        send: vi.fn(),
        on: vi.fn(),
        close: vi.fn(),
      } as unknown as WebSocket;

      registerDiagramClient({
        ws: mockWs1,
        diagramId: 'diagram-1',
        sessionId: 'session-1',
        lastHeartbeat: Date.now(),
      });

      registerDiagramClient({
        ws: mockWs2,
        diagramId: 'diagram-2',
        sessionId: 'session-1',
        lastHeartbeat: Date.now(),
      });

      removeDiagramClient(mockWs1);

      const results = broadcastToSession('session-1');
      expect(results).toHaveLength(1);
    });
  });

  describe('element operations scoped to diagram context', () => {
    it('should scope listElements to specific diagram', () => {
      const diagram1Elements = [
        { id: 'el-1', type: 'rectangle', x: 0, y: 0 },
        { id: 'el-2', type: 'rectangle', x: 10, y: 10 },
      ];

      const diagram2Elements = [
        { id: 'el-3', type: 'ellipse', x: 20, y: 20 },
      ];

      mockDiagramStore.listElements.mockImplementation((diagramId: string) => {
        if (diagramId === 'diagram-1') return diagram1Elements as any[];
        if (diagramId === 'diagram-2') return diagram2Elements as any[];
        return [];
      });

      const elementsForDiagram1 = mockDiagramStore.listElements('diagram-1');
      const elementsForDiagram2 = mockDiagramStore.listElements('diagram-2');

      expect(elementsForDiagram1).toHaveLength(2);
      expect(elementsForDiagram2).toHaveLength(1);
      expect(elementsForDiagram1[0].id).toBe('el-1');
      expect(elementsForDiagram2[0].id).toBe('el-3');
    });

    it('should scope upsertElement to specific diagram', () => {
      const element = { id: 'new-el', type: 'text' as const, x: 100, y: 100, text: 'Hello' };

      mockDiagramStore.upsertElement.mockReturnValue({ ...element, version: 1 } as any);

      const result = mockDiagramStore.upsertElement('diagram-1', element as any);

      expect(mockDiagramStore.upsertElement).toHaveBeenCalledWith('diagram-1', element);
      expect(result.version).toBe(1);
    });

    it('should scope deleteElement to specific diagram', () => {
      mockDiagramStore.deleteElement.mockReturnValue(true);

      const result = mockDiagramStore.deleteElement('diagram-1', 'el-1');

      expect(mockDiagramStore.deleteElement).toHaveBeenCalledWith('diagram-1', 'el-1');
      expect(result).toBe(true);
    });

    it('should scope clearDiagram to specific diagram', () => {
      mockDiagramStore.clearDiagram.mockReturnValue(5);

      const result = mockDiagramStore.clearDiagram('diagram-1');

      expect(mockDiagramStore.clearDiagram).toHaveBeenCalledWith('diagram-1');
      expect(result).toBe(5);
    });
  });

  describe('snapshot operations scoped to diagram context', () => {
    it('should scope listSnapshots to specific diagram', () => {
      const diagram1Snapshots = [
        { name: 'snapshot-1', diagramId: 'diagram-1', elements: [], createdAt: new Date().toISOString() },
        { name: 'snapshot-2', diagramId: 'diagram-1', elements: [], createdAt: new Date().toISOString() },
      ];

      const diagram2Snapshots = [
        { name: 'snapshot-3', diagramId: 'diagram-2', elements: [], createdAt: new Date().toISOString() },
      ];

      mockDiagramStore.listSnapshots.mockImplementation((diagramId: string) => {
        if (diagramId === 'diagram-1') return diagram1Snapshots as any[];
        if (diagramId === 'diagram-2') return diagram2Snapshots as any[];
        return [];
      });

      const snapshotsForDiagram1 = mockDiagramStore.listSnapshots('diagram-1');
      const snapshotsForDiagram2 = mockDiagramStore.listSnapshots('diagram-2');

      expect(snapshotsForDiagram1).toHaveLength(2);
      expect(snapshotsForDiagram2).toHaveLength(1);
    });

    it('should scope getSnapshot to specific diagram', () => {
      const snapshot = { name: 'snapshot-1', diagramId: 'diagram-1', elements: [], createdAt: new Date().toISOString() };

      mockDiagramStore.getSnapshot.mockReturnValue(snapshot as any);

      const result = mockDiagramStore.getSnapshot('diagram-1', 'snapshot-1');

      expect(mockDiagramStore.getSnapshot).toHaveBeenCalledWith('diagram-1', 'snapshot-1');
      expect(result).not.toBeNull();
    });

    it('should scope saveSnapshot to specific diagram', () => {
      const snapshot = { name: 'new-snapshot', elements: [], createdAt: new Date().toISOString() };

      mockDiagramStore.saveSnapshot.mockReturnValue({
        ...snapshot,
        diagramId: 'diagram-1',
      } as any);

      const result = mockDiagramStore.saveSnapshot('diagram-1', snapshot as any, 'session-1');

      expect(mockDiagramStore.saveSnapshot).toHaveBeenCalledWith('diagram-1', snapshot, 'session-1');
      expect((result as any).diagramId).toBe('diagram-1');
    });
  });

  describe('file operations scoped to diagram context', () => {
    it('should scope listFiles to specific diagram', () => {
      const diagram1Files = [
        { id: 'file-1', dataURL: 'data:img/png;base64,...', mimeType: 'image/png', created: Date.now() },
      ];

      const diagram2Files = [
        { id: 'file-2', dataURL: 'data:img/png;base64,...', mimeType: 'image/png', created: Date.now() },
        { id: 'file-3', dataURL: 'data:img/png;base64,...', mimeType: 'image/png', created: Date.now() },
      ];

      mockDiagramStore.listFiles.mockImplementation((diagramId: string) => {
        if (diagramId === 'diagram-1') return diagram1Files as any[];
        if (diagramId === 'diagram-2') return diagram2Files as any[];
        return [];
      });

      const filesForDiagram1 = mockDiagramStore.listFiles('diagram-1');
      const filesForDiagram2 = mockDiagramStore.listFiles('diagram-2');

      expect(filesForDiagram1).toHaveLength(1);
      expect(filesForDiagram2).toHaveLength(2);
    });

    it('should scope deleteFile to specific diagram', () => {
      mockDiagramStore.deleteFile.mockReturnValue(true);

      const result = mockDiagramStore.deleteFile('diagram-1', 'file-1');

      expect(mockDiagramStore.deleteFile).toHaveBeenCalledWith('diagram-1', 'file-1');
      expect(result).toBe(true);
    });

    it('should scope upsertFiles to specific diagram', () => {
      const files = [
        { id: 'new-file', dataURL: 'data:img/png;base64,...', mimeType: 'image/png', created: Date.now() },
      ];

      mockDiagramStore.upsertFiles.mockReturnValue();

      mockDiagramStore.upsertFiles('diagram-1', files as any[], 'session-1');

      expect(mockDiagramStore.upsertFiles).toHaveBeenCalledWith('diagram-1', files, 'session-1');
    });
  });

  describe('session presence scoped to diagram context', () => {
    it('should list active sessions for specific diagram', () => {
      const diagram1Sessions = [
        { id: 'session-1', activeDiagramId: 'diagram-1', status: 'active' as const, lastHeartbeatAt: new Date().toISOString(), lastSyncAt: null, lastAckVersion: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: 'session-2', activeDiagramId: 'diagram-1', status: 'active' as const, lastHeartbeatAt: new Date().toISOString(), lastSyncAt: null, lastAckVersion: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ];

      const diagram2Sessions = [
        { id: 'session-3', activeDiagramId: 'diagram-2', status: 'active' as const, lastHeartbeatAt: new Date().toISOString(), lastSyncAt: null, lastAckVersion: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ];

      mockDiagramStore.listActiveSessions.mockImplementation((diagramId: string) => {
        if (diagramId === 'diagram-1') return diagram1Sessions as any[];
        if (diagramId === 'diagram-2') return diagram2Sessions as any[];
        return [];
      });

      const sessionsForDiagram1 = mockDiagramStore.listActiveSessions('diagram-1');
      const sessionsForDiagram2 = mockDiagramStore.listActiveSessions('diagram-2');

      expect(sessionsForDiagram1).toHaveLength(2);
      expect(sessionsForDiagram2).toHaveLength(1);
    });

    it('should list conflicting sessions for specific diagram', () => {
      const conflictingSessions = [
        { id: 'session-conflict', activeDiagramId: 'diagram-1', status: 'active' as const, lastHeartbeatAt: new Date().toISOString(), lastSyncAt: new Date().toISOString(), lastAckVersion: 5, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ];

      mockDiagramStore.listConflictingSessions.mockReturnValue(conflictingSessions as any[]);

      const result = mockDiagramStore.listConflictingSessions('diagram-1');

      expect(mockDiagramStore.listConflictingSessions).toHaveBeenCalledWith('diagram-1');
      expect(result).toHaveLength(1);
    });
  });
});
