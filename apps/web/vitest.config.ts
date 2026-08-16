import { defineConfig } from "vitest/config";

// Node-environment unit tests for the web app's pure logic (copy/pluralisation,
// date formatting, small view-model helpers) and for CSS invariants that can be
// asserted by parsing the stylesheet. Component/visual behaviour is validated in
// a real browser rather than a DOM shim, so no jsdom dependency is pulled in.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
