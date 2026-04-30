---
name: excalidraw-skill
description: >-
  Programmatic canvas toolkit for creating, editing, and refining Excalidraw diagrams via MCP tools.
  Use when you need to draw diagrams, iteratively refine using describe_scene/get_canvas_screenshot,
  export/import .excalidraw files, save/restore snapshots, convert Mermaid, or perform element-level CRUD.
  Works with canvas server at http://127.0.0.1:3000 (default). Canvas must be open in browser for image export.
---

# Excalidraw Skill

## Canvas Connection

**MCP mode**: Use `mcp__excalidraw__*` tools directly — they are always available when MCP server is connected.

**Canvas setup** (if needed):
```bash
cd /data/projects/mcp_excalidraw
npm ci && npm run build
PORT=3000 npm run canvas
# Open http://127.0.0.1:3000 in browser
```

**Health check**: `GET http://127.0.0.1:3000/health`

---

## MCP Tools (26+ tools)

### Diagram Management
| Tool | Description |
|------|-------------|
| `list_diagrams` | List all diagrams |
| `create_diagram` | Create a new named diagram |
| `get_diagram` | Get diagram metadata |
| `set_active_diagram` | Switch to another diagram |
| `update_diagram` | Update diagram name/tags |
| `search_diagrams` | Search diagrams by name/tags |

### Element CRUD
| Tool | Description |
|------|-------------|
| `create_element` | Create single shape/text/arrow/line |
| `batch_create_elements` | Create multiple elements at once |
| `get_element` | Get element by ID |
| `update_element` | Update element properties |
| `delete_element` | Delete element by ID |
| `query_elements` | Query elements by type/bbox/filter |
| `duplicate_elements` | Clone elements with offset |

### Layout & Organization
| Tool | Description |
|------|-------------|
| `align_elements` | Align to left/center/right/top/middle/bottom |
| `distribute_elements` | Even spacing horizontal/vertical |
| `group_elements` | Group elements together |
| `ungroup_elements` | Ungroup by groupId |
| `lock_elements` | Lock elements |
| `unlock_elements` | Unlock elements |

### Scene Awareness
| Tool | Description |
|------|-------------|
| `describe_scene` | AI-readable scene description (types, positions, labels, connections, bbox) |
| `get_canvas_screenshot` | PNG screenshot for visual verification |
| `get_resource` | Get scene/library/theme/elements data |

### File I/O
| Tool | Description |
|------|-------------|
| `export_scene` | Export to .excalidraw JSON file |
| `import_scene` | Import from .excalidraw JSON (mode: replace/merge) |
| `export_to_image` | Export to PNG/SVG (requires browser open) |
| `export_to_excalidraw_url` | Upload to excalidraw.com, get shareable URL |

### State Management
| Tool | Description |
|------|-------------|
| `clear_canvas` | Remove all elements |
| `snapshot_scene` | Save named snapshot |
| `restore_snapshot` | Restore from named snapshot |

### Viewport & Camera
| Tool | Description |
|------|-------------|
| `set_viewport` | Zoom-to-fit, center on element, manual zoom/scroll |

### Design & Conversion
| Tool | Description |
|------|-------------|
| `read_diagram_guide` | Get design best practices |
| `create_from_mermaid` | Convert Mermaid diagram to Excalidraw |

---

## Element Format

### Shape/Text (MCP)
```json
{
  "id": "my-shape",
  "type": "rectangle",
  "x": 100, "y": 50,
  "width": 180, "height": 60,
  "text": "My Label"
}
```

### Arrow with Binding (MCP)
```json
{
  "type": "arrow",
  "x": 0, "y": 0,
  "startElementId": "shape-1",
  "endElementId": "shape-2"
}
```

**Notes:**
- `text` on shapes for labels (auto-converts)
- `startElementId`/`endElementId` for arrow binding
- `fontFamily` must be string or omitted — never a number
- Use custom `id` fields for easy later updates

---

## Coordinate System

- Origin (0, 0) at top-left
- x increases rightward, y increases downward
- Spacing: 80-120px vertical between tiers, 40-60px horizontal between siblings
- Shape width: `max(160, labelCharCount * 9)`
- Shape height: 60px single-line, 80px two-line

---

## Diagram Management Workflow

**IMPORTANT**: Each diagram should have a meaningful name that reflects its purpose. Never use "default" or generic names.

