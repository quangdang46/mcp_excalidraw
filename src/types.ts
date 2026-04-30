export interface ExcalidrawElementBase {
  id: string;
  type: ExcalidrawElementType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  groupIds?: string[];
  frameId?: string | null;
  roundness?: {
    type: number;
    value?: number;
  } | null;
  seed?: number;
  versionNonce?: number;
  isDeleted?: boolean;
  locked?: boolean;
  link?: string | null;
  customData?: Record<string, any> | null;
  boundElements?: readonly ExcalidrawBoundElement[] | null;
  updated?: number;
  containerId?: string | null;
}

export interface ExcalidrawTextElement extends ExcalidrawElementBase {
  type: 'text';
  text: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  baseline?: number;
  lineHeight?: number;
}

export interface ExcalidrawRectangleElement extends ExcalidrawElementBase {
  type: 'rectangle';
  width: number;
  height: number;
}

export interface ExcalidrawEllipseElement extends ExcalidrawElementBase {
  type: 'ellipse';
  width: number;
  height: number;
}

export interface ExcalidrawDiamondElement extends ExcalidrawElementBase {
  type: 'diamond';
  width: number;
  height: number;
}

export interface ExcalidrawArrowElement extends ExcalidrawElementBase {
  type: 'arrow';
  points: readonly [number, number][];
  lastCommittedPoint?: readonly [number, number] | null;
  startBinding?: ExcalidrawBinding | null;
  endBinding?: ExcalidrawBinding | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
}

export interface ExcalidrawLineElement extends ExcalidrawElementBase {
  type: 'line';
  points: readonly [number, number][];
  lastCommittedPoint?: readonly [number, number] | null;
  startBinding?: ExcalidrawBinding | null;
  endBinding?: ExcalidrawBinding | null;
}

export interface ExcalidrawFreedrawElement extends ExcalidrawElementBase {
  type: 'freedraw';
  points: readonly [number, number][];
  pressures?: readonly number[];
  simulatePressure?: boolean;
  lastCommittedPoint?: readonly [number, number] | null;
}

export type ExcalidrawElement = 
  | ExcalidrawTextElement
  | ExcalidrawRectangleElement
  | ExcalidrawEllipseElement
  | ExcalidrawDiamondElement
  | ExcalidrawArrowElement
  | ExcalidrawLineElement
  | ExcalidrawFreedrawElement;

export interface ExcalidrawBoundElement {
  id: string;
  type: 'text' | 'arrow';
}

export interface ExcalidrawBinding {
  elementId: string;
  focus: number;
  gap: number;
  fixedPoint?: readonly [number, number] | null;
}

export type ExcalidrawElementType = 'rectangle' | 'ellipse' | 'diamond' | 'arrow' | 'text' | 'line' | 'freedraw' | 'image';

// Excalidraw element types
export const EXCALIDRAW_ELEMENT_TYPES: Record<string, ExcalidrawElementType> = {
  RECTANGLE: 'rectangle',
  ELLIPSE: 'ellipse',
  DIAMOND: 'diamond',
  ARROW: 'arrow',
  TEXT: 'text',
  FREEDRAW: 'freedraw',
  LINE: 'line',
  IMAGE: 'image'
} as const;

