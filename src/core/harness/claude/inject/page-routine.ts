/**
 * The in-page routine, kept as an opaque JS source string.
 *
 * It is evaluated inside the TARGET Claude Code process (via
 * `Runtime.callFunctionOn` with `this` = the Ink `App` instance), so it
 * cannot be TypeScript, cannot import anything, and must not be
 * "tidied" into wt's own idiom: it is the piece that tracks upstream
 * Claude Code, and it is ported from unseamless-coop's
 * `scripts/fleet/_inject` so the two stay diffable line for line. Fix
 * it by re-deriving against a live session (see below), never by
 * reasoning about it from here.
 *
 * WHAT IT DOES
 * ------------
 * Walks the live React (Ink) fiber tree to the prompt-input component
 * and calls its `onSubmit` handler — the exact path a typed+entered
 * line takes — so the message lands as an ordinary user turn. The
 * receiving transcript records `origin: {kind:"human"}` /
 * `promptSource:"typed"`, with none of the peer-message framing a
 * cross-session API delivery carries. That framing is the whole reason
 * this transport exists: a message wrapped as "another session sent
 * this" makes the receiver defer to the human on flows the human
 * already approved.
 *
 * A slash command is just a message whose text starts with `/`: because
 * this is the same handler typing goes through, `/compact` actually
 * RUNS rather than arriving as a paragraph about compaction.
 *
 * ANCHORS (and how to re-derive them after a Claude Code update)
 * -------------------------------------------------------------
 * All anchors are STRUCTURAL / SEMANTIC, never minified names or byte
 * offsets, so they survive minifier churn across versions:
 *   * app instance = boundThis of process.stdin's 'readable' listener
 *     (Ink wires its input reader as a bound method of the root App).
 *   * prompt fiber = a fiber whose memoizedProps has onSubmit:function
 *     AND one of messagesRef / commands / onAgentSubmit (the prompt
 *     input's own props; these English names are stable).
 *   * input fiber  = a fiber with value:string + onChange:function (the
 *     controlled text input). Its `value` IS the user's current draft,
 *     and a sibling pair on the same fiber — cursorOffset:number +
 *     onChangeCursorOffset:function — IS the caret position.
 *
 * `onSubmit` clears the box (text AND caret) as part of its job, so to
 * avoid clobbering a draft we save `value` + `cursorOffset` first and
 * re-assert both after the clear settles. React double-buffers fibers,
 * so the walk also traverses `.alternate`; the caller's retry loop
 * absorbs the window where the tree is mid-commit.
 *
 * `probeOnly` returns what it found WITHOUT submitting — that is the
 * selftest, and it is also the readiness gate: a session sitting on the
 * trust dialog or a permission prompt has no mounted prompt input, so
 * the probe fails and wt falls back to the terminal transport instead
 * of firing an Enter into somebody's modal.
 */