### Creating a new diagram
When user asks to create a diagram (e.g., "vẽ sơ đồ CI/CD", "create a flowchart"):
```
1. create_diagram(name: "CI/CD Pipeline")
2. batch_create_elements with all elements
3. set_viewport(scrollToContent: true)
```

### Switching between diagrams
When user wants to continue on an existing diagram:
```
1. list_diagrams → show available diagrams
2. set_active_diagram(diagramId: "diagram-id")
```

### Listing all diagrams
```
list_diagrams → returns all diagrams with names
```

---

## Workflow: New Diagram

**IMPORTANT**: Always create a named diagram FIRST, before creating any elements.

1. `create_diagram(name: "Descriptive Name")`
2. `read_diagram_guide` for design best practices
3. Plan coordinates on grid — map tiers and x-positions
4. `batch_create_elements` — shapes + arrows in one call
5. `set_viewport` with `scrollToContent: true`
6. `get_canvas_screenshot` → verify quality
7. Fix issues, re-screenshot, repeat until clean

---

## Workflow: Iterative Refinement

```
batch_create_elements
  → get_canvas_screenshot → "text truncated"
  → update_element (widen) → get_canvas_screenshot → "overlap"
  → update_element (reposition) → get_canvas_screenshot → "all good"
  → proceed
```

**Feedback loop**: Create → Screenshot → Fix → Screenshot → Repeat

---

## Workflow: Edit Existing Diagrams

**CRITICAL**: Never delete and recreate elements. Always update in place.

```bash
# Update element position/size via REST API
curl -X PUT http://127.0.0.1:3000/api/elements/:id -d '{"x": 100, "y": 200}'
```

When user asks to "rearrange", "move", "adjust position" on an existing diagram:
1. NEVER call clear_canvas or delete_element
2. Use update_element for position changes
3. Use batch_create_elements ONLY for NEW elements

---

## Workflow: Mermaid Conversion

```
create_from_mermaid(mermaidDiagram: "graph TD\n  A --> B\n  B --> C")
→ set_viewport(scrollToContent: true)
→ get_canvas_screenshot → verify layout
→ update_element if needed
```

---

## Workflow: File I/O

```bash
# Export
export_scene(filePath: "diagram.excalidraw")

# Import
import_scene(mode: "replace", filePath: "diagram.excalidraw")

# Share URL
export_to_excalidraw_url() → returns shareable link
```

---

## Workflow: Snapshots

1. `snapshot_scene(name: "before-change")`
2. Make changes
3. `describe_scene` / `get_canvas_screenshot` to verify
4. If bad: `restore_snapshot(name: "before-change")`

---

## Arrow Routing

**Straight**: Default for simple connections
**Curved**: For crossing obstacles
```json
{"type": "arrow", "points": [[0,0], [50,-40], [200,0]], "roundness": {"type": 2}}
```
**Elbowed**: Right-angle routing
```json
{"type": "arrow", "points": [[0,0], [0,-50], [200,-50], [200,0]], "elbowed": true}
```

---

## Quality Checklist

After each batch, screenshot and check:
- [ ] Text fully visible (no truncation)
- [ ] No element overlap
- [ ] Arrows don't cross unrelated shapes
- [ ] Arrow labels don't overlap shapes
- [ ] 40px+ gap between elements
- [ ] Font size ≥ 16 for body text

**Fix first, then proceed.** Don't ignore issues.

---

## Common Issues

| Problem | Solution |
|---------|----------|
| Elements not appearing | Use `set_viewport(scrollToContent: true)` |
| Arrow not connecting | Verify IDs with `get_element` |
| Canvas in bad state | `snapshot_scene` first, then `clear_canvas` |
| Element won't update | Call `unlock_elements` first |
| Text truncated | Increase `width`/`height` |
| Duplicate text elements | Don't put `text` on background zones — use separate text element |

---

## MCP vs REST

MCP tools are preferred. REST fallback (if MCP unavailable):
- `POST /api/elements/batch` — batch create
- `PUT /api/elements/:id` — update
- `DELETE /api/elements/:id` — delete
- `DELETE /api/elements/clear` — clear
- `POST /api/elements/sync` — import/overwrite

Note: REST uses `label: {text: ...}` instead of `text`, and `start: {id: ...}` instead of `startElementId`.

---

## References

- `references/cheatsheet.md`: Full tool reference + REST endpoints
- `scripts/*.cjs`: CLI utilities for batch operations