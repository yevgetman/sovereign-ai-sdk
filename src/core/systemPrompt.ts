// Compatibility re-export. Phase 6 moved prompt assembly under src/context/
// while preserving existing imports from src/core/systemPrompt.ts.

export { buildSystemSegments, formatTools } from '../context/systemPrompt.js';
