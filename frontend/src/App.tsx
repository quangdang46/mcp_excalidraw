import React, { useState, useEffect, useRef } from 'react'
import {
  Excalidraw,
  convertToExcalidrawElements,
  CaptureUpdateAction,
  ExcalidrawImperativeAPI,
  exportToBlob,
  exportToSvg
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement, NonDeleted, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/types/element/types'
import { convertMermaidToExcalidraw, DEFAULT_MERMAID_CONFIG } from './utils/mermaidConverter'
import type { MermaidConfig } from '@excalidraw/mermaid-to-excalidraw'

// Type definitions
type ExcalidrawAPIRefValue = ExcalidrawImperativeAPI;

interface ServerElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  label?: {
    text: string;
  };
  createdAt?: string;
  updatedAt?: string;
  version?: number;
  syncedAt?: string;
  source?: string;
  syncTimestamp?: string;
  boundElements?: any[] | null;
  containerId?: string | null;
  locked?: boolean;
  // Arrow element binding
  start?: { id: string };
  end?: { id: string };
  strokeStyle?: string;
  endArrowhead?: string;
  startArrowhead?: string;
  // Image element fields
  fileId?: string;
  status?: string;
  scale?: [number, number];
  angle?: number;
  link?: string | null;
}

interface WebSocketMessage {
  type: string;
  element?: ServerElement;
  elements?: ServerElement[];
  elementId?: string;
  deletedElementIds?: string[];
  count?: number;
  timestamp?: string;
  source?: string;
  mermaidDiagram?: string;
  config?: MermaidConfig;
  serverVersion?: number;
  sessionId?: string;
  diagramId?: string;
  conflicts?: boolean;
  files?: Record<string, unknown>;
}

interface ApiResponse {
  success: boolean;
  elements?: ServerElement[];
  element?: ServerElement;
  files?: Record<string, unknown>;
  count?: number;
  error?: string;
  message?: string;
  serverVersion?: number;
  sessionId?: string;
  diagramId?: string;
  applied?: boolean;
  conflicts?: boolean;
  deletedElementIds?: string[];
}

interface SceneResponse extends ApiResponse {
  elements?: ServerElement[];
  files?: Record<string, unknown>;
  serverVersion: number;
  diagramId: string;
}

interface VersionedSyncResponse extends ApiResponse {
  serverVersion: number;
  sessionId: string;
  diagramId: string;
  applied: boolean;
}

