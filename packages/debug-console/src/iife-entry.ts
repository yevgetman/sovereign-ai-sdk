// The <script>-tag entry. It DOES register on load — a host dropping in one
// script tag expects the element to exist afterwards. The ESM entry
// deliberately does not, because a bare import must not mutate the global
// custom-element registry behind a consumer's back.

import { defineDebugConsole } from './register.js';

defineDebugConsole();

export * from './index.js';
