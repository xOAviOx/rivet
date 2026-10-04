import { lstatSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve from this script, never from the caller's current directory.
const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const target = join(root, "dist");
if (dirname(target) !== root || relative(root, target) !== "dist")
  throw new Error("Refusing to clean outside the generated dist directory");
let info;
try {
  info = lstatSync(target);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (info) {
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    realpathSync(target) !== target
  )
    throw new Error(
      "Refusing to clean dist: expected a real directory, not a link",
    );
  rmSync(target, { recursive: true });
}
