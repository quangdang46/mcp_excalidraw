import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import logger from './utils/logger.js';
import {
  DEFAULT_DIAGRAM_ID,
  generateId,
  EXCALIDRAW_ELEMENT_TYPES,
  ServerElement,
  ExcalidrawElementType,
  ExcalidrawFile,
  WebSocketMessage,
  ElementCreatedMessage,
  ElementUpdatedMessage,
  ElementDeletedMessage,
  BatchCreatedMessage,
  SyncStatusMessage,
  InitialElementsMessage,
  Snapshot,
  normalizeFontFamily,
  validateElementLimits,
  validatePayloadSize,
  validateBatchOperation,
  SyncMetrics,
  PerformanceMetrics,
  HealthMetrics,
  VALIDATION_LIMITS,
} from './types.js';
import { diagramStore } from './db.js';
import { z } from 'zod';
import WebSocket from 'ws';
import {
  recordSyncMetric,
  recordPerformanceMetric,
  getRecentSyncMetrics,
  getRecentPerformanceMetrics,
  getHealthMetrics,
} from './utils/observability.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static files from the build directory
const staticDir = path.join(__dirname, '../dist');
app.use(express.static(staticDir));
// Also serve frontend assets
app.use(express.static(path.join(__dirname, '../dist/frontend')));
// Serve Excalidraw fonts so the font subsetting worker can fetch them for export
app.use('/assets/fonts', express.static(
  path.join(__dirname, '../node_modules/@excalidraw/excalidraw/dist/prod/fonts')
));

// Active diagram tracking per session (in-memory, synced with DB)
const activeDiagramBySession = new Map<string, string>(); // sessionId -> diagramId

// Session middleware: extracts session context and resolves active diagram
function sessionMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const sessionId = getSessionIdFromRequest(req);
  if (sessionId) {
    // Attach sessionId to request for downstream handlers
    (req as any).sessionId = sessionId;

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
      (req as any).diagramId = activeDiagramId;
    }
  }
  next();
}

// Register session middleware early in the chain
app.use(sessionMiddleware);

// WebSocket connections — scoped by diagramId
interface DiagramClient {
  ws: WebSocket;
  diagramId: string;
  sessionId: string;
  lastHeartbeat: number;
}

const clients = new Set<WebSocket>(); // legacy global set kept for compat
const diagramClients = new Map<string, Set<DiagramClient>>(); // diagramId → clients

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

function listDiagramFiles(diagramId: string): Record<string, ExcalidrawFile> {
  const filesObj: Record<string, ExcalidrawFile> = {};
  diagramStore.listFiles(diagramId).forEach(file => {
    filesObj[file.id] = file;
  });
  return filesObj;
}

// Broadcast to all clients watching a specific diagram
function broadcastToDiagram(diagramId: string, message: WebSocketMessage, excludeSessionId?: string): void {
  const data = JSON.stringify(message);
  const set = diagramClients.get(diagramId);
  if (!set) return;
  set.forEach(client => {
    if (excludeSessionId && client.sessionId === excludeSessionId) return;
    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    } catch (err) {
      logger.warn('Failed to send to diagram client, removing');
      removeDiagramClient(client.ws);
    }
  });
}

// Broadcast to all clients belonging to a specific session
function broadcastToSession(sessionId: string, message: WebSocketMessage, diagramId?: string): void {
  const data = JSON.stringify(message);
  // If diagramId is provided, scope the search to that diagram's clients
  // Otherwise search all diagram client sets
  if (diagramId) {
    const set = diagramClients.get(diagramId);
    if (set) {
      set.forEach(client => {
        if (client.sessionId !== sessionId) return;
        try {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(data);
          }
        } catch (err) {
          logger.warn('Failed to send to session client, removing');
          removeDiagramClient(client.ws);
        }
      });
    }
  } else {
    // Search all diagrams for clients of this session
    diagramClients.forEach(set => {
      set.forEach(client => {
        if (client.sessionId !== sessionId) return;
        try {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(data);
          }
        } catch (err) {
          logger.warn('Failed to send to session client, removing');
          removeDiagramClient(client.ws);
        }
      });
    });
  }
}

// Broadcast to all connected clients (global fallback)
function broadcast(message: WebSocketMessage, diagramId: string): void {
  broadcastToDiagram(diagramId, message);
}

function currentElements(diagramId: string): ServerElement[] {
  return diagramStore.listElements(diagramId);
}

function currentElementCount(diagramId: string): number {
  return currentElements(diagramId).length;
}

function getElementMap(diagramId: string): Map<string, ServerElement> {
  return new Map(currentElements(diagramId).map(element => [element.id, element]));
}

function persistElement(diagramId: string, element: ServerElement): ServerElement {
  return diagramStore.upsertElement(diagramId, element);
}

function persistElements(diagramId: string, nextElements: ServerElement[]): void {
  diagramStore.replaceElements(diagramId, nextElements);
}

function removeElement(diagramId: string, elementId: string): boolean {
  return diagramStore.deleteElement(diagramId, elementId);
}

function clearElements(diagramId: string): number {
  return diagramStore.clearDiagram(diagramId);
}

function getSnapshotMap(diagramId: string): Map<string, Snapshot> {
  return new Map(
    diagramStore.listSnapshots(diagramId).map(snapshot => [snapshot.name, {
      name: snapshot.name,
      elements: snapshot.elements,
      createdAt: snapshot.createdAt,
    }])
  );
}

function getSnapshotByName(diagramId: string, name: string): Snapshot | null {
  const snapshot = diagramStore.getSnapshot(diagramId, name);
  if (!snapshot) return null;
  return {
    name: snapshot.name,
    elements: snapshot.elements,
    createdAt: snapshot.createdAt,
  };
}

function saveSnapshotRecord(diagramId: string, snapshot: Snapshot, sessionId?: string): void {
  diagramStore.saveSnapshot(diagramId, snapshot, sessionId);

  // Clean up old auto-* snapshots for this diagram, keeping only 3 most recent
  if (snapshot.name.startsWith('auto-')) {
    const allSnapshots = Array.from(getSnapshotMap(diagramId).values())
      .filter(s => s.name.startsWith('auto-'))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (allSnapshots.length > 3) {
      const toDelete = allSnapshots.slice(3);
      toDelete.forEach(s => {
        diagramStore.deleteSnapshot(diagramId, s.name);
        logger.debug(`Cleaned up old backup: ${s.name}`);
      });
    }
  }
}

