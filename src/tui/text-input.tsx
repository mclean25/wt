import { useCallback, useState } from "react";
import type { BoxRenderable } from "@opentui/core";

import { editSpans, visibleEdit, type TextEdit } from "./text-edit.tsx";

/** Presentation for the shared line editor; keyboard ownership stays at its caller. */
export function TextInput({
  edit,
  fg,
  cursorChar = "█",
}: {
  edit: TextEdit;
  fg: string;
  cursorChar?: string;
}) {
  const [width, setWidth] = useState(0);
  const measure = useCallback(function (this: BoxRenderable) {
    setWidth(this.width);
  }, []);
  return (
    <box
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      height={1}
      overflow="hidden"
      onSizeChange={measure}
    >
      <text wrapMode="none">
        {width > 0 ? editSpans(visibleEdit(edit, width), fg, cursorChar) : null}
      </text>
    </box>
  );
}
