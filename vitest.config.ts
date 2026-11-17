import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["tests/setup/semCrm.ts"],
    // O CRM tem o próprio vitest (crm/vitest.config.ts, com o alias @/ e o banco de teste)
    exclude: [...configDefaults.exclude, "crm/**"],
  },
});
