import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import logger from './utils/logger.js';
import {
  DEFAULT_DIAGRAM_ID,
  DEFAULT_DIAGRAM_NAME,
  DiagramRecord,
  DiagramSnapshotRecord,
  DiagramStateSnapshot,
  ExcalidrawFile,
  OperationLock,
  SceneStateRecord,
  ServerElement,
  SessionRecord,
  SessionStatus,
  Snapshot,
  SyncEventRecord,
  SyncEventType,
  VALIDATION_LIMITS,
  validateBatchOperation,
} from './types.js';

const DATA_DIR = path.join(process.cwd(), '.excalidraw_mcp');
const DB_PATH = process.env.EXCALIDRAW_DB_PATH || path.join(DATA_DIR, 'excalidraw.sqlite');

function ensureDataDir(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToDiagram(row: any): DiagramRecord {
  return {
    id: row.id,
    name: row.name,
    tags: parseJson<string[]>(row.tags, []),
    description: row.description,
    thumbnail: row.thumbnail,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSession(row: any): SessionRecord {
  return {
    id: row.id,
    activeDiagramId: row.active_diagram_id,
    status: row.status as SessionStatus,
    lastHeartbeatAt: row.last_heartbeat_at,
    lastSyncAt: row.last_sync_at,
    lastAckVersion: row.last_ack_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSnapshot(row: any): DiagramSnapshotRecord {
  return {
    name: row.name,
    diagramId: row.diagram_id,
    elements: parseJson<ServerElement[]>(row.elements_json, []),
    createdAt: row.created_at,
  };
}

function rowToFile(row: any): ExcalidrawFile {
  return {
    id: row.id,
    dataURL: row.data_url,
    mimeType: row.mime_type,
    created: row.created,
  };
}

function rowToEvent(row: any): SyncEventRecord {
  return {
    id: row.id,
    diagramId: row.diagram_id,
    sessionId: row.session_id,
    eventType: row.event_type as SyncEventType,
    elementId: row.element_id,
    payload: parseJson<Record<string, any> | null>(row.payload_json, null),
    previousPayload: parseJson<Record<string, any> | null>(row.previous_payload_json, null),
    createdAt: row.created_at,
  };
}

function rowToSceneState(row: any): SceneStateRecord {
  return {
    diagramId: row.diagram_id,
    theme: row.theme,
    viewport: parseJson<{ x: number; y: number; zoom: number }>(row.viewport_json, { x: 0, y: 0, zoom: 1 }),
    selectedElementIds: parseJson<string[]>(row.selected_element_ids_json, []),
    groups: parseJson<Record<string, string[]>>(row.groups_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DiagramStore {
  private readonly db: Database.Database;

  constructor(databasePath = DB_PATH) {
    ensureDataDir();
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.ensureDefaultDiagram();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS diagrams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        thumbnail TEXT,
        description TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        active_diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active',
        last_heartbeat_at TEXT NOT NULL,
        last_sync_at TEXT,
        last_ack_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS elements (
        diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (diagram_id, id)
      );

      CREATE TABLE IF NOT EXISTS files (
        diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        data_url TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        created INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (diagram_id, id)
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        elements_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (diagram_id, name)
      );

      CREATE TABLE IF NOT EXISTS sync_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
        session_id TEXT,
        event_type TEXT NOT NULL,
        element_id TEXT,
        payload_json TEXT,
        previous_payload_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scene_state (
        diagram_id TEXT PRIMARY KEY REFERENCES diagrams(id) ON DELETE CASCADE,
        theme TEXT NOT NULL DEFAULT 'light',
        viewport_json TEXT NOT NULL,
        selected_element_ids_json TEXT NOT NULL,
        groups_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_elements_diagram_updated ON elements(diagram_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_sync_events_diagram_id ON sync_events(diagram_id, id);
      CREATE INDEX IF NOT EXISTS idx_sessions_active_diagram ON sessions(active_diagram_id, status);

      CREATE TABLE IF NOT EXISTS mutation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        diagram_id TEXT NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
        session_id TEXT,
        operation TEXT NOT NULL,
        element_id TEXT,
        element_data_json TEXT,
        previous_data_json TEXT,
        sequence_num INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mutation_history_diagram_seq ON mutation_history(diagram_id, sequence_num DESC);
    `);
  }

  private ensureDefaultDiagram(): void {
    const existing = this.db.prepare('SELECT id FROM diagrams WHERE id = ?').get(DEFAULT_DIAGRAM_ID);
    if (existing) return;

    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO diagrams (id, name, tags, description, thumbnail, archived_at, created_at, updated_at)
      VALUES (?, ?, '[]', NULL, NULL, NULL, ?, ?)
    `).run(DEFAULT_DIAGRAM_ID, DEFAULT_DIAGRAM_NAME, timestamp, timestamp);
  }

  listDiagrams(): DiagramRecord[] {
    const rows = this.db.prepare('SELECT * FROM diagrams ORDER BY updated_at DESC, created_at DESC').all();
    return rows.map(rowToDiagram);
  }

  getDiagramVersion(diagramId = DEFAULT_DIAGRAM_ID): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS version FROM sync_events WHERE diagram_id = ?').get(diagramId) as { version?: number } | undefined;
    return row?.version || 0;
  }

  acknowledgeSessionVersion(sessionId: string, diagramId: string, version: number): SessionRecord {
    return this.upsertSession({
      id: sessionId,
      activeDiagramId: diagramId,
      status: 'active',
      lastAckVersion: version,
      lastSyncAt: nowIso(),
      lastHeartbeatAt: nowIso(),
    });
  }

  getElementsUpdatedAfterVersion(diagramId: string, version: number): ServerElement[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT e.data_json
      FROM elements e
      JOIN sync_events se
        ON se.diagram_id = e.diagram_id
       AND se.element_id = e.id
      WHERE e.diagram_id = ?
        AND se.id > ?
        AND e.is_deleted = 0
      ORDER BY e.updated_at ASC
    `).all(diagramId, version) as Array<{ data_json: string }>;

    return rows.map(row => parseJson<ServerElement>(row.data_json, {} as ServerElement));
  }

  listDeletedElementIdsAfterVersion(diagramId: string, version: number): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT element_id
      FROM sync_events
      WHERE diagram_id = ?
        AND id > ?
        AND event_type = 'element_deleted'
        AND element_id IS NOT NULL
      ORDER BY id ASC
    `).all(diagramId, version) as Array<{ element_id: string }>;

    return rows.map(row => row.element_id);
  }

  replaceElementsWithSession(diagramId: string, nextElements: ServerElement[], sessionId?: string | null): void {
    this.replaceElements(diagramId, nextElements, sessionId);
  }

  upsertElementWithSession(diagramId: string, element: ServerElement, sessionId?: string | null): ServerElement {
    return this.upsertElement(diagramId, element, sessionId);
  }

  deleteElementWithSession(diagramId: string, elementId: string, sessionId?: string | null): boolean {
    return this.deleteElement(diagramId, elementId, sessionId);
  }

  clearDiagramWithSession(diagramId: string, sessionId?: string | null): number {
    return this.clearDiagram(diagramId, sessionId);
  }

  getDiagram(diagramId = DEFAULT_DIAGRAM_ID): DiagramRecord {
    const row = this.db.prepare('SELECT * FROM diagrams WHERE id = ?').get(diagramId);
    if (!row) {
      throw new Error(`Diagram ${diagramId} not found`);
    }
    return rowToDiagram(row);
  }

  ensureDiagram(input: Partial<DiagramRecord> & { id?: string; name?: string } = {}): DiagramRecord {
    const id = input.id || DEFAULT_DIAGRAM_ID;
    const existing = this.db.prepare('SELECT * FROM diagrams WHERE id = ?').get(id);
    if (existing) {
      return rowToDiagram(existing);
    }

    const timestamp = nowIso();
    const record: DiagramRecord = {
      id,
      name: input.name || DEFAULT_DIAGRAM_NAME,
      tags: input.tags || [],
      description: input.description ?? null,
      thumbnail: input.thumbnail ?? null,
      archivedAt: input.archivedAt ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.db.prepare(`
      INSERT INTO diagrams (id, name, tags, description, thumbnail, archived_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.name,
      JSON.stringify(record.tags),
      record.description,
      record.thumbnail,
      record.archivedAt,
      record.createdAt,
      record.updatedAt,
    );

    return record;
  }

  listElements(diagramId = DEFAULT_DIAGRAM_ID): ServerElement[] {
    const rows = this.db.prepare(`
      SELECT data_json FROM elements
      WHERE diagram_id = ? AND is_deleted = 0
      ORDER BY updated_at ASC
    `).all(diagramId) as Array<{ data_json: string }>;

    return rows.map(row => parseJson<ServerElement>(row.data_json, {} as ServerElement));
  }

  getElement(diagramId: string, elementId: string): ServerElement | null {
    const row = this.db.prepare(`
      SELECT data_json FROM elements
      WHERE diagram_id = ? AND id = ? AND is_deleted = 0
    `).get(diagramId, elementId) as { data_json: string } | undefined;

    return row ? parseJson<ServerElement>(row.data_json, {} as ServerElement) : null;
  }

  upsertElement(diagramId: string, element: ServerElement, sessionId?: string | null): ServerElement {
    this.ensureDiagram({ id: diagramId });
    const timestamp = nowIso();
    const existing = this.getElement(diagramId, element.id);
    const version = (existing?.version || 0) + 1;
    const nextElement: ServerElement = {
      ...existing,
      ...element,
      version,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };

    this.db.prepare(`
      INSERT INTO elements (diagram_id, id, data_json, is_deleted, version, updated_by_session_id, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT(diagram_id, id) DO UPDATE SET
        data_json = excluded.data_json,
        is_deleted = 0,
        version = excluded.version,
        updated_by_session_id = excluded.updated_by_session_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      diagramId,
      nextElement.id,
      JSON.stringify(nextElement),
      version,
      sessionId || null,
      nextElement.createdAt,
      nextElement.updatedAt,
    );

    this.touchDiagram(diagramId, timestamp);
    this.recordEvent({
      diagramId,
      sessionId,
      eventType: existing ? 'element_updated' : 'element_created',
      elementId: nextElement.id,
      payload: nextElement as unknown as Record<string, any>,
      previousPayload: existing ? (existing as unknown as Record<string, any>) : null,
    });

    return nextElement;
  }

  replaceElements(diagramId: string, nextElements: ServerElement[], sessionId?: string | null): void {
    this.ensureDiagram({ id: diagramId });

    // Schema hardening: validate batch operation at DB layer
    const validation = validateBatchOperation(nextElements);
    if (!validation.valid) {
      logger.error('replaceElements validation failed', { errors: validation.errors });
      throw new Error(`Batch validation failed: ${validation.errors.join(', ')}`);
    }
    if (validation.warnings.length > 0) {
      logger.warn('replaceElements warnings', { warnings: validation.warnings });
    }

    // Enforce element count limit per diagram
    const currentCount = this.listElements(diagramId).length;
    if (currentCount + nextElements.length > VALIDATION_LIMITS.MAX_ELEMENTS_PER_DIAGRAM) {
      throw new Error(`Diagram would exceed ${VALIDATION_LIMITS.MAX_ELEMENTS_PER_DIAGRAM} elements`);
    }

    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM elements WHERE diagram_id = ?').run(diagramId);
      const timestamp = nowIso();
      const insert = this.db.prepare(`
        INSERT INTO elements (diagram_id, id, data_json, is_deleted, version, updated_by_session_id, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?, ?, ?)
      `);

      nextElements.forEach((element, index) => {
        const createdAt = element.createdAt || timestamp;
        const updatedAt = timestamp;
        const version = element.version || 1;
        const nextElement: ServerElement = {
          ...element,
          version,
          createdAt,
          updatedAt,
        };

        insert.run(
          diagramId,
          nextElement.id,
          JSON.stringify(nextElement),
          version,
          sessionId || null,
          createdAt,
          updatedAt,
        );
      });

      this.touchDiagram(diagramId, timestamp);
      this.recordEvent({
        diagramId,
        sessionId,
        eventType: 'elements_replaced',
        payload: { count: nextElements.length },
      });
    });

    transaction();
  }

  deleteElement(diagramId: string, elementId: string, sessionId?: string | null): boolean {
    const existing = this.getElement(diagramId, elementId);
    if (!existing) return false;

    const timestamp = nowIso();
    const result = this.db.prepare(`
      DELETE FROM elements WHERE diagram_id = ? AND id = ?
    `).run(diagramId, elementId);

    if (result.changes > 0) {
      this.touchDiagram(diagramId, timestamp);
      this.recordEvent({
        diagramId,
        sessionId,
        eventType: 'element_deleted',
        elementId,
        previousPayload: existing as unknown as Record<string, any>,
      });
      return true;
    }

    return false;
  }

  clearDiagram(diagramId: string, sessionId?: string | null): number {
    const result = this.db.prepare('DELETE FROM elements WHERE diagram_id = ?').run(diagramId);
    this.touchDiagram(diagramId);
    this.recordEvent({
      diagramId,
      sessionId,
      eventType: 'canvas_cleared',
      payload: { deletedCount: result.changes },
    });
    return result.changes;
  }

  listFiles(diagramId = DEFAULT_DIAGRAM_ID): ExcalidrawFile[] {
    const rows = this.db.prepare(`
      SELECT * FROM files WHERE diagram_id = ? ORDER BY updated_at ASC
    `).all(diagramId);
    return rows.map(rowToFile);
  }

  upsertFiles(diagramId: string, inputFiles: ExcalidrawFile[], sessionId?: string | null): void {
    this.ensureDiagram({ id: diagramId });
    const timestamp = nowIso();
    const upsert = this.db.prepare(`
      INSERT INTO files (diagram_id, id, data_url, mime_type, created, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(diagram_id, id) DO UPDATE SET
        data_url = excluded.data_url,
        mime_type = excluded.mime_type,
        created = excluded.created,
        updated_at = excluded.updated_at
    `);

    const transaction = this.db.transaction(() => {
      inputFiles.forEach(file => {
        upsert.run(diagramId, file.id, file.dataURL, file.mimeType, file.created, timestamp);
      });
      this.touchDiagram(diagramId, timestamp);
      this.recordEvent({
        diagramId,
        sessionId,
        eventType: 'files_updated',
        payload: { count: inputFiles.length },
      });
    });

    transaction();
  }

  deleteFile(diagramId: string, fileId: string): boolean {
    const result = this.db.prepare('DELETE FROM files WHERE diagram_id = ? AND id = ?').run(diagramId, fileId);
    if (result.changes > 0) {
      this.touchDiagram(diagramId);
      return true;
    }
    return false;
  }

  saveSnapshot(diagramId: string, snapshot: Snapshot, sessionId?: string | null): DiagramSnapshotRecord {
    const record: DiagramSnapshotRecord = {
      diagramId,
      name: snapshot.name,
      elements: snapshot.elements,
      createdAt: snapshot.createdAt,
    };

    this.db.prepare(`
      INSERT INTO snapshots (diagram_id, name, elements_json, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(diagram_id, name) DO UPDATE SET
        elements_json = excluded.elements_json,
        created_at = excluded.created_at
    `).run(record.diagramId, record.name, JSON.stringify(record.elements), record.createdAt);

    this.recordEvent({
      diagramId,
      sessionId,
      eventType: 'snapshot_created',
      payload: { name: record.name, elementCount: record.elements.length },
    });

    return record;
  }

  restoreSnapshot(diagramId: string, name: string, sessionId?: string | null): DiagramSnapshotRecord {
    const snapshot = this.getSnapshot(diagramId, name);
    if (!snapshot) {
      throw new Error(`Snapshot "${name}" not found`);
    }

    this.replaceElements(diagramId, snapshot.elements, sessionId);
    this.recordEvent({
      diagramId,
      sessionId,
      eventType: 'snapshot_restored',
      payload: { name: snapshot.name, elementCount: snapshot.elements.length },
    });

    return snapshot;
  }

  listSnapshots(diagramId = DEFAULT_DIAGRAM_ID): DiagramSnapshotRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM snapshots WHERE diagram_id = ? ORDER BY created_at DESC
    `).all(diagramId);
    return rows.map(rowToSnapshot);
  }

  getSnapshot(diagramId: string, name: string): DiagramSnapshotRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM snapshots WHERE diagram_id = ? AND name = ?
    `).get(diagramId, name);

    return row ? rowToSnapshot(row) : null;
  }

  deleteSnapshot(diagramId: string, name: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM snapshots WHERE diagram_id = ? AND name = ?
    `).run(diagramId, name);
    return result.changes > 0;
  }

  upsertSceneState(state: Omit<SceneStateRecord, 'createdAt' | 'updatedAt'>): SceneStateRecord {
    const existing = this.getSceneState(state.diagramId);
    const timestamp = nowIso();
    const record: SceneStateRecord = {
      ...state,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    };

    this.db.prepare(`
      INSERT INTO scene_state (diagram_id, theme, viewport_json, selected_element_ids_json, groups_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(diagram_id) DO UPDATE SET
        theme = excluded.theme,
        viewport_json = excluded.viewport_json,
        selected_element_ids_json = excluded.selected_element_ids_json,
        groups_json = excluded.groups_json,
        updated_at = excluded.updated_at
    `).run(
      record.diagramId,
      record.theme,
      JSON.stringify(record.viewport),
      JSON.stringify(record.selectedElementIds),
      JSON.stringify(record.groups),
      record.createdAt,
      record.updatedAt,
    );

    return record;
  }

  getSceneState(diagramId = DEFAULT_DIAGRAM_ID): SceneStateRecord | null {
    const row = this.db.prepare('SELECT * FROM scene_state WHERE diagram_id = ?').get(diagramId);
    return row ? rowToSceneState(row) : null;
  }

  upsertSession(session: Partial<SessionRecord> & { id: string; activeDiagramId: string }): SessionRecord {
    this.ensureDiagram({ id: session.activeDiagramId });
    const existing = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) as Record<string, any> | undefined;
    const timestamp = nowIso();
    const record: SessionRecord = {
      id: session.id,
      activeDiagramId: session.activeDiagramId,
      status: session.status || 'active',
      lastHeartbeatAt: session.lastHeartbeatAt || timestamp,
      lastSyncAt: session.lastSyncAt ?? existing?.last_sync_at ?? null,
      lastAckVersion: session.lastAckVersion ?? existing?.last_ack_version ?? 0,
      createdAt: existing?.created_at || timestamp,
      updatedAt: timestamp,
    };

    this.db.prepare(`
      INSERT INTO sessions (id, active_diagram_id, status, last_heartbeat_at, last_sync_at, last_ack_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        active_diagram_id = excluded.active_diagram_id,
        status = excluded.status,
        last_heartbeat_at = excluded.last_heartbeat_at,
        last_sync_at = excluded.last_sync_at,
        last_ack_version = excluded.last_ack_version,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.activeDiagramId,
      record.status,
      record.lastHeartbeatAt,
      record.lastSyncAt,
      record.lastAckVersion,
      record.createdAt,
      record.updatedAt,
    );

    return record;
  }

  listSessions(diagramId = DEFAULT_DIAGRAM_ID): SessionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM sessions WHERE active_diagram_id = ? ORDER BY updated_at DESC
    `).all(diagramId);
    return rows.map(rowToSession);
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    return row ? rowToSession(row) : null;
  }

  markSessionStatus(sessionId: string, status: SessionStatus): SessionRecord | null {
    const existing = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, any> | undefined;
    if (!existing) {
      return null;
    }

    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE sessions
      SET status = ?, updated_at = ?, last_heartbeat_at = CASE WHEN ? = 'closed' THEN last_heartbeat_at ELSE ? END
      WHERE id = ?
    `).run(status, timestamp, status, timestamp, sessionId);

    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    return row ? rowToSession(row) : null;
  }

  markStaleSessions(staleBeforeIso: string): number {
    const result = this.db.prepare(`
      UPDATE sessions
      SET status = 'stale', updated_at = ?
      WHERE status = 'active' AND last_heartbeat_at < ?
    `).run(nowIso(), staleBeforeIso);
    return result.changes;
  }

  // Operation locks for temporary blocking of destructive actions
  private operationLocks = new Map<string, OperationLock>();

  acquireOperationLock(operationType: OperationLock['operationType'], lockedBySessionId: string, ttlMs = 30000): boolean {
    const key = operationType;
    const existing = this.operationLocks.get(key);
    if (existing && existing.expiresAt > nowIso() && existing.lockedBySessionId !== lockedBySessionId) {
      return false; // Already locked by another session
    }
    this.operationLocks.set(key, {
      operationType,
      lockedBySessionId,
      lockedAt: nowIso(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    });
    return true;
  }

  releaseOperationLock(operationType: OperationLock['operationType'], lockedBySessionId: string): boolean {
    const existing = this.operationLocks.get(operationType);
    if (!existing) return true;
    if (existing.lockedBySessionId !== lockedBySessionId) return false;
    this.operationLocks.delete(operationType);
    return true;
  }

  getOperationLock(operationType: OperationLock['operationType']): OperationLock | null {
    const lock = this.operationLocks.get(operationType);
    if (!lock) return null;
    if (lock.expiresAt < nowIso()) {
      this.operationLocks.delete(operationType);
      return null;
    }
    return lock;
  }

  // Session presence: list active sessions for a diagram (excluding stale/closed)
  listActiveSessions(diagramId = DEFAULT_DIAGRAM_ID): SessionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE active_diagram_id = ? AND status IN ('active', 'idle')
      ORDER BY last_heartbeat_at DESC
    `).all(diagramId);
    return rows.map(rowToSession);
  }

  // Get conflicting sessions (active sessions that haven't acknowledged current server version)
  listConflictingSessions(diagramId = DEFAULT_DIAGRAM_ID): SessionRecord[] {
    const serverVersion = this.getDiagramVersion(diagramId);
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE active_diagram_id = ?
        AND status = 'active'
        AND last_ack_version < ?
        AND last_ack_version >= 0
      ORDER BY last_heartbeat_at DESC
    `).all(diagramId, serverVersion);
    return rows.map(rowToSession);
  }

  closeSessionsForDiagram(diagramId: string): number {
    const result = this.db.prepare(`
      UPDATE sessions
      SET status = 'closed', updated_at = ?
      WHERE active_diagram_id = ? AND status != 'closed'
    `).run(nowIso(), diagramId);
    return result.changes;
  }

  duplicateDiagram(diagramId: string, name?: string): DiagramRecord {
    const source = this.getDiagramState(diagramId);
    const duplicateId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const duplicate = this.ensureDiagram({
      id: duplicateId,
      name: name || `${source.diagram.name} Copy`,
      tags: source.diagram.tags,
      description: source.diagram.description ?? null,
      thumbnail: source.diagram.thumbnail ?? null,
    });

    if (source.elements.length > 0) {
      this.replaceElements(duplicateId, source.elements);
    }
    if (source.files.length > 0) {
      this.upsertFiles(duplicateId, source.files);
    }
    source.snapshots.forEach(snapshot => {
      this.saveSnapshot(duplicateId, {
        name: snapshot.name,
        elements: snapshot.elements,
        createdAt: snapshot.createdAt,
      });
    });
    if (source.sceneState) {
      this.upsertSceneState({
        diagramId: duplicateId,
        theme: source.sceneState.theme,
        viewport: source.sceneState.viewport,
        selectedElementIds: source.sceneState.selectedElementIds,
        groups: source.sceneState.groups,
      });
    }

    return this.getDiagram(duplicateId);
  }

  searchDiagrams(query: string, tags?: string[]): DiagramRecord[] {
    const all = this.listDiagrams();
    const q = query.toLowerCase();
    return all.filter(d => {
      if (d.archivedAt) return false;
      const matchName = !q || d.name.toLowerCase().includes(q);
      const matchDesc = !q || (d.description?.toLowerCase().includes(q) ?? false);
      const matchTags = !tags?.length || tags.some(t => d.tags.includes(t));
      return (matchName || matchDesc) && matchTags;
    });
  }

  listRecentDiagrams(limit = 10): DiagramRecord[] {
    return this.listDiagrams()
      .filter(d => !d.archivedAt)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, limit);
  }

  setDiagramThumbnail(diagramId: string, thumbnail: string): DiagramRecord {
    return this.updateDiagram(diagramId, { thumbnail });
  }

  archiveDiagram(diagramId: string): DiagramRecord {
    if (diagramId === DEFAULT_DIAGRAM_ID) {
      throw new Error('Cannot archive the default diagram');
    }
    return this.updateDiagram(diagramId, { archivedAt: new Date().toISOString() });
  }

  unarchiveDiagram(diagramId: string): DiagramRecord {
    return this.updateDiagram(diagramId, { archivedAt: null });
  }

  exportDiagram(diagramId: string): DiagramStateSnapshot {
    return this.getDiagramState(diagramId);
  }

  importDiagram(snapshot: DiagramStateSnapshot, targetId?: string): DiagramRecord {
    const id = targetId || generateId();
    const diagram = this.ensureDiagram({
      id,
      name: snapshot.diagram.name,
      tags: snapshot.diagram.tags,
      description: snapshot.diagram.description ?? null,
      thumbnail: snapshot.diagram.thumbnail ?? null,
    });
    if (snapshot.elements.length > 0) {
      this.replaceElements(id, snapshot.elements);
    }
    if (snapshot.files.length > 0) {
      this.upsertFiles(id, snapshot.files);
    }
    snapshot.snapshots.forEach(s => {
      this.saveSnapshot(id, { name: s.name, elements: s.elements, createdAt: s.createdAt });
    });
    if (snapshot.sceneState) {
      this.upsertSceneState({
        diagramId: id,
        theme: snapshot.sceneState.theme,
        viewport: snapshot.sceneState.viewport,
        selectedElementIds: snapshot.sceneState.selectedElementIds,
        groups: snapshot.sceneState.groups,
      });
    }
    return this.getDiagram(id);
  }

  deleteDiagram(diagramId: string): boolean {
    if (diagramId === DEFAULT_DIAGRAM_ID) {
      throw new Error('Cannot delete the default diagram');
    }

    const result = this.db.prepare('DELETE FROM diagrams WHERE id = ?').run(diagramId);
    return result.changes > 0;
  }

  listEvents(diagramId = DEFAULT_DIAGRAM_ID, limit = 100): SyncEventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM sync_events WHERE diagram_id = ? ORDER BY id DESC LIMIT ?
    `).all(diagramId, limit);
    return rows.map(rowToEvent);
  }

  updateDiagram(id: string, patch: Partial<Pick<DiagramRecord, 'name' | 'tags' | 'description' | 'thumbnail' | 'archivedAt'>>): DiagramRecord {
    const existing = this.getDiagram(id);
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE diagrams SET
        name = ?,
        tags = ?,
        description = ?,
        thumbnail = ?,
        archived_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      patch.name ?? existing.name,
      JSON.stringify(patch.tags ?? existing.tags),
      patch.description !== undefined ? patch.description : existing.description,
      patch.thumbnail !== undefined ? patch.thumbnail : existing.thumbnail,
      patch.archivedAt !== undefined ? patch.archivedAt : existing.archivedAt,
      timestamp,
      id,
    );
    return this.getDiagram(id);
  }

  getDiagramState(diagramId = DEFAULT_DIAGRAM_ID): DiagramStateSnapshot {
    return {
      diagram: this.getDiagram(diagramId),
      elements: this.listElements(diagramId),
      files: this.listFiles(diagramId),
      snapshots: this.listSnapshots(diagramId),
      sessions: this.listSessions(diagramId),
      sceneState: this.getSceneState(diagramId),
    };
  }

  private touchDiagram(diagramId: string, timestamp = nowIso()): void {
    this.db.prepare('UPDATE diagrams SET updated_at = ? WHERE id = ?').run(timestamp, diagramId);
  }

  private recordEvent(event: {
    diagramId: string;
    sessionId?: string | null;
    eventType: SyncEventType;
    elementId?: string | null;
    payload?: Record<string, any> | null;
    previousPayload?: Record<string, any> | null;
  }): void {
    this.db.prepare(`
      INSERT INTO sync_events (diagram_id, session_id, event_type, element_id, payload_json, previous_payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.diagramId,
      event.sessionId || null,
      event.eventType,
      event.elementId || null,
      event.payload ? JSON.stringify(event.payload) : null,
      event.previousPayload ? JSON.stringify(event.previousPayload) : null,
      nowIso(),
    );
  }

  private recordMutation(
    diagramId: string,
    operation: string,
    elementId: string | null,
    elementData: ServerElement | null,
    previousData: ServerElement | null,
    sessionId?: string | null
  ): void {
    const timestamp = nowIso();
    const nextSeq = this.getNextMutationSequence(diagramId);
    this.db.prepare(`
      INSERT INTO mutation_history (diagram_id, session_id, operation, element_id, element_data_json, previous_data_json, sequence_num, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      diagramId,
      sessionId || null,
      operation,
      elementId,
      elementData ? JSON.stringify(elementData) : null,
      previousData ? JSON.stringify(previousData) : null,
      nextSeq,
      timestamp,
    );
  }

  private getNextMutationSequence(diagramId: string): number {
    const row = this.db.prepare('SELECT MAX(sequence_num) as max_seq FROM mutation_history WHERE diagram_id = ?').get(diagramId) as { max_seq: number | null } | undefined;
    return (row?.max_seq ?? -1) + 1;
  }

  getMutationHistory(diagramId: string, limit = 50): Array<{ id: number; operation: string; elementId: string | null; elementData: ServerElement | null; previousData: ServerElement | null; sequenceNum: number; createdAt: string }> {
    const rows = this.db.prepare(`
      SELECT id, operation, element_id, element_data_json, previous_data_json, sequence_num, created_at
      FROM mutation_history
      WHERE diagram_id = ?
      ORDER BY sequence_num DESC
      LIMIT ?
    `).all(diagramId, limit) as Array<{ id: number; operation: string; element_id: string | null; element_data_json: string | null; previous_data_json: string | null; sequence_num: number; created_at: string }>;

    return rows.map(row => ({
      id: row.id,
      operation: row.operation,
      elementId: row.element_id,
      elementData: row.element_data_json ? parseJson<ServerElement>(row.element_data_json, {} as ServerElement) : null,
      previousData: row.previous_data_json ? parseJson<ServerElement>(row.previous_data_json, {} as ServerElement) : null,
      sequenceNum: row.sequence_num,
      createdAt: row.created_at,
    }));
  }

  undoLastMutation(diagramId: string): ServerElement | null {
    const history = this.getMutationHistory(diagramId, 1);
    if (history.length === 0) return null;

    const lastMutation = history[0]!;
    if (lastMutation.operation === 'delete' && lastMutation.previousData) {
      this.upsertElement(diagramId, lastMutation.previousData);
      this.db.prepare('DELETE FROM mutation_history WHERE id = ?').run(lastMutation.id);
      return lastMutation.previousData;
    } else if (lastMutation.operation === 'create' && lastMutation.elementData) {
      this.deleteElement(diagramId, lastMutation.elementData.id);
      this.db.prepare('DELETE FROM mutation_history WHERE id = ?').run(lastMutation.id);
      return lastMutation.elementData;
    } else if (lastMutation.operation === 'update' && lastMutation.previousData) {
      this.upsertElement(diagramId, lastMutation.previousData);
      this.db.prepare('DELETE FROM mutation_history WHERE id = ?').run(lastMutation.id);
      return lastMutation.previousData;
    } else if (lastMutation.operation === 'replace') {
      if (lastMutation.previousData) {
        const prevElements = lastMutation.previousData as unknown as ServerElement[];
        if (Array.isArray(prevElements) && prevElements.length > 0) {
          this.replaceElements(diagramId, prevElements);
          this.db.prepare('DELETE FROM mutation_history WHERE id = ?').run(lastMutation.id);
          return prevElements[0]!;
        }
      }
    }

    return null;
  }

  // Wrap element operations to record history
  upsertElementWithHistory(diagramId: string, element: ServerElement, sessionId?: string | null): ServerElement {
    const existing = this.getElement(diagramId, element.id);
    const result = this.upsertElement(diagramId, element, sessionId);
    this.recordMutation(
      diagramId,
      existing ? 'update' : 'create',
      element.id,
      result,
      existing,
      sessionId
    );
    return result;
  }

  deleteElementWithHistory(diagramId: string, elementId: string, sessionId?: string | null): boolean {
    const existing = this.getElement(diagramId, elementId);
    if (!existing) return false;
    const result = this.deleteElement(diagramId, elementId, sessionId);
    if (result) {
      this.recordMutation(diagramId, 'delete', elementId, null, existing, sessionId);
    }
    return result;
  }

  replaceElementsWithHistory(diagramId: string, nextElements: ServerElement[], sessionId?: string | null, previousElements?: ServerElement[]): void {
    this.recordMutation(
      diagramId,
      'replace',
      null,
      nextElements as unknown as ServerElement,
      previousElements ? previousElements as unknown as ServerElement : null,
      sessionId
    );
    this.replaceElements(diagramId, nextElements, sessionId);
  }
}

export const diagramStore = new DiagramStore();

logger.info('Diagram store initialized', { dbPath: DB_PATH });
