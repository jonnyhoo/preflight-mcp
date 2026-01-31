# Memory System Acceptance Testing

This document provides the minimal acceptance path for validating the 3-layer long-term memory (LTM) system functionality.

## Prerequisites

- A running ChromaDB instance (default: `http://localhost:8000`)
- Node.js environment with preflight-mcp installed and running
- MCP client configured to connect to preflight-mcp server

## Configuration

### Environment Variables

Set these environment variables to configure the memory system:

```bash
# Enable memory system
PREFLIGHT_MEMORY_ENABLED=true

# Optional: Override user ID (default: machine fingerprint)
PREFLIGHT_USER_ID=your-custom-user-id

# ChromaDB URL for memory storage
PREFLIGHT_CHROMA_URL=http://localhost:8000
```

### Config File

Alternatively, add to `~/.preflight/config.json`:

```json
{
  "memory": {
    "enabled": true,
    "userId": "your-custom-user-id"
  },
  "chromaUrl": "http://localhost:8000"
}
```

## Minimal Acceptance Path

### 1. Add Memories (L1: Episodic, L2: Semantic, L3: Procedural)

```json
{
  "action": "add",
  "layer": "episodic",
  "content": "Today I learned about the Preflight memory system capabilities",
  "metadata": {
    "type": "event",
    "tags": ["learning", "memory-system"]
  }
}
```

```json
{
  "action": "add",
  "layer": "semantic",
  "content": "TypeScript is a typed superset of JavaScript",
  "type": "fact",
  "subject": "TypeScript",
  "predicate": "is a",
  "object": "typed superset of JavaScript",
  "confidence": 0.9
}
```

```json
{
  "action": "add",
  "layer": "procedural",
  "content": "User prefers functional programming patterns",
  "type": "preference",
  "category": "coding-style",
  "strength": 0.85
}
```

### 2. Verify Memory Storage with Stats

```json
{
  "action": "stats"
}
```

Expected output should show count > 0 for each layer.

### 3. Search Memories

```json
{
  "action": "search",
  "query": "memory system",
  "layers": ["episodic", "semantic", "procedural"]
}
```

Should return the memory added in step 1.

### 4. List Memories

```json
{
  "action": "list",
  "layer": "episodic",
  "limit": 10
}
```

Should return the episodic memory added in step 1.

### 5. Reflect - Extract Facts

```json
{
  "action": "reflect",
  "reflectType": "extract_facts"
}
```

Should return extracted facts from stored memories.

### 6. Reflect - Extract Patterns (optional)

```json
{
  "action": "reflect", 
  "reflectType": "extract_patterns"
}
```

Should return behavioral patterns if semantic memories exist.

### 7. Reflect - Compress (optional)

```json
{
  "action": "reflect",
  "reflectType": "compress",
  "compressStrategy": {"layer": "episodic", "maxCount": 5}
}
```

Should return compressed memories from episodic layer.

### 8. Garbage Collection

```json
{
  "action": "gc",
  "gcOptions": {
    "layers": ["episodic"],
    "maxAgeDays": 365,
    "dryRun": true
  }
}
```

Should return a count (likely 0 for new memories).

### 9. Delete Memory

```json
{
  "action": "delete",
  "memoryId": "memory_id_from_step_1"
}
```

Should return true if deletion was successful.

## Expected Behaviors

1. **PII/Secret Detection**: Memories containing API keys, tokens, or private keys should be rejected or marked as sensitive
2. **Confidence Gating**: Semantic memories with confidence < 0.6 should be rejected
3. **Procedural Gating**: Procedural memories with strength < 0.8 should be rejected
4. **Conflict Detection**: Conflicting semantic relations should be flagged
5. **User Isolation**: Memories should be isolated per user ID
6. **L1 Limit**: Episodic memories should be limited to 1000 per user (oldest deleted when limit exceeded)

## Troubleshooting

- If ChromaDB is not running, memory operations will fail
- If memory system is not enabled in config, operations will not work
- Check logs for PII/Secret detection warnings
- Verify that memory collections (`preflight_mem_episodic`, `preflight_mem_semantic`, `preflight_mem_procedural`) are created in ChromaDB