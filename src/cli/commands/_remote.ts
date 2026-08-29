import { decodeRemoteArgs } from "../../core/remote-protocol.ts";

/** Decode SSH-safe argv and re-enter the normal CLI dispatcher remotely. */
export async function run(argv: string[]): Promise<number> {
  if (argv.length !== 1) {
    console.error("usage: wt _remote <encoded-argv>");
    return 2;
  }
  let decoded: string[];
  try {
    decoded = decodeRemoteArgs(argv[0]!);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (decoded[0] !== "_hello") {
    const { config } = await import("../../core/config.ts");
    if (config.instance.role !== "worker") {
      console.error(
        'remote execution requires [instance] role = "worker" on this host',
      );
      return 1;
    }
  }
  const { dispatch } = await import("../index.ts");
  return dispatch(decoded);
}
