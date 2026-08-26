/**
 * Point the suite at `test/config.toml` unless the caller named a config
 * of their own.
 *
 * Config loads once at module init, and `bun test` from a developer
 * machine would otherwise inherit `~/.config/wt/config.toml` while CI
 * inherits nothing — so the two runs answer about different worlds and
 * the local one is the vouching-for-a-bug direction. Wiring it here
 * rather than in the CI workflow is the point: a habit the workflow
 * teaches is one a local run never learns.
 *
 * `WT_CONFIG` set explicitly still wins, so exercising the real config
 * stays one env var away.
 */
import { join } from "node:path";

process.env.WT_CONFIG ??= join(import.meta.dir, "config.toml");