function createAutomaticBackup(diagramId: string, reason: string, sessionId?: string): Snapshot | null {
  const elements = currentElements(diagramId);
  if (elements.length === 0) {
    return null;
  }

  const snapshot: Snapshot = {
    name: `auto-${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    elements,
    createdAt: new Date().toISOString(),
  };

  saveSnapshotRecord(diagramId, snapshot, sessionId);
  return snapshot;
}

function upsertFiles(diagramId: string, nextFiles: ExcalidrawFile[], sessionId?: string): void {
  diagramStore.upsertFiles(diagramId, nextFiles, sessionId);
}

function deleteFileRecord(diagramId: string, fileId: string): boolean {
  return diagramStore.deleteFile(diagramId, fileId);
}

function listFiles(diagramId: string): ExcalidrawFile[] {
  return diagramStore.listFiles(diagramId);
}

function touchSession(sessionId: string, diagramId = DEFAULT_DIAGRAM_ID): void {
  // Update in-memory active diagram map
  activeDiagramBySession.set(sessionId, diagramId);
  // Persist to DB
  diagramStore.upsertSession({ id: sessionId, activeDiagramId: diagramId, status: 'active' });
}

const serverSessionId = 'canvas-server';
touchSession(serverSessionId, DEFAULT_DIAGRAM_ID);

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

function getDiagramIdFromRequest(req: Request): string {
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

function normalizeLineBreakMarkup(text: string): string {
  return text
    .replace(/<\s*b\s*r\s*\/?\s*>/gi, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

// WebSocket connection handling
wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const diagramId = url.searchParams.get('diagramId') || DEFAULT_DIAGRAM_ID;
  const sessionId = url.searchParams.get('sessionId') || `ws-${generateId()}`;

  const client: DiagramClient = { ws, diagramId, sessionId, lastHeartbeat: Date.now() };
  registerDiagramClient(client);
  logger.info(`New WebSocket connection: diagram=${diagramId} session=${sessionId}`);

  const filesObj = listDiagramFiles(diagramId);
  const initialElements = currentElements(diagramId);
  const initialMessage: InitialElementsMessage & { files?: Record<string, ExcalidrawFile> } = {
    type: 'initial_elements',
    elements: initialElements,
    ...(Object.keys(filesObj).length > 0 ? { files: filesObj } : {})
  };
  ws.send(JSON.stringify(initialMessage));

  const syncMessage: SyncStatusMessage = {
    type: 'sync_status',
    elementCount: initialElements.length,
    timestamp: new Date().toISOString()
  };
  ws.send(JSON.stringify(syncMessage));

  touchSession(sessionId, diagramId);

  ws.on('close', () => {
    removeDiagramClient(ws);
    diagramStore.markSessionStatus(sessionId, 'closed');
    // Clean up in-memory session tracking
    activeDiagramBySession.delete(sessionId);
    logger.info(`WebSocket closed: diagram=${diagramId} session=${sessionId}`);
  });

  ws.on('error', (error) => {
    logger.error('WebSocket error:', error);
    removeDiagramClient(ws);
  });
});

// Schema validation
const CreateElementSchema = z.object({
  id: z.string().optional(), // Allow passing ID for MCP sync
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  // Arrow-specific properties
  points: z.any().optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  // Arrow binding properties (preserved for Excalidraw frontend)
  startBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  endBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  boundElements: z.array(z.object({
    id: z.string(),
    type: z.enum(['arrow', 'text']),
  })).nullable().optional(),
  // Image-specific properties
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
});

const UpdateElementSchema = z.object({
  id: z.string(),
  type: z.enum(Object.values(EXCALIDRAW_ELEMENT_TYPES) as [ExcalidrawElementType, ...ExcalidrawElementType[]]).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.string().optional(),
  roughness: z.number().optional(),
  opacity: z.number().optional(),
  text: z.string().optional(),
  originalText: z.string().optional(),
  label: z.object({
    text: z.string()
  }).optional(),
  fontSize: z.number().optional(),
  fontFamily: z.union([z.string(), z.number()]).optional(),
  groupIds: z.array(z.string()).optional(),
  locked: z.boolean().optional(),
  roundness: z.object({ type: z.number(), value: z.number().optional() }).nullable().optional(),
  fillStyle: z.string().optional(),
  points: z.array(z.union([
    z.tuple([z.number(), z.number()]),
    z.object({ x: z.number(), y: z.number() })
  ])).optional(),
  start: z.object({ id: z.string() }).optional(),
  end: z.object({ id: z.string() }).optional(),
  startArrowhead: z.string().nullable().optional(),
  endArrowhead: z.string().nullable().optional(),
  elbowed: z.boolean().optional(),
  // Arrow binding properties (preserved for Excalidraw frontend)
  startBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  endBinding: z.object({
    elementId: z.string(),
    focus: z.number().optional(),
    gap: z.number().optional(),
    fixedPoint: z.tuple([z.number(), z.number()]).nullable().optional(),
    mode: z.string().optional(),
  }).nullable().optional(),
  boundElements: z.array(z.object({
    id: z.string(),
    type: z.enum(['arrow', 'text']),
  })).nullable().optional(),
  // Image-specific properties
  fileId: z.string().optional(),
  status: z.string().optional(),
  scale: z.tuple([z.number(), z.number()]).optional(),
});

// API Routes

// Get all elements
app.get('/api/elements', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const elementsArray = currentElements(diagramId);
    res.json({
      success: true,
      elements: elementsArray,
      count: elementsArray.length
    });
  } catch (error) {
    logger.error('Error fetching elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Create new element
app.post('/api/elements', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const sessionId = getSessionIdFromRequest(req);
    const params = CreateElementSchema.parse(req.body);
    logger.info('Creating element via API', { type: params.type, diagramId, sessionId });

    const id = params.id || generateId();
    const element: ServerElement = {
      id,
      ...params,
      fontFamily: normalizeFontFamily(params.fontFamily),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1
    };

    if (element.type === 'arrow' || element.type === 'line') {
      resolveArrowBindings(diagramId, [element]);
    }

    const persistedElement = sessionId
      ? diagramStore.upsertElementWithSession(diagramId, element, sessionId)
      : persistElement(diagramId, element);

    if (sessionId) {
      touchSession(sessionId, diagramId);
    }

    const message: ElementCreatedMessage = {
      type: 'element_created',
      element: persistedElement
    };
    if (sessionId) {
      broadcastToSession(sessionId, message, diagramId);
    }

    res.json({
      success: true,
      element: persistedElement
    });
  } catch (error) {
    logger.error('Error creating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Update element
app.put('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates = UpdateElementSchema.parse({ id, ...req.body });

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const diagramId = getDiagramIdFromRequest(req);
    const sessionId = getSessionIdFromRequest(req);
    const existingElement = diagramStore.getElement(diagramId, id);
    if (!existingElement) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    const updatedElement: ServerElement = {
      ...existingElement,
      ...updates,
      fontFamily: updates.fontFamily !== undefined ? normalizeFontFamily(updates.fontFamily) : existingElement.fontFamily,
      updatedAt: new Date().toISOString(),
      version: (existingElement.version || 0) + 1
    };

    // Keep Excalidraw text source in sync when clients update text via REST.
    // If originalText lags behind text, rendered wrapping/position can drift.
    const hasTextUpdate = Object.prototype.hasOwnProperty.call(req.body, 'text');
    const hasOriginalTextUpdate = Object.prototype.hasOwnProperty.call(req.body, 'originalText');
    if (updatedElement.type === EXCALIDRAW_ELEMENT_TYPES.TEXT && hasTextUpdate && !hasOriginalTextUpdate) {
      const incomingText = updates.text ?? '';
      const existingText = typeof existingElement.text === 'string' ? existingElement.text : '';
      const existingOriginalText = typeof existingElement.originalText === 'string'
        ? existingElement.originalText
        : '';
      const existingOriginalHasBr = /<\s*b\s*r\s*\/?\s*>/i.test(existingOriginalText);
      const normalizedExistingText = normalizeLineBreakMarkup(existingText);
      const normalizedExistingOriginalText = normalizeLineBreakMarkup(existingOriginalText);

      // Handle common cleanup flow: caller normalizes the rendered text value.
      // In this case, prefer normalized originalText so words aren't split by stale wraps.
      if (existingOriginalHasBr && incomingText === normalizedExistingText && normalizedExistingOriginalText) {
        updatedElement.text = normalizedExistingOriginalText;
        updatedElement.originalText = normalizedExistingOriginalText;
      } else {
        updatedElement.originalText = incomingText;
      }
    }

    const persistedElement = sessionId
      ? diagramStore.upsertElementWithSession(diagramId, updatedElement, sessionId)
      : persistElement(diagramId, updatedElement);

    if (sessionId) {
      touchSession(sessionId, diagramId);
    }

    // Broadcast to all connected clients
    const message: ElementUpdatedMessage = {
      type: 'element_updated',
      element: persistedElement
    };
    if (sessionId) {
      broadcastToSession(sessionId, message, diagramId);
    }

    res.json({
      success: true,
      element: persistedElement
    });
  } catch (error) {
    logger.error('Error updating element:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Clear all elements (must be before /:id route)
app.delete('/api/elements/clear', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined;

    // Check operation lock - warn if another session is performing a destructive action
    const lock = diagramStore.getOperationLock('clear');
    if (lock && lock.lockedBySessionId !== sessionId) {
      logger.warn(`Clear operation blocked by lock held by session ${lock.lockedBySessionId}`);
      return res.status(409).json({
        success: false,
        error: `Another session is currently clearing the canvas. Please try again later.`,
        operationLock: {
          lockedBySessionId: lock.lockedBySessionId,
          lockedAt: lock.lockedAt,
          expiresAt: lock.expiresAt,
        }
      });
    }

    const backup = createAutomaticBackup(diagramId, 'clear', sessionId);
    const count = clearElements(diagramId);

    if (sessionId) {
      broadcastToSession(sessionId, {
        type: 'canvas_cleared',
        timestamp: new Date().toISOString()
      }, diagramId);
    }

    logger.info(`Canvas cleared: ${count} elements removed`);

    res.json({
      success: true,
      message: `Cleared ${count} elements`,
      count,
      backupSnapshot: backup?.name ?? null
    });
  } catch (error) {
    logger.error('Error clearing canvas:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Delete element
app.delete('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const diagramId = getDiagramIdFromRequest(req);
    const sessionId = getSessionIdFromRequest(req);
    const existingElement = diagramStore.getElement(diagramId, id);
    if (!existingElement) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    // Create automatic backup before destructive delete operation
    const backup = createAutomaticBackup(diagramId, 'delete', sessionId);

    if (sessionId) {
      diagramStore.deleteElementWithSession(diagramId, id, sessionId);
      touchSession(sessionId, diagramId);
    } else {
      removeElement(diagramId, id);
    }


    // Broadcast to all connected clients
    const message: ElementDeletedMessage = {
      type: 'element_deleted',
      elementId: id!
    };
    if (sessionId) {
      broadcastToSession(sessionId, message, diagramId);
    }

    res.json({
      success: true,
      message: `Element ${id} deleted successfully`,
      backupSnapshot: backup?.name ?? null
    });
  } catch (error) {
    logger.error('Error deleting element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Query elements with filters
app.get('/api/elements/search', (req: Request, res: Response) => {
  try {
    const { type, x_min, x_max, y_min, y_max, ...filters } = req.query;
    const diagramId = getDiagramIdFromRequest(req);
    let results = currentElements(diagramId);

    // Filter by type if specified
    if (type && typeof type === 'string') {
      results = results.filter(element => element.type === type);
    }

    // Filter by bounding box if specified
    if (x_min !== undefined || x_max !== undefined || y_min !== undefined || y_max !== undefined) {
      const xMin = x_min !== undefined ? Number(x_min) : -Infinity;
      const xMax = x_max !== undefined ? Number(x_max) : Infinity;
      const yMin = y_min !== undefined ? Number(y_min) : -Infinity;
      const yMax = y_max !== undefined ? Number(y_max) : Infinity;

      results = results.filter(el =>
        el.x >= xMin &&
        el.x <= xMax &&
        el.y >= yMin &&
        el.y <= yMax
      );
    }

    // Apply additional exact-match filters
    if (Object.keys(filters).length > 0) {
      results = results.filter(element => {
        return Object.entries(filters).every(([key, value]) => {
          return (element as any)[key] === value;
        });
      });
    }

    res.json({
      success: true,
      elements: results,
      count: results.length
    });
  } catch (error) {
    logger.error('Error querying elements:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Get element by ID
app.get('/api/elements/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        error: 'Element ID is required'
      });
    }

    const diagramId = getDiagramIdFromRequest(req);
    const element = diagramStore.getElement(diagramId, id);

    if (!element) {
      return res.status(404).json({
        success: false,
        error: `Element with ID ${id} not found`
      });
    }

    res.json({
      success: true,
      element: element
    });
  } catch (error) {
    logger.error('Error fetching element:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Helper: compute edge point for an element given a direction toward a target
function computeEdgePoint(
  el: ServerElement,
  targetCenterX: number,
  targetCenterY: number
): { x: number; y: number } {
  const cx = el.x + (el.width || 0) / 2;
  const cy = el.y + (el.height || 0) / 2;
  const dx = targetCenterX - cx;
  const dy = targetCenterY - cy;

  if (el.type === 'diamond') {
    // Diamond edge: use diamond geometry (rotated square)
    const hw = (el.width || 0) / 2;
    const hh = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    // Scale factor to reach diamond edge
    const scale = (absDx / hw + absDy / hh) > 0
      ? 1 / (absDx / hw + absDy / hh)
      : 1;
    return { x: cx + dx * scale, y: cy + dy * scale };
  }

  if (el.type === 'ellipse') {
    // Ellipse edge: parametric intersection
    const a = (el.width || 0) / 2;
    const b = (el.height || 0) / 2;
    if (dx === 0 && dy === 0) return { x: cx, y: cy + b };
    const angle = Math.atan2(dy, dx);
    return { x: cx + a * Math.cos(angle), y: cy + b * Math.sin(angle) };
  }

  // Rectangle: find intersection with edges
  const hw = (el.width || 0) / 2;
  const hh = (el.height || 0) / 2;
  if (dx === 0 && dy === 0) return { x: cx, y: cy + hh };
  const angle = Math.atan2(dy, dx);
  const tanA = Math.tan(angle);
  // Check if ray intersects top/bottom edge or left/right edge
  if (Math.abs(tanA * hw) <= hh) {
    // Intersects left or right edge
    const signX = dx >= 0 ? 1 : -1;
    return { x: cx + signX * hw, y: cy + signX * hw * tanA };
  } else {
    // Intersects top or bottom edge
    const signY = dy >= 0 ? 1 : -1;
    return { x: cx + signY * hh / tanA, y: cy + signY * hh };
  }
}

// Helper: resolve arrow bindings in a batch
function resolveArrowBindings(diagramId: string, batchElements: ServerElement[]): void {
  const elementMap = new Map<string, ServerElement>();
  batchElements.forEach(el => elementMap.set(el.id, el));

  getElementMap(diagramId).forEach((el, id) => {
    if (!elementMap.has(id)) elementMap.set(id, el);
  });

  for (const el of batchElements) {
    if (el.type !== 'arrow' && el.type !== 'line') continue;
    const startRef = (el as any).start as { id: string } | undefined;
    const endRef = (el as any).end as { id: string } | undefined;

    if (!startRef && !endRef) continue;

    const startEl = startRef ? elementMap.get(startRef.id) : undefined;
    const endEl = endRef ? elementMap.get(endRef.id) : undefined;

    // Calculate arrow path from edge to edge
    const startCenter = startEl
      ? { x: startEl.x + (startEl.width || 0) / 2, y: startEl.y + (startEl.height || 0) / 2 }
      : { x: el.x, y: el.y };
    const endCenter = endEl
      ? { x: endEl.x + (endEl.width || 0) / 2, y: endEl.y + (endEl.height || 0) / 2 }
      : { x: el.x + 100, y: el.y };

    const GAP = 8;
    const startPt = startEl
      ? computeEdgePoint(startEl, endCenter.x, endCenter.y)
      : startCenter;
    const endPt = endEl
      ? computeEdgePoint(endEl, startCenter.x, startCenter.y)
      : endCenter;

    // Apply gap: move start point slightly away from source, end point slightly away from target
    const startDx = endPt.x - startPt.x;
    const startDy = endPt.y - startPt.y;
    const startDist = Math.sqrt(startDx * startDx + startDy * startDy) || 1;
    const endDx = startPt.x - endPt.x;
    const endDy = startPt.y - endPt.y;
    const endDist = Math.sqrt(endDx * endDx + endDy * endDy) || 1;

    const finalStart = {
      x: startPt.x + (startDx / startDist) * GAP,
      y: startPt.y + (startDy / startDist) * GAP
    };
    const finalEnd = {
      x: endPt.x + (endDx / endDist) * GAP,
      y: endPt.y + (endDy / endDist) * GAP
    };

    // Set arrow position and points
    el.x = finalStart.x;
    el.y = finalStart.y;
    el.points = [[0, 0], [finalEnd.x - finalStart.x, finalEnd.y - finalStart.y]];

    // Do NOT delete `start` and `end` here.
    // Excalidraw's frontend `convertToExcalidrawElements` method looks for these exact properties
    // to calculate mathematically sound `startBinding`, `endBinding`, `focus`, `gap`, and `boundElements`.
  }
}

// Batch create elements
app.post('/api/elements/batch', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const sessionId = getSessionIdFromRequest(req);
    const { elements: elementsToCreate } = req.body;

    if (!Array.isArray(elementsToCreate)) {
      return res.status(400).json({
        success: false,
        error: 'Expected an array of elements'
      });
    }

    const createdElements: ServerElement[] = [];

    elementsToCreate.forEach(elementData => {
      const params = CreateElementSchema.parse(elementData);
      // Prioritize passed ID (for MCP sync), otherwise generate new ID
      const id = params.id || generateId();
      const element: ServerElement = {
        id,
        ...params,
        fontFamily: normalizeFontFamily(params.fontFamily),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1
      };

      createdElements.push(element);
    });

    // Resolve arrow bindings (computes positions, startBinding, endBinding, boundElements)
    resolveArrowBindings(diagramId, createdElements);

    // Store all elements after binding resolution
    if (sessionId) {
      diagramStore.replaceElementsWithSession(diagramId, createdElements, sessionId);
      touchSession(sessionId, diagramId);
    } else {
      persistElements(diagramId, createdElements);
    }

    // Broadcast to all connected clients
    const message: BatchCreatedMessage = {
      type: 'elements_batch_created',
      elements: createdElements
    };
    if (sessionId) {
      broadcastToSession(sessionId, message, diagramId);
    }

    res.json({
      success: true,
      elements: createdElements,
      count: createdElements.length
    });
  } catch (error) {
    logger.error('Error batch creating elements:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Convert Mermaid diagram to Excalidraw elements
app.post('/api/elements/from-mermaid', (req: Request, res: Response) => {
  try {
    const { mermaidDiagram, config } = req.body;

    if (!mermaidDiagram || typeof mermaidDiagram !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Mermaid diagram definition is required'
      });
    }

    logger.info('Received Mermaid conversion request', {
      diagramLength: mermaidDiagram.length,
      hasConfig: !!config
    });

    // Broadcast to all WebSocket clients to process the Mermaid diagram
    const diagramId = getDiagramIdFromRequest(req);
    broadcastToDiagram(diagramId, {
      type: 'mermaid_convert',
      mermaidDiagram,
      config: config || {},
      timestamp: new Date().toISOString()
    });

    // Return the diagram for frontend processing
    res.json({
      success: true,
      mermaidDiagram,
      config: config || {},
      message: 'Mermaid diagram sent to frontend for conversion.'
    });
  } catch (error) {
    logger.error('Error processing Mermaid diagram:', error);
    res.status(400).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Sync elements from frontend using version-aware full-scene replacement
app.post('/api/elements/sync', (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const {
      elements: frontendElements,
      timestamp,
      sessionId = `frontend-${generateId()}`,
      baseVersion = 0
    } = req.body;

    if (!Array.isArray(frontendElements)) {
      return res.status(400).json({
        success: false,
        error: 'Expected elements to be an array'
      });
    }

    const diagramId = getDiagramIdFromRequest(req);

    // Schema hardening: validate sync payload
    const payloadValidation = validatePayloadSize(frontendElements);
    if (!payloadValidation.valid) {
      return res.status(413).json({
        success: false,
        error: 'Payload too large',
        details: payloadValidation.errors
      });
    }

    const batchValidation = validateBatchOperation(frontendElements);
    if (!batchValidation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Sync validation failed',
        details: batchValidation.errors
      });
    }

    const beforeCount = currentElementCount(diagramId);
    const currentVersion = diagramStore.getDiagramVersion(diagramId);
    const hasConflict = baseVersion !== currentVersion;

    logger.info(`Sync request received: ${frontendElements.length} elements`, {
      timestamp,
      sessionId,
      baseVersion,
      currentVersion,
      diagramId,
      elementCount: frontendElements.length
    });

    diagramStore.upsertSession({
      id: sessionId,
      activeDiagramId: diagramId,
      status: 'active',
      lastSyncAt: new Date().toISOString(),
      lastAckVersion: currentVersion
    });

    const processedElements: ServerElement[] = [];
    frontendElements.forEach((element: any, index: number) => {
      try {
        // Validate individual element limits
        const elementValidation = validateElementLimits(element);
        if (!elementValidation.valid) {
          logger.warn(`Element ${index} validation failed:`, elementValidation.errors);
        }

        const elementId = element.id || generateId();
        processedElements.push({
          ...element,
          id: elementId,
          syncedAt: new Date().toISOString(),
          source: 'frontend_sync',
          syncTimestamp: timestamp,
          version: element.version || 1
        });
      } catch (elementError) {
        logger.warn(`Failed to process element ${index}:`, elementError);
      }
    });

    diagramStore.replaceElementsWithSession(diagramId, processedElements, sessionId);
    const serverVersion = diagramStore.getDiagramVersion(diagramId);
    diagramStore.acknowledgeSessionVersion(sessionId, diagramId, serverVersion);

    if (sessionId) {
      broadcastToSession(sessionId, {
        type: 'elements_synced',
        count: processedElements.length,
        timestamp: new Date().toISOString(),
        source: 'versioned_sync',
        sessionId,
        diagramId,
        serverVersion,
        conflicts: hasConflict
      }, diagramId);
    }

    const durationMs = Date.now() - startTime;
    recordSyncMetric({
      operationType: 'sync',
      diagramId,
      sessionId,
      elementCount: processedElements.length,
      durationMs,
      success: true,
      timestamp: new Date().toISOString(),
    });
    recordPerformanceMetric({
      diagramId,
      elementCount: processedElements.length,
      operationType: 'sync',
      durationMs,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      applied: true,
      conflicts: hasConflict,
      diagramId,
      sessionId,
      serverVersion,
      count: processedElements.length,
      syncedAt: new Date().toISOString(),
      beforeCount,
      afterCount: currentElementCount(diagramId)
    });
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const diagramId = getDiagramIdFromRequest(req);
    recordSyncMetric({
      operationType: 'sync',
      diagramId,
      sessionId: getSessionIdFromRequest(req),
      elementCount: 0,
      durationMs,
      success: false,
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    });
    logger.error('Sync error:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message,
      details: 'Internal server error during sync operation'
    });
  }
});

// Get sync state for a diagram or session
app.get('/api/elements/sync/state', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const serverVersion = diagramStore.getDiagramVersion(diagramId);
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const updatedElements = typeof req.query.afterVersion === 'string'
      ? diagramStore.getElementsUpdatedAfterVersion(diagramId, Number(req.query.afterVersion))
      : [];
    const deletedElementIds = typeof req.query.afterVersion === 'string'
      ? diagramStore.listDeletedElementIdsAfterVersion(diagramId, Number(req.query.afterVersion))
      : [];

    if (sessionId) {
      diagramStore.acknowledgeSessionVersion(sessionId, diagramId, serverVersion);
    }

    res.json({
      success: true,
      diagramId,
      sessionId,
      serverVersion,
      elements: updatedElements,
      deletedElementIds,
      count: updatedElements.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Explicitly acknowledge the current server version for a session
app.post('/api/elements/sync/ack', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const { sessionId, serverVersion } = req.body;
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }
    const acknowledgedVersion = typeof serverVersion === 'number'
      ? serverVersion
      : diagramStore.getDiagramVersion(diagramId);
    const session = diagramStore.acknowledgeSessionVersion(sessionId, diagramId, acknowledgedVersion);
    res.json({ success: true, session, serverVersion: acknowledgedVersion });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Return the full current scene and server version for reconnect/reload
app.get('/api/scene', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const filesObj: Record<string, ExcalidrawFile> = {};
    listFiles(diagramId).forEach((f) => { filesObj[f.id] = f; });
    res.json({
      success: true,
      diagramId,
      serverVersion: diagramStore.getDiagramVersion(diagramId),
      elements: currentElements(diagramId),
      files: filesObj
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Session heartbeat — frontend pings periodically to keep session alive
app.post('/api/sessions/heartbeat', (req: Request, res: Response) => {
  try {
    const { sessionId, diagramId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }
    const did = typeof diagramId === 'string' && diagramId.trim() ? diagramId : DEFAULT_DIAGRAM_ID;
    const staleBefore = new Date(Date.now() - 30000).toISOString();
    diagramStore.markStaleSessions(staleBefore);
    touchSession(sessionId, did);
    const serverVersion = diagramStore.getDiagramVersion(did);

    // Get active and conflicting sessions for presence awareness
    const activeSessions = diagramStore.listActiveSessions(did);
    const conflictingSessions = diagramStore.listConflictingSessions(did);
    const allSessions = diagramStore.listSessions(did);
    const staleCount = allSessions.filter(s => s.status === 'stale').length;

    // Include presence warnings if other active sessions are on the same diagram
    const otherActiveCount = activeSessions.filter(s => s.id !== sessionId).length;
    const presenceWarnings: string[] = [];
    if (otherActiveCount > 0) {
      presenceWarnings.push(`${otherActiveCount} other session${otherActiveCount > 1 ? 's' : ''} currently editing this diagram`);
    }
    if (conflictingSessions.length > 0) {
      presenceWarnings.push(`${conflictingSessions.length} session${conflictingSessions.length > 1 ? 's' : ''} with unacknowledged changes`);
    }

    res.json({
      success: true,
      serverVersion,
      activeSessionCount: activeSessions.length,
      staleCount,
      conflictingCount: conflictingSessions.length,
      presenceWarnings,
      sessions: activeSessions
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Acquire operation lock (for explicit locking of destructive actions)
app.post('/api/sessions/lock', (req: Request, res: Response) => {
  try {
    const { sessionId, operationType, ttlMs } = req.body;
    if (!sessionId || !operationType) {
      return res.status(400).json({ success: false, error: 'sessionId and operationType are required' });
    }
    const ttl = typeof ttlMs === 'number' ? ttlMs : 30000;
    const acquired = diagramStore.acquireOperationLock(operationType, sessionId, ttl);
    if (!acquired) {
      const lock = diagramStore.getOperationLock(operationType);
      return res.status(409).json({
        success: false,
        error: `Operation lock for '${operationType}' is held by another session`,
        lock: lock || null
      });
    }
    res.json({ success: true, operationType, lockedBySessionId: sessionId });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Release operation lock
app.post('/api/sessions/unlock', (req: Request, res: Response) => {
  try {
    const { sessionId, operationType } = req.body;
    if (!sessionId || !operationType) {
      return res.status(400).json({ success: false, error: 'sessionId and operationType are required' });
    }
    const released = diagramStore.releaseOperationLock(operationType, sessionId);
    res.json({ success: true, released, operationType });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Get current lock status
app.get('/api/sessions/lock/:operationType', (req: Request, res: Response) => {
  try {
    const operationType = req.params.operationType;
    if (!operationType) {
      return res.status(400).json({ success: false, error: 'operationType is required' });
    }
    const validTypes = ['clear', 'bulk_delete', 'restore', 'import'] as const;
    if (!validTypes.includes(operationType as typeof validTypes[number])) {
      return res.status(400).json({ success: false, error: `Invalid operationType. Must be one of: ${validTypes.join(', ')}` });
    }
    const lock = diagramStore.getOperationLock(operationType as 'clear' | 'bulk_delete' | 'restore' | 'import');
    res.json({ success: true, lock });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Get session presence info for a diagram
app.get('/api/diagrams/:id/presence', (req: Request, res: Response) => {
  try {
    const diagramId = req.params.id!;
    const activeSessions = diagramStore.listActiveSessions(diagramId);
    const conflictingSessions = diagramStore.listConflictingSessions(diagramId);
    const serverVersion = diagramStore.getDiagramVersion(diagramId);

    // Calculate which sessions need to acknowledge the current version
    const sessionsNeedingAck = activeSessions.filter(s =>
      s.lastAckVersion < serverVersion && s.lastAckVersion >= 0
    );

    res.json({
      success: true,
      diagramId,
      activeCount: activeSessions.length,
      conflictingCount: conflictingSessions.length,
      serverVersion,
      sessionsNeedingAckCount: sessionsNeedingAck.length,
      sessions: activeSessions,
      conflicts: conflictingSessions
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// ─── Files API (for image elements) ───────────────────────────
// GET all files
app.get('/api/files', (req: Request, res: Response) => {
  const diagramId = getDiagramIdFromRequest(req);
  const filesObj: Record<string, ExcalidrawFile> = {};
  listFiles(diagramId).forEach((f) => { filesObj[f.id] = f; });
  res.json({ files: filesObj });
});

// POST add/update files (batch)
app.post('/api/files', (req: Request, res: Response) => {
  const diagramId = getDiagramIdFromRequest(req);
  const sessionId = getSessionIdFromRequest(req);
  const body = req.body;
  const fileList: ExcalidrawFile[] = Array.isArray(body) ? body : (body?.files || []);
  if (fileList.length > 0) {
    const normalizedFiles = fileList
      .filter(f => f.id && f.dataURL)
      .map(f => ({ id: f.id, dataURL: f.dataURL, mimeType: f.mimeType || 'image/png', created: f.created || Date.now() }));
    if (normalizedFiles.length > 0) {
      upsertFiles(diagramId, normalizedFiles, sessionId);
      if (sessionId) {
        touchSession(sessionId, diagramId);
      }
    }
  }
  if (sessionId) {
    broadcastToSession(sessionId, { type: 'files_added', files: fileList }, diagramId);
  }
  res.json({ success: true, count: fileList.length });
});

// DELETE a file
app.delete('/api/files/:id', (req: Request, res: Response) => {
  const diagramId = getDiagramIdFromRequest(req);
  const sessionId = getSessionIdFromRequest(req);
  const id = req.params.id as string;
  if (deleteFileRecord(diagramId, id)) {
    if (sessionId) {
      touchSession(sessionId, diagramId);
    }
    if (sessionId) {
      broadcastToSession(sessionId, { type: 'file_deleted', fileId: id }, diagramId);
    }
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, error: `File with ID ${id} not found` });
  }
});

// Image export: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingExport {
  resolve: (data: { format: string; data: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  collectionTimeout: ReturnType<typeof setTimeout> | null;
  bestResult: { format: string; data: string } | null;
}
const pendingExports = new Map<string, PendingExport>();

app.post('/api/export/image', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const { format, background } = req.body;

    if (!format || !['png', 'svg'].includes(format)) {
      return res.status(400).json({
        success: false,
        error: 'format must be "png" or "svg"'
      });
    }

    const diagramSet = diagramClients.get(diagramId);
    if ((!diagramSet || diagramSet.size === 0) && clients.size === 0) {
      return res.status(503).json({
        success: false,
        error: 'No frontend client connected. Open the canvas in a browser first.'
      });
    }

    const requestId = generateId();

    const exportPromise = new Promise<{ format: string; data: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingExports.get(requestId);
        pendingExports.delete(requestId);
        if (pending?.bestResult) {
          resolve(pending.bestResult);
        } else {
          reject(new Error('Export timed out after 30 seconds'));
        }
      }, 30000);

      pendingExports.set(requestId, { resolve, reject, timeout, collectionTimeout: null, bestResult: null });
    });

    const filesObj: Record<string, ExcalidrawFile> = {};
    listFiles(diagramId).forEach((f) => { filesObj[f.id] = f; });
    broadcastToDiagram(diagramId, {
      type: 'initial_elements',
      elements: currentElements(diagramId),
      ...(Object.keys(filesObj).length > 0 ? { files: filesObj } : {})
    } as InitialElementsMessage & { files?: Record<string, ExcalidrawFile> });

    setTimeout(() => {
      broadcastToDiagram(diagramId, {
        type: 'export_image_request',
        requestId,
        format,
        background: background ?? true
      });
    }, 800);

    exportPromise
      .then(result => {
        res.json({
          success: true,
          format: result.format,
          data: result.data
        });
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message
        });
      });
  } catch (error) {
    logger.error('Error initiating image export:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Image export: result (Frontend -> Express -> MCP)
app.post('/api/export/image/result', (req: Request, res: Response) => {
  try {
    const { requestId, format, data, error } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required'
      });
    }

    const pending = pendingExports.get(requestId);
    if (!pending) {
      // Already resolved by another client, or expired — ignore silently
      return res.json({ success: true });
    }

    if (error) {
      // Don't reject on error — another WebSocket client may still succeed.
      logger.warn(`Export error from one client (requestId=${requestId}): ${error}`);
      return res.json({ success: true });
    }

    // Keep the largest response (most complete canvas state wins)
    if (!pending.bestResult || data.length > pending.bestResult.data.length) {
      pending.bestResult = { format, data };
    }

    // Start a short collection window on the first response, then resolve with best
    if (!pending.collectionTimeout) {
      pending.collectionTimeout = setTimeout(() => {
        const p = pendingExports.get(requestId);
        if (p?.bestResult) {
          clearTimeout(p.timeout);
          pendingExports.delete(requestId);
          p.resolve(p.bestResult);
        }
      }, 3000);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing export result:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Viewport control: request (MCP -> Express -> WebSocket -> Frontend)
interface PendingViewport {
  resolve: (data: { success: boolean; message: string }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingViewports = new Map<string, PendingViewport>();

app.post('/api/viewport', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const { scrollToContent, scrollToElementId, zoom, offsetX, offsetY } = req.body;

    const diagramSet = diagramClients.get(diagramId);
    if ((!diagramSet || diagramSet.size === 0) && clients.size === 0) {
      return res.status(503).json({
        success: false,
        error: 'No frontend client connected. Open the canvas in a browser first.'
      });
    }

    const requestId = generateId();

    const viewportPromise = new Promise<{ success: boolean; message: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingViewports.delete(requestId);
        reject(new Error('Viewport request timed out after 10 seconds'));
      }, 10000);

      pendingViewports.set(requestId, { resolve, reject, timeout });
    });

    broadcastToDiagram(diagramId, {
      type: 'set_viewport',
      requestId,
      scrollToContent,
      scrollToElementId,
      zoom,
      offsetX,
      offsetY
    });

    viewportPromise
      .then(result => {
        res.json(result);
      })
      .catch(error => {
        res.status(500).json({
          success: false,
          error: (error as Error).message
        });
      });
  } catch (error) {
    logger.error('Error initiating viewport change:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Viewport control: result (Frontend -> Express -> MCP)
app.post('/api/viewport/result', (req: Request, res: Response) => {
  try {
    const { requestId, success, message, error } = req.body;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        error: 'requestId is required'
      });
    }

    const pending = pendingViewports.get(requestId);
    if (!pending) {
      return res.json({ success: true });
    }

    if (error) {
      clearTimeout(pending.timeout);
      pendingViewports.delete(requestId);
      pending.resolve({ success: false, message: error });
      return res.json({ success: true });
    }

    clearTimeout(pending.timeout);
    pendingViewports.delete(requestId);
    pending.resolve({ success: true, message: message || 'Viewport updated' });

    res.json({ success: true });
  } catch (error) {
    logger.error('Error processing viewport result:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: save
app.post('/api/snapshots', (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Snapshot name is required'
      });
    }

    const diagramId = getDiagramIdFromRequest(req);
    const snapshot: Snapshot = {
      name,
      elements: currentElements(diagramId),
      createdAt: new Date().toISOString()
    };

    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined;
    saveSnapshotRecord(diagramId, snapshot, sessionId);
    logger.info(`Snapshot saved: "${name}" with ${snapshot.elements.length} elements`);

    res.json({
      success: true,
      name,
      elementCount: snapshot.elements.length,
      createdAt: snapshot.createdAt
    });
  } catch (error) {
    logger.error('Error saving snapshot:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: list
app.get('/api/snapshots', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const list = Array.from(getSnapshotMap(diagramId).values()).map(s => ({
      name: s.name,
      elementCount: s.elements.length,
      createdAt: s.createdAt,
      isAutoBackup: s.name.startsWith('auto-')
    }));

    res.json({
      success: true,
      snapshots: list,
      count: list.length
    });
  } catch (error) {
    logger.error('Error listing snapshots:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Backups: list only automatic backups (auto-* snapshots)
app.get('/api/backups', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const allSnapshots = Array.from(getSnapshotMap(diagramId).values());
    const backups = allSnapshots
      .filter(s => s.name.startsWith('auto-'))
      .map(s => {
        // Parse backup reason from name: auto-{reason}-{timestamp}
        const parts = s.name.split('-');
        const reason = parts.length >= 3 ? parts[1] : 'unknown';
        return {
          name: s.name,
          reason,
          elementCount: s.elements.length,
          createdAt: s.createdAt
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json({
      success: true,
      backups,
      count: backups.length
    });
  } catch (error) {
    logger.error('Error listing backups:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Backups: preview a specific backup (get elements without restoring)
app.get('/api/backups/:name/preview', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const { name } = req.params;
    const snapshot = getSnapshotByName(diagramId, name!);

    if (!snapshot) {
      return res.status(404).json({
        success: false,
        error: `Backup "${name}" not found`
      });
    }

    if (!snapshot.name.startsWith('auto-')) {
      return res.status(400).json({
        success: false,
        error: 'Only automatic backups can be previewed'
      });
    }

    // Return summary of elements in the backup for preview
    const elementSummary = snapshot.elements.reduce<Record<string, number>>((acc, el) => {
      acc[el.type] = (acc[el.type] || 0) + 1;
      return acc;
    }, {});

    // Calculate bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of snapshot.elements) {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      maxX = Math.max(maxX, el.x + (el.width || 0));
      maxY = Math.max(maxY, el.y + (el.height || 0));
    }

    res.json({
      success: true,
      preview: {
        name: snapshot.name,
        elementCount: snapshot.elements.length,
        elementSummary,
        boundingBox: snapshot.elements.length > 0 ? {
          x: Math.round(minX),
          y: Math.round(minY),
          width: Math.round(maxX - minX),
          height: Math.round(maxY - minY)
        } : null,
        createdAt: snapshot.createdAt
      }
    });
  } catch (error) {
    logger.error('Error previewing backup:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// Snapshots: get by name
app.get('/api/snapshots/:name', (req: Request, res: Response) => {
  try {
    const diagramId = getDiagramIdFromRequest(req);
    const { name } = req.params;
    const snapshot = getSnapshotByName(diagramId, name!);

    if (!snapshot) {
      return res.status(404).json({
        success: false,
        error: `Snapshot "${name}" not found`
      });
    }

    res.json({
      success: true,
      snapshot
    });
  } catch (error) {
    logger.error('Error fetching snapshot:', error);
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// ─── Diagram management routes ────────────────────────────────

// Internal endpoint: receives diagram updates from MCP server and broadcasts to WebSocket clients
app.post('/api/internal/diagram-updated', (req: Request, res: Response) => {
  try {
    const { diagramId, diagramName, action } = req.body;
    if (!diagramId || !diagramName) {
      return res.status(400).json({ success: false, error: 'diagramId and diagramName required' });
    }
    // Broadcast to ALL connected clients (not just diagram-specific) so they refresh diagram list
    const message = JSON.stringify({ type: 'diagram_updated', diagramId, diagramName, action: action || 'updated' });
    diagramClients.forEach((clients, did) => {
      clients.forEach(client => {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(message);
        }
      });
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// List all diagrams
app.get('/api/diagrams', (_req: Request, res: Response) => {
  try {
    const diagrams = diagramStore.listDiagrams();
    res.json({ success: true, diagrams, count: diagrams.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Create a new diagram
app.post('/api/diagrams', (req: Request, res: Response) => {
  try {
    const { name, tags, description, thumbnail } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: 'name is required' });
    }
    const diagram = diagramStore.ensureDiagram({
      id: generateId(),
      name,
      tags: Array.isArray(tags) ? tags : [],
      description: description || null,
      thumbnail: thumbnail || null,
    });
    res.json({ success: true, diagram });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Get a diagram by id
app.get('/api/diagrams/:id', (req: Request, res: Response) => {
  try {
    const diagram = diagramStore.getDiagram(req.params.id!);
    res.json({ success: true, diagram });
  } catch (error) {
    res.status(404).json({ success: false, error: (error as Error).message });
  }
});

// Update diagram metadata
app.patch('/api/diagrams/:id', (req: Request, res: Response) => {
  try {
    const id = req.params.id!;
    const { name, tags, description, archivedAt, thumbnail } = req.body;
    const updated = diagramStore.updateDiagram(id, { name, tags, description, archivedAt, thumbnail });
    res.json({ success: true, diagram: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.post('/api/diagrams/:id/duplicate', (req: Request, res: Response) => {
  try {
    const sourceId = req.params.id!;
    const { name } = req.body;
    const diagram = diagramStore.duplicateDiagram(sourceId, typeof name === 'string' ? name : undefined);
    res.json({ success: true, diagram });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.delete('/api/diagrams/:id', (req: Request, res: Response) => {
  try {
    const id = req.params.id!;
    diagramStore.closeSessionsForDiagram(id);
    const deleted = diagramStore.deleteDiagram(id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: `Diagram ${id} not found` });
    }
    res.json({ success: true, deleted: true, diagramId: id });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Get full diagram state (elements + files + snapshots + sessions)
app.get('/api/diagrams/:id/state', (req: Request, res: Response) => {
  try {
    const state = diagramStore.getDiagramState(req.params.id!);
    res.json({ success: true, ...state });
  } catch (error) {
    res.status(404).json({ success: false, error: (error as Error).message });
  }
});

// List sessions for a diagram
app.get('/api/diagrams/:id/sessions', (req: Request, res: Response) => {
  try {
    const sessions = diagramStore.listSessions(req.params.id!);
    res.json({ success: true, sessions, count: sessions.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// List sync events for a diagram
app.get('/api/diagrams/:id/events', (req: Request, res: Response) => {
  try {
    const limit = parseInt(String(req.query.limit || '100'), 10);
    const events = diagramStore.listEvents(req.params.id!, limit);
    res.json({ success: true, events, count: events.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Restore a snapshot into a diagram
app.post('/api/diagrams/:id/restore', (req: Request, res: Response) => {
  try {
    const diagramId = req.params.id!;
    const { snapshotName, sessionId } = req.body;
    if (!snapshotName) {
      return res.status(400).json({ success: false, error: 'snapshotName is required' });
    }

    // Check operation lock for restore
    const lock = diagramStore.getOperationLock('restore');
    if (lock && lock.lockedBySessionId !== sessionId) {
      logger.warn(`Restore operation blocked by lock held by session ${lock.lockedBySessionId}`);
      return res.status(409).json({
        success: false,
        error: `Another session is currently restoring the diagram. Please try again later.`,
        operationLock: {
          lockedBySessionId: lock.lockedBySessionId,
          lockedAt: lock.lockedAt,
          expiresAt: lock.expiresAt,
        }
      });
    }

    // Acquire operation lock for restore duration
    const lockAcquired = diagramStore.acquireOperationLock('restore', sessionId, 60000); // 60 second lock
    if (!lockAcquired) {
      return res.status(409).json({
        success: false,
        error: 'Could not acquire restore lock. Another restore may be in progress.'
      });
    }

    try {
      const backup = createAutomaticBackup(diagramId, 'restore', typeof sessionId === 'string' ? sessionId : undefined);
      const snapshot = diagramStore.restoreSnapshot(diagramId, snapshotName, typeof sessionId === 'string' ? sessionId : undefined);
      const filesObj = listDiagramFiles(diagramId);
      broadcastToDiagram(diagramId, {
        type: 'initial_elements',
        elements: snapshot.elements,
        ...(Object.keys(filesObj).length > 0 ? { files: filesObj } : {})
      } as InitialElementsMessage & { files?: Record<string, ExcalidrawFile> });
      res.json({ success: true, elementCount: snapshot.elements.length, restoredFrom: snapshotName, backupSnapshot: backup?.name ?? null });
    } finally {
      // Release the operation lock
      diagramStore.releaseOperationLock('restore', sessionId);
    }
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.post('/api/diagrams/:id/import', (req: Request, res: Response) => {
  try {
    const diagramId = req.params.id!;
    const { elements, sessionId, mode = 'replace' } = req.body;
    if (!Array.isArray(elements)) {
      return res.status(400).json({ success: false, error: 'elements must be an array' });
    }

    // Schema hardening: validate import payload
    const payloadValidation = validatePayloadSize(elements);
    if (!payloadValidation.valid) {
      return res.status(413).json({
        success: false,
        error: 'Payload too large',
        details: payloadValidation.errors
      });
    }

    const batchValidation = validateBatchOperation(elements);
    if (!batchValidation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Import validation failed',
        details: batchValidation.errors
      });
    }

    let backupSnapshot: string | null = null;
    if (mode === 'replace') {
      backupSnapshot = createAutomaticBackup(diagramId, 'import', typeof sessionId === 'string' ? sessionId : undefined)?.name ?? null;
      diagramStore.replaceElements(diagramId, elements, typeof sessionId === 'string' ? sessionId : undefined);
    } else {
      elements.forEach((element: ServerElement) => {
        diagramStore.upsertElement(diagramId, element, typeof sessionId === 'string' ? sessionId : undefined);
      });
    }

    const filesObj = listDiagramFiles(diagramId);
    broadcastToDiagram(diagramId, {
      type: 'initial_elements',
      elements: currentElements(diagramId),
      ...(Object.keys(filesObj).length > 0 ? { files: filesObj } : {})
    } as InitialElementsMessage & { files?: Record<string, ExcalidrawFile> });

    res.json({
      success: true,
      diagramId,
      count: currentElementCount(diagramId),
      mode,
      backupSnapshot,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.get('/api/diagrams/:id/history', (req: Request, res: Response) => {
  try {
    const diagramId = req.params.id!;
    const limit = parseInt(String(req.query.limit || '100'), 10);
    const events = diagramStore.listEvents(diagramId, limit);
    res.json({ success: true, diagramId, events, count: events.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Mutation history endpoint for undo/redo
app.get('/api/diagrams/:id/mutation-history', (req: Request, res: Response) => {
  try {
    const diagramId = req.params.id!;
    const limit = parseInt(String(req.query.limit || '50'), 10);
    const history = diagramStore.getMutationHistory(diagramId, limit);
    res.json({ success: true, diagramId, mutations: history, count: history.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Undo last mutation
app.post('/api/diagrams/:id/undo', (req: Request, res: Response) => {
  try {
    const diagramId = req.params.id!;
    const result = diagramStore.undoLastMutation(diagramId);
    if (result) {
      const filesObj = listDiagramFiles(diagramId);
      broadcastToDiagram(diagramId, {
        type: 'initial_elements',
        elements: currentElements(diagramId),
        ...(Object.keys(filesObj).length > 0 ? { files: filesObj } : {})
      } as InitialElementsMessage & { files?: Record<string, ExcalidrawFile> });
      res.json({ success: true, message: 'Undo successful', undone: result });
    } else {
      res.json({ success: true, message: 'Nothing to undo', undone: null });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Serve the frontend
app.get('/', (req: Request, res: Response) => {
  const htmlFile = path.join(__dirname, '../dist/frontend/index.html');
  res.sendFile(htmlFile, (err) => {
    if (err) {
      logger.error('Error serving frontend:', err);
      res.status(404).send('Frontend not found. Please run "npm run build" first.');
    }
  });
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  const diagramId = getDiagramIdFromRequest(req);
  const metrics = getHealthMetrics(clients, diagramClients, () => currentElementCount(diagramId));
  res.json({
    status: metrics.status,
    timestamp: new Date().toISOString(),
    elements_count: metrics.elementCount,
    websocket_clients: metrics.websocketClients,
    active_sessions: metrics.activeSessions,
    memory_usage_mb: metrics.memoryUsageMb,
    uptime_seconds: metrics.uptimeSeconds,
    issues: metrics.issues
  });
});

// Sync status endpoint with metrics
app.get('/api/sync/status', (req: Request, res: Response) => {
  const diagramId = getDiagramIdFromRequest(req);
  const metrics = getHealthMetrics(clients, diagramClients, () => currentElementCount(diagramId));
  res.json({
    success: true,
    elementCount: currentElementCount(diagramId),
    timestamp: new Date().toISOString(),
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024), // MB
    },
    websocketClients: metrics.websocketClients,
    health: metrics.status
  });
});

// Observability metrics endpoints
app.get('/api/metrics/sync', (req: Request, res: Response) => {
  const limit = parseInt(String(req.query.limit || '100'), 10);
  const metrics = getRecentSyncMetrics(limit);
  res.json({
    success: true,
    count: metrics.length,
    metrics
  });
});

app.get('/api/metrics/performance', (req: Request, res: Response) => {
  const limit = parseInt(String(req.query.limit || '100'), 10);
  const metrics = getRecentPerformanceMetrics(limit);
  res.json({
    success: true,
    count: metrics.length,
    metrics
  });
});

app.get('/api/metrics/health', (req: Request, res: Response) => {
  const diagramId = getDiagramIdFromRequest(req);
  const metrics = getHealthMetrics(clients, diagramClients, () => currentElementCount(diagramId));
  res.json({
    success: true,
    ...metrics
  });
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_GUARD_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'];

function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const finish = (isOpen: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(isOpen);
    };

    socket.setTimeout(250);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function findExistingLoopbackListener(port: number): Promise<string | null> {
  for (const host of LOOPBACK_ADDRESSES) {
    if (await canConnect(host, port)) {
      return host;
    }
  }
  return null;
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    const address = (error as NodeJS.ErrnoException & { address?: string }).address || HOST;
    logger.error(`Canvas server port ${PORT} is already in use on ${formatHostForUrl(address)}.`);
  } else if (error.code === 'EACCES') {
    logger.error(`Canvas server cannot bind ${formatHostForUrl(HOST)}:${PORT}: permission denied.`);
  } else {
    logger.error('Failed to start canvas server:', error);
  }
  process.exit(1);
});

async function startServer(): Promise<void> {
  if (LOOPBACK_GUARD_HOSTS.has(HOST)) {
    const existingHost = await findExistingLoopbackListener(PORT);
    if (existingHost) {
      logger.error(
        `Refusing to start canvas server on ${formatHostForUrl(HOST)}:${PORT}: ` +
        `${formatHostForUrl(existingHost)}:${PORT} is already listening. ` +
        'This prevents duplicate IPv4/IPv6 canvas servers from splitting state.'
      );
      process.exit(1);
    }
  }

  server.listen(PORT, HOST, () => {
    const hostForUrl = formatHostForUrl(HOST);
    logger.info(`POC server running on http://${hostForUrl}:${PORT}`);
    logger.info(`WebSocket server running on ws://${hostForUrl}:${PORT}`);
  });
}

void startServer();

export default app;
