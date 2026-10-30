// Process-manager entry point (pm2 >= 6, etc.). These managers load the app
// as a module via their fork container instead of executing it directly, so
// src/index.ts's `import.meta.main` guard never fires and the server never
// starts. This file calls `main()` unconditionally. Direct runs can keep
// using `bun src/index.ts`.
import { main } from "./src/index.ts";

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