const createSessionId = (): string => `frontend-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
const DEFAULT_DIAGRAM_ID = 'default'
const AUTO_SYNC_DEBOUNCE_MS = 1200;

function withDiagramId(pathname: string, diagramId: string): string {
  const url = new URL(pathname, window.location.origin)
  url.searchParams.set('diagramId', diagramId)
  return `${url.pathname}${url.search}`
}

function withDiagramAndSession(pathname: string, diagramId: string, sessionId: string, afterVersion?: number): string {
  const url = new URL(pathname, window.location.origin)
  url.searchParams.set('diagramId', diagramId)
  url.searchParams.set('sessionId', sessionId)
  if (afterVersion !== undefined) {
    url.searchParams.set('afterVersion', String(afterVersion))
  }
  return `${url.pathname}${url.search}`
}

interface SyncContextState {
  diagramId: string;
  sessionId: string;
  serverVersion: number;
}

const INITIAL_SYNC_CONTEXT: SyncContextState = {
  diagramId: DEFAULT_DIAGRAM_ID,
  sessionId: createSessionId(),
  serverVersion: 0,
}

type SyncStatus = 'idle' | 'syncing' | 'success' | 'error'

// Helper function to clean elements for Excalidraw
const cleanElementForExcalidraw = (element: ServerElement): Partial<ExcalidrawElement> => {
  const {
    createdAt,
    updatedAt,
    version,
    syncedAt,
    source,
    syncTimestamp,
    ...cleanElement
  } = element;
  return cleanElement;
}

// Helper function to validate and fix element binding data
const validateAndFixBindings = (elements: Partial<ExcalidrawElement>[]): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map(el => [el.id!, el]));

  return elements.map(element => {
    const fixedElement = { ...element };

    // Validate and fix boundElements
    if (fixedElement.boundElements) {
      if (Array.isArray(fixedElement.boundElements)) {
        fixedElement.boundElements = fixedElement.boundElements.filter((binding: any) => {
          // Ensure binding has required properties
          if (!binding || typeof binding !== 'object') return false;
          if (!binding.id || !binding.type) return false;

          // Ensure the referenced element exists
          const referencedElement = elementMap.get(binding.id);
          if (!referencedElement) return false;

          // Validate binding type
          if (!['text', 'arrow'].includes(binding.type)) return false;

          return true;
        });

        // Remove boundElements if empty
        if (fixedElement.boundElements.length === 0) {
          fixedElement.boundElements = null;
        }
      } else {
        // Invalid boundElements format, set to null
        fixedElement.boundElements = null;
      }
    }

    // Validate and fix containerId
    if (fixedElement.containerId) {
      const containerElement = elementMap.get(fixedElement.containerId);
      if (!containerElement) {
        // Container doesn't exist, remove containerId
        fixedElement.containerId = null;
      }
    }

    return fixedElement;
  });
}

const isImageElement = (element: Partial<ExcalidrawElement>): boolean => {
  return element.type === 'image'
}

const isShapeContainerType = (type: string | undefined): boolean => {
  return type === 'rectangle' || type === 'ellipse' || type === 'diamond'
}

const recenterBoundShapeTextElements = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  const elementMap = new Map(elements.map((el) => [el.id, el]))

  return elements.map((element) => {
    if (element.type !== 'text' || !element.containerId) {
      return element
    }

    const textElement = element as ExcalidrawElement & { type: 'text'; containerId: string; autoResize?: boolean }
    const container = elementMap.get(textElement.containerId) as (ExcalidrawElement & { x: number; y: number; width: number; height: number }) | undefined
    if (!container || !isShapeContainerType(container.type)) {
      return element
    }

    if (textElement.autoResize === false) {
      return element
    }

    if (
      typeof container.x !== 'number' ||
      typeof container.y !== 'number' ||
      typeof container.width !== 'number' ||
      typeof container.height !== 'number' ||
      typeof textElement.width !== 'number' ||
      typeof textElement.height !== 'number'
    ) {
      return element
    }

    return {
      ...element,
      x: container.x + (container.width - textElement.width) / 2,
      y: container.y + (container.height - textElement.height) / 2,
    }
  })
}

const normalizeImageElement = (element: Partial<ExcalidrawElement>): Partial<ExcalidrawElement> => {
  const img = element as any
  return {
    ...img,
    angle: img.angle || 0,
    strokeColor: img.strokeColor || 'transparent',
    backgroundColor: img.backgroundColor || 'transparent',
    fillStyle: img.fillStyle || 'solid',
    strokeWidth: img.strokeWidth || 1,
    strokeStyle: img.strokeStyle || 'solid',
    roughness: img.roughness ?? 0,
    opacity: img.opacity ?? 100,
    groupIds: img.groupIds || [],
    roundness: null,
    seed: img.seed || Math.floor(Math.random() * 1000000),
    version: img.version || 1,
    versionNonce: img.versionNonce || Math.floor(Math.random() * 1000000),
    isDeleted: img.isDeleted ?? false,
    boundElements: img.boundElements || null,
    link: img.link || null,
    locked: img.locked || false,
    status: img.status || 'saved',
    fileId: img.fileId,
    scale: img.scale || [1, 1],
  }
}

// Helper: restore startBinding/endBinding/boundElements after convertToExcalidrawElements strips them
const restoreBindings = (
  convertedElements: readonly any[],
  originalElements: Partial<ExcalidrawElement>[]
): any[] => {
  const originalMap = new Map<string, any>();
  for (const el of originalElements) {
    if (el.id) originalMap.set(el.id, el);
  }

  return convertedElements.map((el: any) => {
    const orig = originalMap.get(el.id);
    if (!orig) return el;

    const patched = { ...el };

    if (orig.startBinding && !el.startBinding) {
      patched.startBinding = orig.startBinding;
    }
    if (orig.endBinding && !el.endBinding) {
      patched.endBinding = orig.endBinding;
    }
    if (orig.boundElements && (!el.boundElements || el.boundElements.length === 0)) {
      patched.boundElements = orig.boundElements;
    }
    if (orig.elbowed !== undefined && el.elbowed === undefined) {
      patched.elbowed = orig.elbowed;
    }

    return patched;
  });
};

const convertElementsPreservingImageProps = (
  elements: Partial<ExcalidrawElement>[]
): Partial<ExcalidrawElement>[] => {
  if (elements.length === 0) return []

  const validatedElements = validateAndFixBindings(elements)
  const imageElements = validatedElements.filter(isImageElement).map(normalizeImageElement)
  const nonImageElements = validatedElements.filter(el => !isImageElement(el))
  // convertToExcalidrawElements may expand labeled shapes into [shape, textElement],
  // so we cannot assume a 1:1 mapping — return all converted elements directly.
  const convertedNonImageElements = convertToExcalidrawElements(nonImageElements as any, { regenerateIds: false })
  const restoredNonImageElements = restoreBindings(convertedNonImageElements, nonImageElements)
  return recenterBoundShapeTextElements([...restoredNonImageElements, ...imageElements])
}

function App(): JSX.Element {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPIRefValue | null>(null)
  // Ref so WS message handlers (captured in stale closures) always see the latest API instance
  const excalidrawAPIRef = useRef<ExcalidrawAPIRefValue | null>(null)
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI
  }, [excalidrawAPI])
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const websocketRef = useRef<WebSocket | null>(null)
  const [syncContext, setSyncContext] = useState<SyncContextState>(INITIAL_SYNC_CONTEXT)
  const syncContextRef = useRef<SyncContextState>(INITIAL_SYNC_CONTEXT)
  useEffect(() => {
    syncContextRef.current = syncContext
  }, [syncContext])

  // Sync state management
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null)
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const catchupTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const syncInFlightRef = useRef<boolean>(false)
  const suppressAutoSyncCountRef = useRef<number>(0)
  const userInteractedRef = useRef<boolean>(false)
  const [hasRemoteConflict, setHasRemoteConflict] = useState<boolean>(false)
  const [activeDiagramName, setActiveDiagramName] = useState<string>('Untitled Diagram')
  const [activeSessionCount, setActiveSessionCount] = useState<number>(1)
  // Diagram selector state
  const [diagrams, setDiagrams] = useState<Array<{ id: string; name: string }>>([])
  const [showDiagramSelector, setShowDiagramSelector] = useState<boolean>(false)

  // Fetch diagram list
  const fetchDiagramList = async (): Promise<void> => {
    try {
      const response = await fetch('/api/diagrams')
      const result = await response.json() as { success: boolean; diagrams?: Array<{ id: string; name: string }> }
      if (result.success && result.diagrams) {
        setDiagrams(result.diagrams)
      }
    } catch (error) {
      console.error('Error fetching diagram list:', error)
    }
  }

  // Switch to a different diagram
  const switchToDiagram = async (diagramId: string): Promise<void> => {
    if (diagramId === syncContext.diagramId) {
      setShowDiagramSelector(false)
      return
    }

    // Save current scene before switching
    if (excalidrawAPI) {
      await syncToBackend({ silent: true })
    }

    // Update sync context to new diagram
    setSyncContext(prev => ({
      ...prev,
      diagramId,
      serverVersion: 0
    }))

    setShowDiagramSelector(false)

    // Reload scene for new diagram
    if (excalidrawAPI) {
      setTimeout(() => { void loadScene() }, 100)
    }

    // Refresh diagram metadata after switching
    void refreshDiagramMeta()
  }

  // Delete a diagram
  const deleteDiagram = async (diagramId: string): Promise<void> => {
    if (!confirm('Delete this diagram? This cannot be undone.')) return
    
    try {
      const response = await fetch(`/api/diagrams/${encodeURIComponent(diagramId)}`, {
        method: 'DELETE'
      })
      const result = await response.json()
      if (result.success) {
        await fetchDiagramList()
        // If we deleted the active diagram, switch to default
        if (diagramId === syncContext.diagramId) {
          await switchToDiagram('default')
        }
      }
    } catch (error) {
      console.error('Error deleting diagram:', error)
    }
  }

  // Create new diagram
  const createNewDiagram = async (): Promise<void> => {
    const name = prompt('Enter diagram name:')
    if (!name) return

    try {
      const response = await fetch('/api/diagrams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      })
      const result = await response.json()
      if (result.success && result.diagram) {
        await fetchDiagramList()
        await switchToDiagram(result.diagram.id)
      }
    } catch (error) {
      console.error('Error creating diagram:', error)
    }
  }

  const [remoteVersion, setRemoteVersion] = useState<number>(0)
  const [isBackgroundSyncing, setIsBackgroundSyncing] = useState<boolean>(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Restore modal state
  const [showRestoreModal, setShowRestoreModal] = useState<boolean>(false)
  const [backups, setBackups] = useState<Array<{ name: string; reason: string; elementCount: number; createdAt: string }>>([])
  const [selectedBackup, setSelectedBackup] = useState<{ name: string; reason: string; elementCount: number; createdAt: string } | null>(null)
  const [backupPreview, setBackupPreview] = useState<{
    name: string;
    elementCount: number;
    elementSummary: Record<string, number>;
    boundingBox: { x: number; y: number; width: number; height: number } | null;
    createdAt: string;
  } | null>(null)
  const [isLoadingBackups, setIsLoadingBackups] = useState<boolean>(false)
  const [isRestoring, setIsRestoring] = useState<boolean>(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)

  const applySceneUpdateWithoutAutoSync = (
    api: ExcalidrawImperativeAPI,
    scene: Parameters<ExcalidrawImperativeAPI['updateScene']>[0]
  ): void => {
    suppressAutoSyncCountRef.current += 1
    api.updateScene(scene)
    setTimeout(() => {
      suppressAutoSyncCountRef.current = Math.max(0, suppressAutoSyncCountRef.current - 1)
    }, 0)
  }

  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current)
      }
      if (catchupTimerRef.current) {
        clearInterval(catchupTimerRef.current)
      }
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!isConnected) {
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current)
        heartbeatTimerRef.current = null
      }
      return
    }

    const sendHeartbeat = async (): Promise<void> => {
      try {
        const context = syncContextRef.current
        const response = await fetch('/api/sessions/heartbeat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sessionId: context.sessionId,
            diagramId: context.diagramId,
          }),
        })
        const result = await response.json()
        if (result.success) {
          setActiveSessionCount(result.activeSessions ?? 1)
          if (typeof result.serverVersion === 'number') {
            setRemoteVersion(result.serverVersion)
          }
        }
      } catch (error) {
        console.error('Heartbeat failed:', error)
      }
    }

    void sendHeartbeat()
    heartbeatTimerRef.current = setInterval(() => {
      void sendHeartbeat()
    }, 10000)

    return () => {
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current)
        heartbeatTimerRef.current = null
      }
    }
  }, [isConnected])

  useEffect(() => {
    if (!isConnected) {
      if (catchupTimerRef.current) {
        clearInterval(catchupTimerRef.current)
        catchupTimerRef.current = null
      }
      return
    }

    void refreshDiagramMeta()
    void catchUpRemoteChanges()
    catchupTimerRef.current = setInterval(() => {
      void catchUpRemoteChanges()
      void refreshDiagramMeta()
    }, 5000)

    return () => {
      if (catchupTimerRef.current) {
        clearInterval(catchupTimerRef.current)
        catchupTimerRef.current = null
      }
    }
  }, [isConnected])

  useEffect(() => {
    setRemoteVersion(syncContext.serverVersion)
  }, [syncContext.serverVersion])

  useEffect(() => {
    if (syncStatus === 'success') {
      setLastError(null)
      setHasRemoteConflict(false)
    }
  }, [syncStatus])

  useEffect(() => {
    void refreshDiagramMeta()
  }, [syncContext.diagramId])

  useEffect(() => {
    const postAck = async (): Promise<void> => {
      try {
        const context = syncContextRef.current
        await fetch(withDiagramId('/api/elements/sync/ack', context.diagramId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: context.sessionId, serverVersion: context.serverVersion })
        })
      } catch (error) {
        console.error('Error acknowledging sync version:', error)
      }
    }

    if (isConnected) {
      void postAck()
    }
  }, [isConnected, syncContext.serverVersion])

  useEffect(() => {
    const onVisibilityChange = (): void => {
      if (!document.hidden) {
        void catchUpRemoteChanges()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    const onFocus = (): void => {
      void catchUpRemoteChanges()
    }

    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    void catchUpRemoteChanges()
    void refreshDiagramMeta()
  }, [syncContext.diagramId])

  useEffect(() => {
    setRemoteVersion(syncContext.serverVersion)
  }, [syncContext.serverVersion])

  useEffect(() => {
    setIsBackgroundSyncing(syncStatus === 'syncing')

    if (syncStatus === 'syncing') {
      setLastError(null)
      setHasRemoteConflict(false)
      return
    }

    if (syncStatus === 'success') {
      setLastError(null)
      setHasRemoteConflict(false)
      void refreshDiagramMeta()
      return
    }

    if (syncStatus === 'error' && !lastError) {
      setLastError('Sync failed')
    }
  }, [lastError, syncStatus])

  useEffect(() => {
    if (!lastError) {
      return
    }

    console.error(lastError)
    const timer = setTimeout(() => {
      setLastError(null)
      setSyncStatus('idle')
    }, 4000)

    return () => {
      clearTimeout(timer)
    }
  }, [lastError])

  useEffect(() => {
    if (!hasRemoteConflict) {
      return
    }

    void refreshDiagramMeta()
    const timer = setTimeout(() => {
      setHasRemoteConflict(false)
    }, 4000)

    return () => {
      clearTimeout(timer)
    }
  }, [hasRemoteConflict])

  useEffect(() => {
    if (lastSyncTime) {
      void refreshDiagramMeta()
    }
  }, [lastSyncTime])

  useEffect(() => {
    const onOnline = (): void => {
      void catchUpRemoteChanges()
      void refreshDiagramMeta()
    }

    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('online', onOnline)
    }
  }, [])

  useEffect(() => {
    if (isConnected) {
      void catchUpRemoteChanges()
      return
    }

    setIsBackgroundSyncing(false)
    setSyncStatus('idle')
    setRemoteVersion(syncContextRef.current.serverVersion)
    if (catchupTimerRef.current) {
      clearInterval(catchupTimerRef.current)
      catchupTimerRef.current = null
    }
  }, [isConnected])

  useEffect(() => {
    if (!excalidrawAPI) {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current)
        autoSyncTimerRef.current = null
      }
      return
    }

    void refreshDiagramMeta()
    void catchUpRemoteChanges()
  }, [excalidrawAPI])

  useEffect(() => {
    if (syncContext.diagramId !== DEFAULT_DIAGRAM_ID) {
      userInteractedRef.current = false
    }
  }, [syncContext.diagramId])

  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current)
      }
      if (catchupTimerRef.current) {
        clearInterval(catchupTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (activeSessionCount < 1) {
      setActiveSessionCount(1)
    }
  }, [activeSessionCount])

  useEffect(() => {
    if (!activeDiagramName.trim()) {
      setActiveDiagramName('Untitled Diagram')
    }
  }, [activeDiagramName])

  useEffect(() => {
    if (syncContext.serverVersion === 0) {
      setHasRemoteConflict(false)
    }
  }, [syncContext.serverVersion])

  useEffect(() => {
    if (isConnected && excalidrawAPI) {
      void loadScene()
    }
  }, [isConnected, excalidrawAPI])

  useEffect(() => {
    if (syncStatus === 'idle' && isConnected) {
      void refreshDiagramMeta()
    }
  }, [isConnected, syncStatus])

  useEffect(() => {
    if (lastSyncTime && isConnected && syncStatus === 'idle') {
      void catchUpRemoteChanges()
    }
  }, [isConnected, lastSyncTime, syncStatus])

  useEffect(() => {
    if (syncStatus === 'idle' && syncContext.serverVersion > 0 && !lastSyncTime) {
      setLastSyncTime(new Date())
    }
  }, [lastSyncTime, syncContext.serverVersion, syncStatus])

  useEffect(() => {
    if (syncStatus === 'success' && activeSessionCount > 1) {
      void refreshDiagramMeta()
    }
  }, [activeSessionCount, syncStatus])

  useEffect(() => {
    if (syncStatus === 'idle' && syncContext.sessionId) {
      setLastError(null)
      void refreshDiagramMeta()
    }
  }, [syncContext.sessionId, syncStatus])

  useEffect(() => {
    if (syncContext.diagramId && syncStatus === 'idle') {
      setHasRemoteConflict(false)
    }
  }, [syncContext.diagramId, syncStatus])

  useEffect(() => {
    if (activeDiagramName === 'Untitled Diagram' && syncStatus === 'idle') {
      void refreshDiagramMeta()
    }
  }, [activeDiagramName, syncStatus])

  useEffect(() => {
    if (syncStatus === 'success' && lastSyncTime) {
      setRemoteVersion(syncContextRef.current.serverVersion)
    }
  }, [lastSyncTime, syncStatus])

  useEffect(() => {
    if (remoteVersion > syncContext.serverVersion && isConnected && !syncInFlightRef.current) {
      void catchUpRemoteChanges()
    }
  }, [isConnected, remoteVersion, syncContext.serverVersion])

  useEffect(() => {
    if (syncStatus === 'idle' && excalidrawAPI) {
      void refreshDiagramMeta()
    }
  }, [excalidrawAPI, syncStatus])

  useEffect(() => {
    if (isConnected && syncStatus === 'idle' && excalidrawAPI) {
      void catchUpRemoteChanges()
    }
  }, [excalidrawAPI, isConnected, syncStatus])

  useEffect(() => {
    if (activeSessionCount === 1 && hasRemoteConflict) {
      setHasRemoteConflict(false)
    }
  }, [activeSessionCount, hasRemoteConflict])

  useEffect(() => {
    if (syncStatus === 'idle' && !isConnected) {
      setIsBackgroundSyncing(false)
    }
  }, [isConnected, syncStatus])

  useEffect(() => {
    if (lastError) {
      setIsBackgroundSyncing(false)
    }
  }, [lastError])

  useEffect(() => {
    if (syncStatus === 'success' && !isConnected) {
      setSyncStatus('idle')
    }
  }, [isConnected, syncStatus])

  useEffect(() => {
    if (syncStatus === 'error' && !isConnected) {
      setSyncStatus('idle')
    }
  }, [isConnected, syncStatus])

  useEffect(() => {
    if (syncContext.diagramId === DEFAULT_DIAGRAM_ID) {
      void refreshDiagramMeta()
    }
  }, [syncContext.diagramId])

  useEffect(() => {
    if (syncContext.diagramId && excalidrawAPI) {
      void refreshDiagramMeta()
    }
  }, [excalidrawAPI, syncContext.diagramId])

  useEffect(() => {
    if (lastSyncTime && syncStatus === 'idle') {
      void refreshDiagramMeta()
    }
  }, [lastSyncTime, syncStatus])

  useEffect(() => {
    if (remoteVersion === 0 && syncContext.serverVersion > 0) {
      setRemoteVersion(syncContext.serverVersion)
    }
  }, [remoteVersion, syncContext.serverVersion])

  useEffect(() => {
    if (lastError && syncStatus !== 'error') {
      setSyncStatus('error')
    }
  }, [lastError, syncStatus])

  useEffect(() => {
    if (syncStatus === 'idle' && !lastError) {
      setIsBackgroundSyncing(false)
    }
  }, [lastError, syncStatus])

  useEffect(() => {
    if (syncStatus === 'success') {
      setLastError(null)
    }
  }, [syncStatus])

  useEffect(() => {
    if (remoteVersion < syncContext.serverVersion) {
      setRemoteVersion(syncContext.serverVersion)
    }
  }, [remoteVersion, syncContext.serverVersion])

  useEffect(() => {
    if (!hasRemoteConflict && syncStatus === 'idle') {
      void refreshDiagramMeta()
    }
  }, [hasRemoteConflict, syncStatus])

  useEffect(() => {
    if (!isConnected && syncStatus === 'syncing') {
      setSyncStatus('idle')
    }
  }, [isConnected, syncStatus])

  useEffect(() => {
    if (syncStatus === 'idle' && syncContext.serverVersion > 0) {
      setRemoteVersion(syncContext.serverVersion)
    }
  }, [syncContext.serverVersion, syncStatus])

  useEffect(() => {
    if (lastError && !isConnected) {
      setLastError(null)
    }
  }, [isConnected, lastError])

  useEffect(() => {
    if (syncStatus === 'syncing') {
      setLastError(null)
    }
  }, [syncStatus])

  useEffect(() => {
    if (syncContext.sessionId) {
      void refreshDiagramMeta()
    }
  }, [syncContext.sessionId])

  useEffect(() => {
    if (lastSyncTime) {
      setRemoteVersion(syncContextRef.current.serverVersion)
    }
  }, [lastSyncTime])

  useEffect(() => {
    if (!excalidrawAPI) {
      return
    }

    void catchUpRemoteChanges()
  }, [excalidrawAPI, syncContext.diagramId])

  useEffect(() => {
    if (syncStatus === 'syncing') {
      setHasRemoteConflict(false)
    }
  }, [syncStatus])

  useEffect(() => {
    if (activeSessionCount > 1) {
      setHasRemoteConflict((current) => current)
    }
  }, [activeSessionCount])

  useEffect(() => {
    if (lastSyncTime && isConnected) {
      void catchUpRemoteChanges()
    }
  }, [isConnected, lastSyncTime])

  useEffect(() => {
    if (remoteVersion > syncContext.serverVersion && !syncInFlightRef.current) {
      void catchUpRemoteChanges()
    }
  }, [remoteVersion, syncContext.serverVersion])

  useEffect(() => {
    if (syncStatus === 'idle' && syncContext.diagramId) {
      setHasRemoteConflict(false)
    }
  }, [syncContext.diagramId, syncStatus])

  useEffect(() => {
    if (!lastError) {
      return
    }

    const timer = setTimeout(() => {
      setLastError(null)
    }, 6000)

    return () => {
      clearTimeout(timer)
    }
  }, [lastError])

  useEffect(() => {
    if (!isConnected) {
      setIsBackgroundSyncing(false)
    }
  }, [isConnected])

  useEffect(() => {
    if (!hasRemoteConflict) {
      return
    }

    const timer = setTimeout(() => {
      setHasRemoteConflict(false)
    }, 4000)

    return () => {
      clearTimeout(timer)
    }
  }, [hasRemoteConflict])

  useEffect(() => {
    if (!lastError) {
      return
    }

    console.error(lastError)
  }, [lastError])

  useEffect(() => {
    if (syncStatus === 'success') {
      void refreshDiagramMeta()
    }
  }, [syncStatus])

  useEffect(() => {
    if (syncContext.serverVersion > remoteVersion) {
      setRemoteVersion(syncContext.serverVersion)
    }
  }, [remoteVersion, syncContext.serverVersion])

  useEffect(() => {
    if (!isBackgroundSyncing && syncStatus === 'idle') {
      setLastError(null)
    }
  }, [isBackgroundSyncing, syncStatus])

  useEffect(() => {
    if (syncContext.diagramId !== DEFAULT_DIAGRAM_ID) {
      userInteractedRef.current = false
    }
  }, [syncContext.diagramId])

  useEffect(() => {
    if (excalidrawAPI) {
      void refreshDiagramMeta()
    }
  }, [excalidrawAPI])

  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current)
      }
      if (catchupTimerRef.current) {
        clearInterval(catchupTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const onOnline = (): void => {
      void catchUpRemoteChanges()
      void refreshDiagramMeta()
    }

    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('online', onOnline)
    }
  }, [])

  useEffect(() => {
    if (syncContext.serverVersion === 0) {
      setHasRemoteConflict(false)
    }
  }, [syncContext.serverVersion])

  useEffect(() => {
    if (isConnected && excalidrawAPI) {
      void loadScene()
    }
  }, [isConnected, excalidrawAPI])

  useEffect(() => {
    if (isConnected) {
      void catchUpRemoteChanges()
    }
  }, [isConnected])

  useEffect(() => {
    if (syncStatus !== 'error') {
      return
    }

    const timer = setTimeout(() => {
      setSyncStatus('idle')
    }, 4000)

    return () => {
      clearTimeout(timer)
    }
  }, [syncStatus])

  useEffect(() => {
    void refreshDiagramMeta()
  }, [lastSyncTime])

  useEffect(() => {
    setRemoteVersion(syncContext.serverVersion)
  }, [syncContext.serverVersion])

  // WebSocket connection

  useEffect(() => {
    if (!isConnected && catchupTimerRef.current) {
      clearInterval(catchupTimerRef.current)
      catchupTimerRef.current = null
    }
  }, [isConnected])

  useEffect(() => {
    if (!excalidrawAPI && autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
      autoSyncTimerRef.current = null
    }
  }, [excalidrawAPI])

  useEffect(() => {
    if (remoteVersion > syncContext.serverVersion && isConnected && !syncInFlightRef.current) {
      void catchUpRemoteChanges()
    }
  }, [isConnected, remoteVersion, syncContext.serverVersion])

  useEffect(() => {
    if (activeSessionCount === 1 && hasRemoteConflict) {
      setHasRemoteConflict(false)
    }
  }, [activeSessionCount, hasRemoteConflict])

  useEffect(() => {
    if (syncStatus === 'idle' && isConnected) {
      void refreshDiagramMeta()
    }
  }, [isConnected, syncStatus])

  useEffect(() => {
    if (lastSyncTime && isConnected && syncStatus === 'idle') {
      void catchUpRemoteChanges()
    }
  }, [isConnected, lastSyncTime, syncStatus])

  useEffect(() => {
    if (syncStatus === 'idle' && syncContext.serverVersion > 0 && !lastSyncTime) {
      setLastSyncTime(new Date())
    }
  }, [lastSyncTime, syncContext.serverVersion, syncStatus])

  useEffect(() => {
    if (syncStatus === 'idle' && syncContext.sessionId) {
      setLastError(null)
    }
  }, [syncContext.sessionId, syncStatus])

  useEffect(() => {
    if (syncStatus === 'success' && activeSessionCount > 1) {
      void refreshDiagramMeta()
    }
  }, [activeSessionCount, syncStatus])

  useEffect(() => {
    if (hasRemoteConflict && lastError) {
      setLastError(null)
    }
  }, [hasRemoteConflict, lastError])

  useEffect(() => {
    if (activeDiagramName === 'Untitled Diagram' && syncStatus === 'idle') {
      void refreshDiagramMeta()
    }
  }, [activeDiagramName, syncStatus])

  useEffect(() => {
    if (syncStatus === 'success' && !isConnected) {
      setSyncStatus('idle')
    }
  }, [isConnected, syncStatus])

  useEffect(() => {
    if (syncStatus === 'syncing') {
      setIsBackgroundSyncing(true)
    }
  }, [syncStatus])

  useEffect(() => {
    if (syncStatus === 'idle' && syncContext.sessionId) {
      void refreshDiagramMeta()
    }
  }, [syncContext.sessionId, syncStatus])

  useEffect(() => {
    if (!isConnected && remoteVersion !== syncContextRef.current.serverVersion) {
      setRemoteVersion(syncContextRef.current.serverVersion)
    }
  }, [isConnected, remoteVersion])

  useEffect(() => {
    if (syncStatus === 'idle' && isConnected && lastSyncTime) {
      void catchUpRemoteChanges()
    }
  }, [isConnected, lastSyncTime, syncStatus])

  useEffect(() => {
    if (syncStatus === 'idle' && excalidrawAPI) {
      void refreshDiagramMeta()
    }
  }, [excalidrawAPI, syncStatus])

  useEffect(() => {
    if (syncContext.diagramId && excalidrawAPI) {
      void refreshDiagramMeta()
    }
  }, [excalidrawAPI, syncContext.diagramId])

  useEffect(() => {
    if (isConnected && syncStatus === 'idle' && excalidrawAPI) {
      void catchUpRemoteChanges()
    }
  }, [excalidrawAPI, isConnected, syncStatus])

  useEffect(() => {
    if (lastSyncTime && syncStatus === 'idle') {
      void refreshDiagramMeta()
    }
  }, [lastSyncTime, syncStatus])

  useEffect(() => {
    if (syncStatus === 'idle' && !isConnected) {
      setIsBackgroundSyncing(false)
    }
  }, [isConnected, syncStatus])

  useEffect(() => {
    if (syncStatus === 'success') {
      setHasRemoteConflict(false)
    }
  }, [syncStatus])

  useEffect(() => {
    if (remoteVersion === 0 && syncContext.serverVersion > 0) {
      setRemoteVersion(syncContext.serverVersion)
    }
  }, [remoteVersion, syncContext.serverVersion])

  useEffect(() => {
    if (lastError && syncStatus !== 'error') {
      setSyncStatus('error')
    }
  }, [lastError, syncStatus])

  useEffect(() => {
    if (syncStatus === 'idle' && !lastError) {
      setIsBackgroundSyncing(false)
    }
  }, [lastError, syncStatus])

  useEffect(() => {
    if (activeSessionCount === 1 && syncStatus === 'idle') {
      void refreshDiagramMeta()
    }
  }, [activeSessionCount, syncStatus])

  useEffect(() => {
    if (syncStatus === 'error' && !isConnected) {
      setSyncStatus('idle')
    }
  }, [isConnected, syncStatus])

  useEffect(() => {
    if (syncContext.diagramId === DEFAULT_DIAGRAM_ID) {
      void refreshDiagramMeta()
    }
  }, [syncContext.diagramId])

  useEffect(() => {
    if (syncStatus === 'success') {
      setLastError(null)
    }
  }, [syncStatus])

  useEffect(() => {
    if (remoteVersion < syncContext.serverVersion) {
      setRemoteVersion(syncContext.serverVersion)
    }
  }, [remoteVersion, syncContext.serverVersion])

  useEffect(() => {
    if (!hasRemoteConflict && syncStatus === 'idle') {
      void refreshDiagramMeta()
    }
  }, [hasRemoteConflict, syncStatus])

  useEffect(() => {
    if (!hasRemoteConflict) {
      return
    }

    void refreshDiagramMeta()
  }, [hasRemoteConflict])

  useEffect(() => {
    if (syncStatus === 'idle' && hasRemoteConflict) {
      setHasRemoteConflict(false)
    }
  }, [hasRemoteConflict, syncStatus])

  useEffect(() => {
    if (!activeDiagramName) {
      setActiveDiagramName('Untitled Diagram')
    }
  }, [activeDiagramName])

  useEffect(() => {
    if (!isConnected) {
      setActiveSessionCount((count) => Math.max(1, count))
    }
  }, [isConnected])

  useEffect(() => {
    if (syncStatus === 'error') {
      setIsBackgroundSyncing(false)
    }
  }, [syncStatus])

  useEffect(() => {
    if (syncStatus === 'success' && hasRemoteConflict) {
      setHasRemoteConflict(false)
    }
  }, [hasRemoteConflict, syncStatus])

  useEffect(() => {
    if (!isConnected && syncStatus === 'syncing') {
      setSyncStatus('idle')
    }
  }, [isConnected, syncStatus])

  useEffect(() => {
    if (syncStatus === 'idle' && syncContext.serverVersion > 0) {
      setRemoteVersion(syncContext.serverVersion)
    }
  }, [syncContext.serverVersion, syncStatus])

  useEffect(() => {
    if (lastError && !isConnected) {
      setLastError(null)
    }
  }, [isConnected, lastError])

  useEffect(() => {
    if (syncStatus === 'syncing') {
      setLastError(null)
    }
  }, [syncStatus])

  useEffect(() => {
    if (isConnected && remoteVersion > syncContext.serverVersion) {
      void catchUpRemoteChanges()
    }
  }, [isConnected, remoteVersion, syncContext.serverVersion])

  useEffect(() => {
    if (syncContext.sessionId) {
      void refreshDiagramMeta()
    }
  }, [syncContext.sessionId])

  useEffect(() => {
    if (lastSyncTime) {
      setRemoteVersion(syncContextRef.current.serverVersion)
    }
  }, [lastSyncTime])

  useEffect(() => {
    if (!excalidrawAPI) {
      return
    }

    void catchUpRemoteChanges()
  }, [excalidrawAPI, syncContext.diagramId])

  useEffect(() => {
    if (!isConnected) {
      setSyncStatus('idle')
    }
  }, [isConnected])

  useEffect(() => {
    if (syncStatus === 'syncing') {
      setHasRemoteConflict(false)
    }
  }, [syncStatus])

  useEffect(() => {
    if (lastError) {
      setIsBackgroundSyncing(false)
    }
  }, [lastError])

  useEffect(() => {
    if (syncStatus === 'success') {
      setLastError(null)
    }
  }, [syncStatus])

  useEffect(() => {
    if (activeSessionCount > 1) {
      setHasRemoteConflict((current) => current)
    }
  }, [activeSessionCount])

  useEffect(() => {
    if (lastSyncTime && isConnected) {
      void catchUpRemoteChanges()
    }
  }, [isConnected, lastSyncTime])

  useEffect(() => {
    if (syncStatus === 'idle' && isConnected) {
      void refreshDiagramMeta()
    }
  }, [isConnected, syncStatus])

  useEffect(() => {
    if (remoteVersion > syncContext.serverVersion && !syncInFlightRef.current) {
      void catchUpRemoteChanges()
    }
  }, [remoteVersion, syncContext.serverVersion])

  useEffect(() => {
    if (syncStatus === 'error' && !lastError) {
      setLastError('Sync failed')
    }
  }, [lastError, syncStatus])

  useEffect(() => {
    if (syncStatus === 'idle' && syncContext.diagramId) {
      setHasRemoteConflict(false)
    }
  }, [syncContext.diagramId, syncStatus])

  useEffect(() => {
    if (!lastError) {
      return
    }

    const timer = setTimeout(() => {
      setLastError(null)
    }, 6000)

    return () => {
      clearTimeout(timer)
    }
  }, [lastError])

  useEffect(() => {
    if (!activeDiagramName.trim()) {
      setActiveDiagramName('Untitled Diagram')
    }
  }, [activeDiagramName])

  useEffect(() => {
    if (activeSessionCount < 1) {
      setActiveSessionCount(1)
    }
  }, [activeSessionCount])

  useEffect(() => {
    if (!isConnected) {
      setIsBackgroundSyncing(false)
    }
  }, [isConnected])

  useEffect(() => {
    if (!hasRemoteConflict) {
      return
    }

    const timer = setTimeout(() => {
      setHasRemoteConflict(false)
    }, 4000)

    return () => {
      clearTimeout(timer)
    }
  }, [hasRemoteConflict])

  useEffect(() => {
    if (!lastError) {
      return
    }

    console.error(lastError)
  }, [lastError])

  useEffect(() => {
    if (syncStatus === 'success') {
      void refreshDiagramMeta()
    }
  }, [syncStatus])

  useEffect(() => {
    if (syncContext.serverVersion > remoteVersion) {
      setRemoteVersion(syncContext.serverVersion)
    }
  }, [remoteVersion, syncContext.serverVersion])

  useEffect(() => {
    if (!isBackgroundSyncing && syncStatus === 'idle') {
      setLastError(null)
    }
  }, [isBackgroundSyncing, syncStatus])

  useEffect(() => {
    if (syncContext.diagramId !== DEFAULT_DIAGRAM_ID) {
      userInteractedRef.current = false
    }
  }, [syncContext.diagramId])

  useEffect(() => {
    if (excalidrawAPI) {
      void refreshDiagramMeta()
    }
  }, [excalidrawAPI])

  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current)
      }
      if (catchupTimerRef.current) {
        clearInterval(catchupTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const onOnline = (): void => {
      void catchUpRemoteChanges()
      void refreshDiagramMeta()
    }

    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('online', onOnline)
    }
  }, [])

  useEffect(() => {
    if (syncContext.serverVersion === 0) {
      setHasRemoteConflict(false)
    }
  }, [syncContext.serverVersion])

  useEffect(() => {
    if (isConnected && excalidrawAPI) {
      void loadScene()
    }
  }, [isConnected, excalidrawAPI])

  useEffect(() => {
    if (isConnected) {
      void catchUpRemoteChanges()
    }
  }, [isConnected])

  useEffect(() => {
    if (syncStatus !== 'error') {
      return
    }

    const timer = setTimeout(() => {
      setSyncStatus('idle')
    }, 4000)

    return () => {
      clearTimeout(timer)
    }
  }, [syncStatus])

  useEffect(() => {
    void refreshDiagramMeta()
  }, [lastSyncTime])

  useEffect(() => {
    setRemoteVersion(syncContext.serverVersion)
  }, [syncContext.serverVersion])

  // WebSocket connection
  useEffect(() => {
    connectWebSocket()
    return () => {
      if (websocketRef.current) {
        websocketRef.current.close()
      }
    }
  }, [])

  // Load current scene when Excalidraw API becomes available
  useEffect(() => {
    if (excalidrawAPI) {
      void loadScene()

      if (!isConnected) {
        connectWebSocket()
      }
    }
  }, [excalidrawAPI, isConnected])

  // Fetch diagram list on connect
  useEffect(() => {
    if (isConnected) {
      void fetchDiagramList()
    }
  }, [isConnected])

  const loadScene = async (): Promise<void> => {
    try {
      const context = syncContextRef.current
      const response = await fetch(withDiagramId('/api/scene', context.diagramId))
      const result = await response.json() as SceneResponse

      if (result.success) {
        setSyncContext((prev) => ({
          diagramId: result.diagramId || prev.diagramId,
          sessionId: result.sessionId || prev.sessionId,
          serverVersion: result.serverVersion ?? prev.serverVersion,
        }))

        const cleanedElements = (result.elements || []).map(cleanElementForExcalidraw)
        const convertedElements = convertElementsPreservingImageProps(cleanedElements)
        if (excalidrawAPI) {
          applySceneUpdateWithoutAutoSync(excalidrawAPI, {
            elements: convertedElements,
            captureUpdate: CaptureUpdateAction.NEVER
          })
        }

        if (result.files) {
          excalidrawAPI?.addFiles(Object.values(result.files))
        }

        // Refresh diagram name after loading scene
        if (result.diagramId && result.diagramId !== context.diagramId) {
          // Diagram changed, refresh metadata
          void refreshDiagramMeta()
        }
      }
    } catch (error) {
      console.error('Error loading scene:', error)
    }
  }

  const refreshDiagramMeta = async (): Promise<void> => {
    try {
      const context = syncContextRef.current
      const [diagramResponse, sessionsResponse] = await Promise.all([
        fetch(`/api/diagrams/${context.diagramId}`),
        fetch(`/api/diagrams/${context.diagramId}/sessions`)
      ])

      if (diagramResponse.ok) {
        const diagramResult = await diagramResponse.json() as { diagram?: { name?: string } }
        if (diagramResult.diagram?.name) {
          setActiveDiagramName(diagramResult.diagram.name)
        }
      }

      if (sessionsResponse.ok) {
        const sessionsResult = await sessionsResponse.json() as { sessions?: Array<{ status?: string }> }
        const activeSessions = (sessionsResult.sessions || []).filter(session => session.status !== 'closed').length
        setActiveSessionCount(Math.max(1, activeSessions))
      }
    } catch (error) {
      console.error('Error refreshing diagram metadata:', error)
    }
  }

  const catchUpRemoteChanges = async (): Promise<void> => {
    if (!excalidrawAPIRef.current || syncInFlightRef.current) {
      return
    }

    try {
      const context = syncContextRef.current
      const response = await fetch(withDiagramAndSession('/api/elements/sync/state', context.diagramId, context.sessionId, context.serverVersion))
      if (!response.ok) return
      const result = await response.json() as ApiResponse
      const nextVersion = result.serverVersion ?? context.serverVersion
      setRemoteVersion(nextVersion)

      const hasElementChanges = Array.isArray(result.elements) && result.elements.length > 0
      const hasDeletions = Array.isArray(result.deletedElementIds) && result.deletedElementIds.length > 0
      if (!hasElementChanges && !hasDeletions) {
        if (nextVersion !== context.serverVersion) {
          setSyncContext(prev => ({ ...prev, serverVersion: nextVersion }))
        }
        return
      }

      const api = excalidrawAPIRef.current
      if (!api) return

      const currentElements = api.getSceneElements()
      const deletedIds = new Set(result.deletedElementIds || [])
      const survivingElements = currentElements.filter(element => !deletedIds.has(element.id))
      const cleanedIncoming = (result.elements || []).map(cleanElementForExcalidraw)
      const incomingById = new Map<string, Partial<ExcalidrawElement>>()
      cleanedIncoming.forEach((element) => {
        if (element.id) incomingById.set(element.id, element)
      })

      const mergedElements: Partial<ExcalidrawElement>[] = survivingElements.map((element) => {
        const incoming = incomingById.get(element.id)
        if (!incoming) return element
        incomingById.delete(element.id)
        return { ...element, ...incoming }
      })
      mergedElements.push(...incomingById.values())

      const convertedElements = convertElementsPreservingImageProps(mergedElements)
      applySceneUpdateWithoutAutoSync(api, {
        elements: convertedElements,
        captureUpdate: CaptureUpdateAction.NEVER
      })

      setSyncContext(prev => ({ ...prev, serverVersion: nextVersion }))
      setHasRemoteConflict(true)
      setLastSyncTime(new Date())
    } catch (error) {
      console.error('Error catching up remote changes:', error)
    }
  }

  const connectWebSocket = (): void => {
    if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const context = syncContextRef.current
    const wsUrl = `${protocol}//${window.location.host}?diagramId=${encodeURIComponent(context.diagramId)}&sessionId=${encodeURIComponent(context.sessionId)}`

    websocketRef.current = new WebSocket(wsUrl)

    websocketRef.current.onopen = () => {
      setIsConnected(true)

      if (excalidrawAPI) {
        setTimeout(() => { void loadScene() }, 100)
      }
    }

    websocketRef.current.onmessage = (event: MessageEvent) => {
      try {
        const data: WebSocketMessage = JSON.parse(event.data)
        handleWebSocketMessage(data)
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, event.data)
      }
    }

    websocketRef.current.onclose = (event: CloseEvent) => {
      setIsConnected(false)

      // Reconnect after 3 seconds if not a clean close
      if (event.code !== 1000) {
        setTimeout(connectWebSocket, 3000)
      }
    }

    websocketRef.current.onerror = (error: Event) => {
      console.error('WebSocket error:', error)
      setIsConnected(false)
    }
  }

  const handleWebSocketMessage = async (data: WebSocketMessage): Promise<void> => {
    const excalidrawAPI = excalidrawAPIRef.current
    if (!excalidrawAPI) {
      return
    }

    try {
      const currentElements = excalidrawAPI.getSceneElements()
      const mergeAndApplySceneElements = (incomingElements: Partial<ExcalidrawElement>[]): void => {
        if (incomingElements.length === 0) return

        const incomingById = new Map<string, Partial<ExcalidrawElement>>()
        incomingElements.forEach((element) => {
          if (element.id) {
            incomingById.set(element.id, element)
          }
        })

        const mergedElements: Partial<ExcalidrawElement>[] = currentElements.map((element) => {
          const incoming = incomingById.get(element.id)
          if (!incoming) return element
          incomingById.delete(element.id)
          return { ...element, ...incoming }
        })

        mergedElements.push(...incomingById.values())

        const convertedElements = convertElementsPreservingImageProps(mergedElements)
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: convertedElements,
          captureUpdate: CaptureUpdateAction.NEVER
        })
      }

      switch (data.type) {
        case 'initial_elements':
          if (data.elements && data.elements.length > 0) {
            const cleanedElements = data.elements.map(cleanElementForExcalidraw)
            const convertedElements = convertElementsPreservingImageProps(cleanedElements)
            applySceneUpdateWithoutAutoSync(excalidrawAPI, {
              elements: convertedElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          // Load files for image elements
          if ((data as any).files) {
            excalidrawAPI.addFiles(Object.values((data as any).files))
          }
          break

        case 'files_added':
          if (Array.isArray((data as any).files)) {
            excalidrawAPI.addFiles((data as any).files)
          }
          break

        case 'element_created':
          if (data.element) {
            const cleanedNewElement = cleanElementForExcalidraw(data.element)
            // Rebuild against full scene so text/container bindings remain intact.
            mergeAndApplySceneElements([cleanedNewElement])
          }
          break

        case 'element_updated':
          if (data.element) {
            const cleanedUpdatedElement = cleanElementForExcalidraw(data.element)
            // Convert with full scene context so text metrics/container placement can refresh.
            mergeAndApplySceneElements([cleanedUpdatedElement])
          }
          break

        case 'element_deleted':
          if (data.elementId) {
            const filteredElements = currentElements.filter(el => el.id !== data.elementId)
            applySceneUpdateWithoutAutoSync(excalidrawAPI, {
              elements: filteredElements,
              captureUpdate: CaptureUpdateAction.NEVER
            })
          }
          break

        case 'elements_batch_created':
          if (data.elements) {
            const cleanedBatchElements = data.elements.map(cleanElementForExcalidraw)
            mergeAndApplySceneElements(cleanedBatchElements)
          }
          break

        case 'elements_synced':
          console.log(`Sync confirmed by server: ${data.count} elements`)
          // Sync confirmation already handled by HTTP response
          break

        case 'sync_status':
          console.log(`Server sync status: ${data.count} elements`)
          break

        case 'canvas_cleared':
          console.log('Canvas cleared by server')
          applySceneUpdateWithoutAutoSync(excalidrawAPI, {
            elements: [],
            captureUpdate: CaptureUpdateAction.NEVER
          })
          break

        case 'export_image_request':
          if (data.requestId) {
            try {
              const elements = excalidrawAPI.getSceneElements()
              const appState = excalidrawAPI.getAppState()
              const files = excalidrawAPI.getFiles()

              if (data.format === 'svg') {
                const svg = await exportToSvg({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files
                })
                const svgString = new XMLSerializer().serializeToString(svg)
                await fetch('/api/export/image/result', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    requestId: data.requestId,
                    format: 'svg',
                    data: svgString
                  })
                })
              } else {
                const blob = await exportToBlob({
                  elements,
                  appState: {
                    ...appState,
                    exportBackground: data.background !== false
                  },
                  files,
                  mimeType: 'image/png'
                })
                const reader = new FileReader()
                reader.onload = async () => {
                  try {
                    const resultString = reader.result as string
                    const base64 = resultString?.split(',')[1]
                    if (!base64) {
                      throw new Error('Could not extract base64 data from result')
                    }
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        format: 'png',
                        data: base64
                      })
                    })
                  } catch (readerError) {
                    console.error('Image export (FileReader) failed:', readerError)
                    await fetch('/api/export/image/result', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        requestId: data.requestId,
                        error: (readerError as Error).message
                      })
                    }).catch(() => { })
                  }
                }
                reader.onerror = async () => {
                  console.error('FileReader error:', reader.error)
                  await fetch('/api/export/image/result', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      requestId: data.requestId,
                      error: reader.error?.message || 'FileReader failed'
                    })
                  }).catch(() => { })
                }
                reader.readAsDataURL(blob)
              }
            } catch (exportError) {
              console.error('Image export failed:', exportError)
              await fetch('/api/export/image/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (exportError as Error).message
                })
              })
            }
          }
          break

        case 'set_viewport':
          console.log('Received viewport control request', data)
          if (data.requestId) {
            try {
              if (data.scrollToContent) {
                const allElements = excalidrawAPI.getSceneElements()
                if (allElements.length > 0) {
                  excalidrawAPI.scrollToContent(allElements, { fitToViewport: true, animate: true })
                }
              } else if (data.scrollToElementId) {
                const allElements = excalidrawAPI.getSceneElements()
                const targetElement = allElements.find(el => el.id === data.scrollToElementId)
                if (targetElement) {
                  excalidrawAPI.scrollToContent([targetElement], { fitToViewport: false, animate: true })
                } else {
                  throw new Error(`Element ${data.scrollToElementId} not found`)
                }
              } else {
                // Direct zoom/scroll control
                const appState: any = {}
                if (data.zoom !== undefined) {
                  appState.zoom = { value: data.zoom }
                }
                if (data.offsetX !== undefined) {
                  appState.scrollX = data.offsetX
                }
                if (data.offsetY !== undefined) {
                  appState.scrollY = data.offsetY
                }
                if (Object.keys(appState).length > 0) {
                  applySceneUpdateWithoutAutoSync(excalidrawAPI, { appState })
                }
              }

              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  success: true,
                  message: 'Viewport updated'
                })
              })
            } catch (viewportError) {
              console.error('Viewport control failed:', viewportError)
              await fetch('/api/viewport/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  requestId: data.requestId,
                  error: (viewportError as Error).message
                })
              }).catch(() => { })
            }
          }
          break

        case 'mermaid_convert':
          console.log('Received Mermaid conversion request from MCP')
          if (data.mermaidDiagram) {
            try {
              const result = await convertMermaidToExcalidraw(data.mermaidDiagram, data.config || DEFAULT_MERMAID_CONFIG)

              if (result.error) {
                console.error('Mermaid conversion error:', result.error)
                return
              }

              if (result.elements && result.elements.length > 0) {
                const convertedElements = convertToExcalidrawElements(result.elements, { regenerateIds: false })
                applySceneUpdateWithoutAutoSync(excalidrawAPI, {
                  elements: convertedElements,
                  captureUpdate: CaptureUpdateAction.IMMEDIATELY
                })

                if (result.files) {
                  excalidrawAPI.addFiles(Object.values(result.files))
                }

                console.log('Mermaid diagram converted successfully:', result.elements.length, 'elements')

                // Sync to backend automatically after creating elements
                await syncToBackend()
              }
            } catch (error) {
              console.error('Error converting Mermaid diagram from WebSocket:', error)
            }
          }
          break

        case 'diagram_updated':
          // MCP server created/updated a diagram, refresh the diagram list and metadata
          console.log('Diagram updated via MCP:', data.diagramName, 'diagramId:', data.diagramId)
          void fetchDiagramList()
          void refreshDiagramMeta()
          // Force re-render by switching active diagram if current is different
          if (data.diagramId && data.diagramId !== syncContext.diagramId) {
            console.log('Switching to diagram:', data.diagramId)
            void switchToDiagram(data.diagramId)
          }
          break

        default:
          console.log('Unknown WebSocket message type:', data.type)
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error, data)
    }
  }

  // Data format conversion for backend
  const convertToBackendFormat = (element: ExcalidrawElement): ServerElement => {
    return {
      ...element
    } as ServerElement
  }

  // Format sync time display
  const formatSyncTime = (time: Date | null): string => {
    if (!time) return ''
    return time.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  // Main sync function
  const syncToBackend = async (options: { silent?: boolean } = {}): Promise<void> => {
    const { silent = false } = options

    if (!excalidrawAPI) {
      console.warn('Excalidraw API not available')
      return
    }

    if (syncInFlightRef.current) {
      return
    }

    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
      autoSyncTimerRef.current = null
    }

    syncInFlightRef.current = true
    if (!silent) {
      setSyncStatus('syncing')
    }

    try {
      const context = syncContextRef.current
      const currentElements = excalidrawAPI.getSceneElements()
      const activeElements = currentElements.filter(el => !el.isDeleted)
      const backendElements = activeElements.map(convertToBackendFormat)

      const response = await fetch(withDiagramId('/api/elements/sync', context.diagramId), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: context.sessionId,
          baseVersion: context.serverVersion,
          elements: backendElements,
          timestamp: new Date().toISOString()
        })
      })

      if (response.ok) {
        const result = await response.json() as VersionedSyncResponse
        setLastSyncTime(new Date())
        setSyncContext((prev) => ({
          diagramId: result.diagramId || prev.diagramId,
          sessionId: result.sessionId || prev.sessionId,
          serverVersion: result.serverVersion ?? prev.serverVersion,
        }))

        if (result.conflicts) {
          console.warn('Sync completed with version drift; local scene replaced server state')
        }

        if (!silent) {
          setSyncStatus('success')
          setTimeout(() => setSyncStatus('idle'), 2000)
        }
      } else {
        const error = await response.json() as ApiResponse
        console.error('Sync failed:', error.error)
        if (!silent) {
          setSyncStatus('error')
        }
      }
    } catch (error) {
      console.error('Sync error:', error)
      if (!silent) {
        setSyncStatus('error')
      }
    } finally {
      syncInFlightRef.current = false
    }
  }

  const scheduleAutoSync = (): void => {
    if (!isConnected || !excalidrawAPI) {
      return
    }
    if (!userInteractedRef.current) {
      return
    }
    if (suppressAutoSyncCountRef.current > 0) {
      return
    }
    if (autoSyncTimerRef.current) {
      clearTimeout(autoSyncTimerRef.current)
    }

    autoSyncTimerRef.current = setTimeout(() => {
      autoSyncTimerRef.current = null
      if (suppressAutoSyncCountRef.current > 0 || syncInFlightRef.current) {
        return
      }
      void syncToBackend({ silent: true })
    }, AUTO_SYNC_DEBOUNCE_MS)
  }

  // Restore functions
  const openRestoreModal = async (): Promise<void> => {
    setShowRestoreModal(true)
    setSelectedBackup(null)
    setBackupPreview(null)
    setRestoreError(null)
    setIsLoadingBackups(true)

    try {
      const response = await fetch(withDiagramId('/api/backups', syncContextRef.current.diagramId))
      const result = await response.json()
      if (result.success) {
        setBackups(result.backups || [])
      }
    } catch (error) {
      console.error('Error fetching backups:', error)
      setRestoreError('Failed to load backups')
    } finally {
      setIsLoadingBackups(false)
    }
  }

  const closeRestoreModal = (): void => {
    setShowRestoreModal(false)
    setSelectedBackup(null)
    setBackupPreview(null)
    setRestoreError(null)
    setIsRestoring(false)
  }

  const previewBackup = async (backup: { name: string; reason: string; elementCount: number; createdAt: string }): Promise<void> => {
    setSelectedBackup(backup)
    setBackupPreview(null)
    setRestoreError(null)

    try {
      const response = await fetch(withDiagramId(`/api/backups/${encodeURIComponent(backup.name)}/preview`, syncContextRef.current.diagramId))
      const result = await response.json()
      if (result.success) {
        setBackupPreview(result.preview)
      } else {
        setRestoreError(result.error || 'Failed to preview backup')
      }
    } catch (error) {
      console.error('Error previewing backup:', error)
      setRestoreError('Failed to preview backup')
    }
  }

  const restoreFromBackup = async (): Promise<void> => {
    if (!selectedBackup || !excalidrawAPI) return

    setIsRestoring(true)
    setRestoreError(null)

    try {
      const response = await fetch(`/api/diagrams/${encodeURIComponent(syncContextRef.current.diagramId)}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshotName: selectedBackup.name,
          sessionId: syncContextRef.current.sessionId
        })
      })

      const result = await response.json()
      if (result.success) {
        // Reload scene to get restored elements
        await loadScene()
        closeRestoreModal()
      } else if (response.status === 409) {
        setRestoreError(result.error || 'Another restore is in progress. Please try again.')
      } else {
        setRestoreError(result.error || 'Failed to restore backup')
      }
    } catch (error) {
      console.error('Error restoring backup:', error)
      setRestoreError('Failed to restore backup')
    } finally {
      setIsRestoring(false)
    }
  }

  const formatBackupDate = (isoString: string): string => {
    const date = new Date(isoString)
    return date.toLocaleString()
  }

  const formatBackupReason = (reason: string): string => {
    const reasonMap: Record<string, string> = {
      clear: 'Canvas Cleared',
      delete: 'Element Deleted',
      restore: 'Before Restore',
      import: 'Before Import'
    }
    return reasonMap[reason] || reason
  }

  const clearCanvas = async (): Promise<void> => {
    if (excalidrawAPI) {
      try {
        // Get all current elements and delete them from backend
        const response = await fetch(withDiagramId('/api/elements', syncContextRef.current.diagramId))
        const result: ApiResponse = await response.json()

        if (result.success && result.elements) {
          const deletePromises = result.elements.map(element =>
            fetch(withDiagramId(`/api/elements/${element.id}`, syncContextRef.current.diagramId), { method: 'DELETE' })
          )
          await Promise.all(deletePromises)
        }

        // Clear the frontend canvas
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      } catch (error) {
        console.error('Error clearing canvas:', error)
        // Still clear frontend even if backend fails
        applySceneUpdateWithoutAutoSync(excalidrawAPI, {
          elements: [],
          captureUpdate: CaptureUpdateAction.IMMEDIATELY
        })
      }
    }
  }

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <h1>Excalidraw Canvas</h1>
        <div className="controls">
          <div className="status">
            <div className={`status-dot ${isConnected ? 'status-connected' : 'status-disconnected'}`}></div>
            <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
          </div>

          {/* Passive Sync Status */}
          <div className="sync-status-bar">
            <button
              className="diagram-selector-btn"
              onClick={() => {
                void fetchDiagramList()
                setShowDiagramSelector(!showDiagramSelector)
              }}
              title="Switch diagram"
            >
              <span className="diagram-name" title={activeDiagramName}>{activeDiagramName}</span>
              <span className="diagram-dropdown-arrow">{showDiagramSelector ? '▲' : '▼'}</span>
            </button>
            <span className={`sync-dot ${syncStatus === 'syncing' || isBackgroundSyncing ? 'sync-dot-syncing' : syncStatus === 'error' ? 'sync-dot-error' : 'sync-dot-ok'}`} title={syncStatus === 'error' ? (lastError ?? 'Sync error') : syncStatus === 'syncing' ? 'Syncing…' : lastSyncTime ? `Last sync: ${formatSyncTime(lastSyncTime)}` : 'Auto-sync on'} />
            <span className="version-label">v{remoteVersion}</span>
            {activeSessionCount > 1 && (
              <span className="session-badge" title={`${activeSessionCount} active sessions`}>{activeSessionCount}</span>
            )}
            {hasRemoteConflict && (
              <span className="conflict-badge" title="Remote changes detected">!</span>
            )}
          </div>

          {/* Diagram Selector Dropdown */}
          {showDiagramSelector && (
            <div className="diagram-selector-dropdown">
              <div className="diagram-selector-header">
                <span>Switch Diagram</span>
                <button className="diagram-selector-close" onClick={() => setShowDiagramSelector(false)}>×</button>
              </div>
              <div className="diagram-selector-list">
                {diagrams.map(diagram => (
                  <div
                    key={diagram.id}
                    className={`diagram-selector-item ${diagram.id === syncContext.diagramId ? 'active' : ''}`}
                    onClick={() => void switchToDiagram(diagram.id)}
                  >
                    <span className="diagram-item-name">{diagram.name}</span>
                    <div className="diagram-item-actions">
                      {diagram.id !== 'default' && (
                        <button
                          className="diagram-delete-btn"
                          onClick={(e) => { e.stopPropagation(); void deleteDiagram(diagram.id); }}
                          title="Delete diagram"
                        >
                          🗑️
                        </button>
                      )}
                      {diagram.id === syncContext.diagramId && <span className="diagram-item-check">✓</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button className="btn-secondary" onClick={clearCanvas}>Clear Canvas</button>
          <button className="btn-secondary" onClick={openRestoreModal}>Restore</button>
        </div>
      </div>

      {/* Canvas Container */}
      <div className="canvas-container">
        <div
          onPointerDownCapture={() => {
            userInteractedRef.current = true
          }}
          onKeyDownCapture={() => {
            userInteractedRef.current = true
          }}
          style={{ width: '100%', height: '100%' }}
        >
          <Excalidraw
            excalidrawAPI={(api: ExcalidrawAPIRefValue) => setExcalidrawAPI(api)}
            onChange={() => {
              scheduleAutoSync()
            }}
            initialData={{
              elements: [],
              appState: {
                theme: 'light',
                viewBackgroundColor: '#ffffff'
              }
            }}
          />
        </div>
      </div>

      {/* Restore Modal */}
      {showRestoreModal && (
        <div className="modal-overlay" onClick={closeRestoreModal}>
          <div className="modal-content restore-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Restore from Backup</h2>
              <button className="modal-close" onClick={closeRestoreModal}>&times;</button>
            </div>

            <div className="modal-body">
              {isLoadingBackups ? (
                <div className="restore-loading">Loading backups...</div>
              ) : backups.length === 0 ? (
                <div className="restore-empty">
                  <p>No automatic backups found.</p>
                  <p className="restore-hint">Backups are created automatically before destructive operations like clearing the canvas or restoring from another backup.</p>
                </div>
              ) : (
                <div className="restore-content">
                  <div className="restore-list">
                    <h3>Available Backups</h3>
                    <div className="backup-list">
                      {backups.map(backup => (
                        <div
                          key={backup.name}
                          className={`backup-item ${selectedBackup?.name === backup.name ? 'selected' : ''}`}
                          onClick={() => previewBackup(backup)}
                        >
                          <div className="backup-info">
                            <span className="backup-reason">{formatBackupReason(backup.reason)}</span>
                            <span className="backup-date">{formatBackupDate(backup.createdAt)}</span>
                          </div>
                          <span className="backup-count">{backup.elementCount} elements</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {selectedBackup && (
                    <div className="restore-preview">
                      <h3>Backup Preview</h3>
                      {backupPreview ? (
                        <div className="preview-details">
                          <p><strong>Reason:</strong> {formatBackupReason(selectedBackup.reason)}</p>
                          <p><strong>Created:</strong> {formatBackupDate(selectedBackup.createdAt)}</p>
                          <p><strong>Elements:</strong> {backupPreview.elementCount}</p>
                          {backupPreview.elementSummary && (
                            <div className="element-summary">
                              <strong>Element types:</strong>
                              <ul>
                                {Object.entries(backupPreview.elementSummary).map(([type, count]) => (
                                  <li key={type}>{type}: {count}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {backupPreview.boundingBox && (
                            <p><strong>Size:</strong> {backupPreview.boundingBox.width}x{backupPreview.boundingBox.height}px</p>
                          )}
                        </div>
                      ) : (
                        <div className="preview-loading">Loading preview...</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {restoreError && (
                <div className="restore-error">{restoreError}</div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn-secondary" onClick={closeRestoreModal} disabled={isRestoring}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={restoreFromBackup}
                disabled={!selectedBackup || isRestoring}
              >
                {isRestoring ? 'Restoring...' : 'Restore'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
