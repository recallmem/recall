// n8n reads node icons next to the compiled nodes: copy each node's SVG into dist/.
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
for (const node of readdirSync(join(root, "src/nodes"))) {
  for (const file of readdirSync(join(root, "src/nodes", node))) {
    if (file.endsWith(".svg"))
      copyFileSync(join(root, "src/nodes", node, file), join(root, "dist/nodes", node, file));
  }
}