export const PAGE_ROUTINE = `function(msg, probeOnly){
    let root = this._reactInternals || this._reactInternalFiber;
    if (!root) return JSON.stringify({ok:false, err:"no react root on app instance"});
    while (root.return) root = root.return;
    // 1) the prompt fiber: onSubmit + a prompt-only prop (messagesRef/commands/onAgentSubmit).
    let prompt=null; const seen=new Set();
    (function v(f){ if(!f||seen.has(f)||prompt)return; seen.add(f);
      let p; try{ p=f.memoizedProps; }catch(e){ p=null; }
      if(p && typeof p==="object" && typeof p.onSubmit==="function" && (("messagesRef"in p)||("commands"in p)||("onAgentSubmit"in p))) { prompt=f; return; }
      v(f.child); v(f.sibling); v(f.alternate);
    })(root);
    if(!prompt) return JSON.stringify({ok:false, err:"prompt fiber not found"});
    // 2) the controlled text input, searched ONLY within the prompt's own subtree, so a
    //    modal/permission text box elsewhere in the tree can't be mistaken for the draft.
    let input=null; const seen2=new Set();
    (function v(f){ if(!f||seen2.has(f)||input)return; seen2.add(f);
      let p; try{ p=f.memoizedProps; }catch(e){ p=null; }
      if(p && typeof p==="object" && typeof p.onChange==="function" && typeof p.value==="string") { input=f; return; }
      v(f.child); v(f.sibling); v(f.alternate);
    })(prompt.child);
    if(probeOnly){ const pip = input ? input.memoizedProps : null; return JSON.stringify({ok:true, foundPrompt:true, foundInput: !!input, foundCaret: !!(pip && typeof pip.cursorOffset==="number" && typeof pip.onChangeCursorOffset==="function")}); }
    const ip = input ? input.memoizedProps : null;
    const draft = ip ? (ip.value || "") : "";
    const onChange = ip ? ip.onChange : null;
    // Caret position rides on the same fiber as a sibling prop pair; capture it so the
    // restored draft lands where the user left it instead of collapsing to offset 0.
    const cursor = ip && typeof ip.cursorOffset === "number" ? ip.cursorOffset : null;
    const onChangeCursor = ip && typeof ip.onChangeCursorOffset === "function" ? ip.onChangeCursorOffset : null;
    const noop = new Proxy(function(){}, { get:()=>(()=>{}), apply:()=>{} });
    try { prompt.memoizedProps.onSubmit(msg, noop, false, {}); }
    catch(e){ return JSON.stringify({ok:false, err:"onSubmit threw: "+String(e&&e.message||e)}); }
    // Restore value then caret (twice, to ride out the post-submit clear). The caret is
    // set AFTER value in the same callback so its write wins, and clamped to the draft
    // length so it survives even if a value-change effect re-clamps it -- those two, not
    // update batching, are what keep the caret off 0 (Ink's renderer doesn't batch a
    // setTimeout the way react-dom would, so don't reorder these expecting it to).
    function restore(){
      try{ onChange(draft); }catch(e){}
      if (onChangeCursor && cursor!=null) { try{ onChangeCursor(Math.min(cursor, draft.length)); }catch(e){} }
    }
    if (draft && onChange) { setTimeout(restore,50); setTimeout(restore,160); }
    return JSON.stringify({ok:true, submitted:true, draftLen:draft.length, cursor:cursor});
  }`;

/**
 * Shape the page routine returns. The two `ok` variants are
 * discriminated by `foundPrompt` — the probe sets it, the submit
 * doesn't — so callers narrow on `"foundPrompt" in result` rather than
 * casting across the union.
 */
export type PageResult =
  | { ok: false; err: string }
  | { ok: true; submitted: true; draftLen: number; cursor: number | null }
  | { ok: true; foundPrompt: true; foundInput: boolean; foundCaret: boolean };

/**
 * Validate what came back from the target process.
 *
 * This crosses a process boundary from code that deliberately tracks
 * upstream Claude Code, so its shape is an assumption, not a
 * guarantee — and an unchecked cast would put `undefined` into fields
 * the type system promises are strings, which then surface as
 * "(undefined)" in a user-facing warning instead of failing here.
 * Anything unrecognized becomes an ordinary failure, which the caller
 * already knows how to fall back from.
 */
export function parsePageResult(value: unknown): PageResult {
  let raw: unknown;
  try {
    raw = typeof value === "string" ? JSON.parse(value) : value;
  } catch (err) {
    return { ok: false, err: `page routine returned unparseable output: ${String(err)}` };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, err: "page routine returned no result" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.ok !== true) {
    return { ok: false, err: typeof obj.err === "string" ? obj.err : "page routine failed" };
  }
  if (obj.foundPrompt === true) {
    return {
      ok: true,
      foundPrompt: true,
      foundInput: obj.foundInput === true,
      foundCaret: obj.foundCaret === true,
    };
  }
  if (obj.submitted === true) {
    return {
      ok: true,
      submitted: true,
      draftLen: typeof obj.draftLen === "number" ? obj.draftLen : 0,
      cursor: typeof obj.cursor === "number" ? obj.cursor : null,
    };
  }
  return { ok: false, err: "page routine returned an unrecognized shape" };
}
