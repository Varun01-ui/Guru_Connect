import { config } from 'dotenv'

config({ path: '.env.test' })

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Several suites flip shared rows (fee configurations, wallet setting) and share one test database.
    fileParallelism: false,
    globalSetup: ['./src/test/globalSetup.ts'],
  },
})
