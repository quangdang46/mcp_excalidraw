# Release Checklist for mcp-excalidraw-server

This checklist verifies the project is ready for release.

## Pre-Release Verification

### Build & Test
- [x] `npm run build` succeeds (frontend + server TypeScript compilation)
- [x] `npm run test:bind` passes (local bind regression test)
- [x] `npm run test:persistence` passes (diagram persistence verification)

### Code Quality
- [x] TypeScript compiles without errors (`npx tsc`)
- [x] All source files have consistent formatting
- [x] No obvious TODO comments or placeholder code
- [x] Logger is properly initialized in all modules
- [x] Error handling is in place for all API endpoints

### Documentation
- [x] README.md is up-to-date with:
  - [x] Feature list (26 MCP tools)
  - [x] Quick start instructions (local + Docker)
  - [x] MCP client configuration (Claude Desktop, Claude Code, Cursor, Codex CLI)
  - [x] Agent skill documentation
  - [x] Testing instructions
  - [x] Troubleshooting section
- [x] package.json has correct version, description, and metadata
- [x] GitHub workflows exist for CI and Docker

## Architecture Verification

### Diagram-Centric Model
- [x] SQLite persistence with WAL mode enabled
- [x] Diagram/session/element scoping implemented
- [x] Session middleware for active diagram resolution
- [x] Operation locks for destructive actions

### Sync & Conflict Handling
- [x] Version-based sync with ACK protocol
- [x] Session presence tracking (active/stale/conflicting)
- [x] Same-diagram presence warnings
- [x] Automatic pre-destructive backups

### Safety & Recovery
- [x] Snapshot save/restore functionality
- [x] Mutation history for undo/redo
- [x] Automatic backup before clear/import/restore/delete
- [x] Validation limits enforced (payload size, element counts)

### Observability
- [x] Structured logging via Winston
- [x] Sync/performance metrics endpoints
- [x] Health check endpoint

## Known Issues (Non-Blocking)

- `undoLastMutation` for 'replace' operations casts arrays to single elements in mutation history recording - functional but not fully type-safe (pre-existing)

## Post-Release Tasks

When releasing a new version:

1. Update version in `package.json`:
   ```bash
   npm version patch  # or minor/major based on changes
   ```

2. Create git tag:
   ```bash
   git tag v<version>
   git push origin main --tags
   ```

3. GitHub Actions will automatically:
   - Run CI tests
   - Build and push Docker images to ghcr.io
   - Publish to npm registry (if using automatic releases)

4. Verify npm package:
   ```bash
   npm view mcp-excalidraw-server
   ```

5. Verify Docker images:
   ```bash
   docker pull ghcr.io/yctimlin/mcp_excalidraw:latest
   docker pull ghcr.io/yctimlin/mcp_excalidraw-canvas:latest
   ```
