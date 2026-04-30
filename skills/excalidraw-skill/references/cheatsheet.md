# Excalidraw Skill Cheatsheet

## Canvas Defaults
- Base URL: `http://127.0.0.1:3000` (EXPRESS_SERVER_URL env var)
- Health: `GET /health`

## MCP Tools (26 total)

### Element CRUD

| Tool | Description | Required params |
|------|-------------|-----------------|
| `create_element` | Create shape/text/arrow/line | `type`, `x`, `y` |
| `batch_create_elements` | Create multiple elements at once | `elements[]` |
| `get_element` | Get single element by ID | `id` |
| `update_element` | Update element properties | `id` |
| `delete_element` | Delete element | `id` |
| `query_elements` | Query by type/bbox/filter | (optional) `type`, `bbox`, `filter` |
| `duplicate_elements` | Clone with offset | `elementIds[]`, (optional) `offsetX`, `offsetY` |

### Layout & Organization

| Tool | Description | Required params |
|------|-------------|-----------------|
| `align_elements` | Align left/center/right/top/middle/bottom | `elementIds[]`, `alignment` |
| `distribute_elements` | Even spacing horizontal/vertical | `elementIds[]`, `direction` |
| `group_elements` | Group elements | `elementIds[]` |
| `ungroup_elements` | Ungroup | `groupId` |
| `lock_elements` | Lock elements | `elementIds[]` |
| `unlock_elements` | Unlock elements | `elementIds[]` |

### Scene Awareness

| Tool | Description | Required params |
|------|-------------|-----------------|
| `describe_scene` | AI-readable description (types, positions, labels, connections, bbox) | — |
| `get_canvas_screenshot` | PNG screenshot for visual verification | (optional) `background` |
| `get_resource` | Get scene/library/theme/elements | `resource` |

### File I/O

| Tool | Description | Required params |
|------|-------------|-----------------|
| `export_scene` | Export to .excalidraw JSON | (optional) `filePath` |
| `import_scene` | Import from .excalidraw JSON | `mode`, (optional) `filePath` or `data` |
| `export_to_image` | Export to PNG/SVG (needs browser) | `format`, (optional) `filePath`, `background` |
| `export_to_excalidraw_url` | Upload, get shareable excalidraw.com URL | — |

### State Management

| Tool | Description | Required params |
|------|-------------|-----------------|
| `clear_canvas` | Remove all elements | — |
| `snapshot_scene` | Save named snapshot | `name` |
| `restore_snapshot` | Restore from snapshot | `name` |

### Viewport & Camera

| Tool | Description | Required params |
|------|-------------|-----------------|
| `set_viewport` | Zoom-to-fit, center on element, manual zoom/scroll | (optional) `scrollToContent`, `scrollToElementId`, `zoom`, `offsetX`, `offsetY` |

### Design & Conversion

| Tool | Description | Required params |
|------|-------------|-----------------|
| `read_diagram_guide` | Get design best practices (colors, sizing, anti-patterns) | — |
| `create_from_mermaid` | Convert Mermaid diagram to Excalidraw | `mermaidDiagram` |

---

## Element Format

### Shapes (MCP)
```json
{
  "id": "my-box",
  "type": "rectangle",
  "x": 100, "y": 50,
  "width": 180, "height": 60,
  "text": "My Label"
}
```

### Arrows (MCP)
```json
{
  "type": "arrow",
  "x": 0, "y": 0,
  "startElementId": "box-1",
  "endElementId": "box-2"
}
```

**Format rules:**
- Labels: `text` on shapes (NOT `label.text`)
- Arrow binding: `startElementId`/`endElementId` (NOT `start.id`)
- `fontFamily`: string or omitted — never a number
- `points`: both `[[x,y]]` and `[{x,y}]` accepted

---

## Arrow Routing

| Style | Use when | Example |
|-------|----------|---------|
| Straight | Simple connections | default |
| Curved | Crossing obstacles | `points: [[0,0], [50,-40], [200,0]], roundness: {"type": 2}` |
| Elbowed | Right-angle routing | `points: [[0,0], [0,-50], [200,-50], [200,0]], elbowed: true` |

---

## Canvas REST API

### Elements

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/elements` | List all |
| `GET` | `/api/elements/:id` | Get one |
| `POST` | `/api/elements` | Create |
| `PUT` | `/api/elements/:id` | Update |
| `DELETE` | `/api/elements/:id` | Delete |
| `DELETE` | `/api/elements/clear` | Clear all |
| `POST` | `/api/elements/batch` | Batch create |
| `POST` | `/api/elements/sync` | Overwrite/import |

### Export

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/export/image` | Request PNG/SVG export (needs browser) |

### Snapshots

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/snapshots` | Save snapshot |
| `GET` | `/api/snapshots` | List snapshots |
| `GET` | `/api/snapshots/:name` | Get snapshot |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/sync/status` | Sync stats |

---

## CLI Scripts

```bash
node scripts/healthcheck.cjs [--url http://127.0.0.1:3000]
node scripts/clear-canvas.cjs [--url http://127.0.0.1:3000]
node scripts/export-elements.cjs --out diagram.json [--url ...]
node scripts/import-elements.cjs --in diagram.json --mode batch|sync [--url ...]
```

---

## Quality Checklist

After each batch of changes, run:
```
get_canvas_screenshot → check:
  [ ] Text fully visible (no truncation)
  [ ] No element overlap
  [ ] Arrows don't cross unrelated shapes
  [ ] Arrow labels don't overlap shapes
  [ ] 40px+ gap between elements
  [ ] Font size ≥ 16
```

Fix issues before proceeding.