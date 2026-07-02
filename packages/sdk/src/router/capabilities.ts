// Relocated to the open core during the SDK open-core extraction. The
// capability-profile table and `findCapableModel` are pure leaves with no
// proprietary dependencies, so they now live in `src/core/capabilities.ts`.
// This file is retained as a re-export so the proprietary `router/`
// import path keeps working unchanged.

export * from '../core/capabilities.js';
