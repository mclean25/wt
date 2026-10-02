import type { ReactNode } from "react";

import { useOverlayScroll, WtScrollbox } from "../scrollbox.tsx";

/** Confirm text and candidate lists stay reachable when the terminal is short. */
export function ConfirmBody({ children }: { children: ReactNode }) {
  const scrollRef = useOverlayScroll();
  return (
    <WtScrollbox scrollRef={scrollRef}>
      <box flexDirection="column" flexShrink={0}>{children}</box>
    </WtScrollbox>
  );
}