// Server-side element with metadata
export interface ServerElement extends Omit<ExcalidrawElementBase, 'id'> {
  id: string;
  type: ExcalidrawElementType;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  syncedAt?: string;
  source?: string;
  syncTimestamp?: string;
  text?: string;
  originalText?: string;
  fontSize?: number;
  fontFamily?: string | number;
  label?: {
    text: string;
  };
  points?: any;
  // Arrow element binding: connect arrows to shapes by element ID
  start?: { id: string };
  end?: { id: string };
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface ElementsResponse extends ApiResponse {
  elements: ServerElement[];
  count: number;
}

export interface ElementResponse extends ApiResponse {
  element: ServerElement;
}

export interface SyncResponse extends ApiResponse {
  count: number;
  syncedAt: string;
  beforeCount: number;
  afterCount: number;
}

export interface VersionedSyncRequest {
  sessionId: string;
  baseVersion: number;
  elements: ServerElement[];
  timestamp: string;
}

export interface VersionedSyncResponse extends ApiResponse {
  diagramId: string;
  sessionId: string;
  serverVersion: number;
  applied: boolean;
  count: number;
  syncedAt: string;
  conflicts?: boolean;
  elements?: ServerElement[];
}

export interface InitialSceneState {
  diagramId: string;
  serverVersion: number;
  sessionId?: string;
}

// WebSocket message types
export interface WebSocketMessage {
  type: WebSocketMessageType;
  [key: string]: any;
}

export type WebSocketMessageType =
  | 'initial_elements'
  | 'element_created'
  | 'element_updated'
  | 'element_deleted'
  | 'elements_batch_created'
  | 'elements_synced'
  | 'sync_status'
  | 'mermaid_convert'
  | 'canvas_cleared'
  | 'export_image_request'
  | 'set_viewport'
  | 'files_added'
  | 'file_deleted'
  | 'diagram_updated';

export interface InitialElementsMessage extends WebSocketMessage {
  type: 'initial_elements';
  elements: ServerElement[];
}

export interface ElementCreatedMessage extends WebSocketMessage {
  type: 'element_created';
  element: ServerElement;
}

export interface ElementUpdatedMessage extends WebSocketMessage {
  type: 'element_updated';
  element: ServerElement;
}

export interface ElementDeletedMessage extends WebSocketMessage {
  type: 'element_deleted';
  elementId: string;
}

export interface BatchCreatedMessage extends WebSocketMessage {
  type: 'elements_batch_created';
  elements: ServerElement[];
}

export interface SyncStatusMessage extends WebSocketMessage {
  type: 'sync_status';
  elementCount: number;
  timestamp: string;
}

export interface MermaidConvertMessage extends WebSocketMessage {
  type: 'mermaid_convert';
  mermaidDiagram: string;
  config?: MermaidConfig;
  timestamp: string;
}

// Mermaid conversion types
export interface MermaidConfig {
  startOnLoad?: boolean;
  flowchart?: {
    curve?: 'linear' | 'basis';
  };
  themeVariables?: {
    fontSize?: string;
  };
  maxEdges?: number;
  maxTextSize?: number;
}

export interface MermaidConversionRequest {
  mermaidDiagram: string;
  config?: MermaidConfig;
}

export interface MermaidConversionResponse extends ApiResponse {
  elements: ServerElement[];
  files?: any;
  count: number;
}

// Canvas cleared message
export interface CanvasClearedMessage extends WebSocketMessage {
  type: 'canvas_cleared';
  timestamp: string;
}

// Image export types
export interface ExportImageRequestMessage extends WebSocketMessage {
  type: 'export_image_request';
  requestId: string;
  format: 'png' | 'svg';
  background?: boolean;
}

// Viewport control types
export interface SetViewportMessage extends WebSocketMessage {
  type: 'set_viewport';
  requestId: string;
  scrollToContent?: boolean;
  scrollToElementId?: string;
  zoom?: number;
  offsetX?: number;
  offsetY?: number;
}

export interface DiagramUpdatedMessage extends WebSocketMessage {
  type: 'diagram_updated';
  diagramId: string;
  diagramName: string;
  action: string;
}

// Snapshot types
export interface Snapshot {
  name: string;
  elements: ServerElement[];
  createdAt: string;
}

export interface DiagramRecord {
  id: string;
  name: string;
  tags: string[];
  description?: string | null;
  thumbnail?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SessionStatus = 'active' | 'idle' | 'stale' | 'closed';

export interface SessionRecord {
  id: string;
  activeDiagramId: string;
  status: SessionStatus;
  lastHeartbeatAt: string;
  lastSyncAt?: string | null;
  lastAckVersion: number;
  createdAt: string;
  updatedAt: string;
}

// Operation lock for temporary blocking of destructive actions
export interface OperationLock {
  operationType: 'clear' | 'bulk_delete' | 'restore' | 'import';
  lockedBySessionId: string;
  lockedAt: string;
  expiresAt: string;
}

// Session presence info for a diagram
export interface DiagramPresence {
  diagramId: string;
  activeSessions: SessionRecord[];
  staleCount: number;
  conflictingCount: number; // sessions that have unacknowledged changes
}

export type SyncEventType =
  | 'element_created'
  | 'element_updated'
  | 'element_deleted'
  | 'elements_replaced'
  | 'snapshot_created'
  | 'snapshot_restored'
  | 'files_updated'
  | 'canvas_cleared';

export interface SyncEventRecord {
  id: number;
  diagramId: string;
  sessionId?: string | null;
  eventType: SyncEventType;
  elementId?: string | null;
  payload?: Record<string, any> | null;
  previousPayload?: Record<string, any> | null;
  createdAt: string;
}

export interface DiagramSnapshotRecord extends Snapshot {
  diagramId: string;
}

export interface DiagramSummary extends DiagramRecord {
  elementCount: number;
  snapshotCount: number;
  sessionCount: number;
}

export interface SceneStateRecord {
  diagramId: string;
  theme: string;
  viewport: { x: number; y: number; zoom: number };
  selectedElementIds: string[];
  groups: Record<string, string[]>;
  createdAt: string;
  updatedAt: string;
}

export interface DiagramStateSnapshot {
  diagram: DiagramRecord;
  elements: ServerElement[];
  files: ExcalidrawFile[];
  snapshots: DiagramSnapshotRecord[];
  sessions: SessionRecord[];
  sceneState?: SceneStateRecord | null;
}

export const DEFAULT_DIAGRAM_ID = 'default';
export const DEFAULT_DIAGRAM_NAME = 'Untitled Diagram';

// In-memory file storage for image elements (Excalidraw BinaryFiles)
export interface ExcalidrawFile {
  id: string;
  dataURL: string;
  mimeType: string;
  created: number;
}

// Validation function for Excalidraw elements
export function validateElement(element: Partial<ServerElement>): element is ServerElement {
  const requiredFields: (keyof ServerElement)[] = ['type', 'x', 'y'];
  const hasRequiredFields = requiredFields.every(field => field in element);
  
  if (!hasRequiredFields) {
    throw new Error(`Missing required fields: ${requiredFields.join(', ')}`);
  }

  if (!Object.values(EXCALIDRAW_ELEMENT_TYPES).includes(element.type as ExcalidrawElementType)) {
    throw new Error(`Invalid element type: ${element.type}`);
  }

  return true;
}

// Helper function to generate unique IDs
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Normalize fontFamily from string names to numeric values that Excalidraw expects
// Excalidraw uses: 1 = Virgil (handwritten), 2 = Helvetica (sans-serif), 3 = Cascadia (monospace)
// 5 = Excalifont, 6 = Nunito, 7 = Lilita One, 8 = Comic Shanns
export function normalizeFontFamily(fontFamily: string | number | undefined): number | undefined {
  if (fontFamily === undefined) return undefined;
  if (typeof fontFamily === 'number') return fontFamily;
  const map: Record<string, number> = {
    'virgil': 1, 'hand': 1, 'handwritten': 1,
    'helvetica': 2, 'sans': 2, 'sans-serif': 2,
    'cascadia': 3, 'mono': 3, 'monospace': 3,
    'excalifont': 5,
    'nunito': 6,
    'lilita': 7, 'lilita one': 7,
    'comic shanns': 8, 'comic': 8,
    '1': 1, '2': 2, '3': 3, '5': 5, '6': 6, '7': 7, '8': 8,
  };
  return map[fontFamily.toLowerCase()];
}

// Validation limits for persistence layer
export const VALIDATION_LIMITS = {
  MAX_ELEMENT_SIZE_BYTES: 500_000,     // 500KB per element
  MAX_ELEMENTS_PER_DIAGRAM: 100_000,  // 100k elements per diagram
  MAX_ELEMENTS_PER_BATCH: 10_000,    // 10k elements per batch operation
  MAX_PAYLOAD_SIZE_BYTES: 50_000_000, // 50MB total payload
  MAX_TEXT_LENGTH: 100_000,           // 100k chars for text elements
  MAX_POINTS_PER_ELEMENT: 10_000,     // 10k points for freedraw/arrow/line
  MAX_FILES_PER_DIAGRAM: 1_000,       // 1k files per diagram
  MAX_FILE_SIZE_BYTES: 20_000_000,    // 20MB per file
  MAX_SNAPSHOT_NAME_LENGTH: 255,     // 255 chars for snapshot names
  MAX_TAG_LENGTH: 50,                // 50 chars per tag
  MAX_TAGS_PER_DIAGRAM: 20,           // 20 tags per diagram
  MAX_DESCRIPTION_LENGTH: 1000,       // 1k chars for description
  MAX_SESSION_ID_LENGTH: 100,         // 100 chars for session IDs
  MAX_DIAGRAM_NAME_LENGTH: 255,       // 255 chars for diagram names
} as const;

// Schema hardening: validate element against known limits
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateElementLimits(element: Partial<ServerElement>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check text length
  if (element.type === 'text') {
    const text = (element as ExcalidrawTextElement).text;
    if (text && text.length > VALIDATION_LIMITS.MAX_TEXT_LENGTH) {
      errors.push(`Text content exceeds ${VALIDATION_LIMITS.MAX_TEXT_LENGTH} characters`);
    }
  }

  // Check points count for path elements
  if (element.type === 'arrow' || element.type === 'line' || element.type === 'freedraw') {
    const points = (element as ExcalidrawArrowElement).points;
    if (points && points.length > VALIDATION_LIMITS.MAX_POINTS_PER_ELEMENT) {
      errors.push(`Element has ${points.length} points, maximum is ${VALIDATION_LIMITS.MAX_POINTS_PER_ELEMENT}`);
    }
  }

  // Check dimensions
  if (element.width !== undefined && element.width > 100_000) {
    warnings.push(`Element width ${element.width} is unusually large`);
  }
  if (element.height !== undefined && element.height > 100_000) {
    warnings.push(`Element height ${element.height} is unusually large`);
  }

  // Check opacity
  if (element.opacity !== undefined && (element.opacity < 0 || element.opacity > 100)) {
    errors.push(`Opacity must be between 0 and 100, got ${element.opacity}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

// Validate payload size
export function validatePayloadSize(data: unknown, maxBytes: number = VALIDATION_LIMITS.MAX_PAYLOAD_SIZE_BYTES): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    const jsonStr = JSON.stringify(data);
    if (jsonStr.length > maxBytes) {
      errors.push(`Payload size ${jsonStr.length} bytes exceeds limit of ${maxBytes} bytes`);
    }
  } catch {
    errors.push('Payload is not serializable to JSON');
  }

  return { valid: errors.length === 0, errors, warnings };
}

// Validate batch operation
export function validateBatchOperation(elements: ServerElement[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (elements.length > VALIDATION_LIMITS.MAX_ELEMENTS_PER_BATCH) {
    errors.push(`Batch size ${elements.length} exceeds limit of ${VALIDATION_LIMITS.MAX_ELEMENTS_PER_BATCH}`);
  }

  // Check total size
  try {
    const totalSize = elements.reduce((sum, el) => {
      return sum + JSON.stringify(el).length;
    }, 0);
    if (totalSize > VALIDATION_LIMITS.MAX_PAYLOAD_SIZE_BYTES) {
      errors.push(`Total batch size ${totalSize} bytes exceeds limit of ${VALIDATION_LIMITS.MAX_PAYLOAD_SIZE_BYTES} bytes`);
    }
  } catch {
    errors.push('Cannot calculate batch size');
  }

  // Warn on potentially large diagrams
  if (elements.length > 5000) {
    warnings.push(`Large diagram with ${elements.length} elements may impact performance`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

// Observability metrics types
export interface SyncMetrics {
  operationType: 'create' | 'update' | 'delete' | 'replace' | 'sync';
  diagramId: string;
  sessionId?: string;
  elementCount: number;
  durationMs: number;
  success: boolean;
  error?: string;
  timestamp: string;
}

export interface PerformanceMetrics {
  diagramId: string;
  elementCount: number;
  operationType: string;
  durationMs: number;
  timestamp: string;
}

export interface HealthMetrics {
  status: 'healthy' | 'degraded' | 'unhealthy';
  websocketClients: number;
  activeSessions: number;
  elementCount: number;
  memoryUsageMb: number;
  uptimeSeconds: number;
  issues: string[];
}

// Legacy global canvas state migration types
export interface LegacyCanvasState {
  elements: ServerElement[];
  version: number;
  lastModified: string;
}

export interface MigrationResult {
  success: boolean;
  diagramsMigrated: number;
  elementsMigrated: number;
  errors: string[];
  warnings: string[];
}
