/**
 * The in-place note editor, ported from Excalidraw's `textWysiwyg`
 * (packages/excalidraw/wysiwyg/textWysiwyg.tsx, MIT) and adapted to this
 * app's note model and SVG paint.
 *
 * WHAT IS KEPT VERBATIM (in behaviour, and mostly in code):
 *
 *   - An imperatively created TEXTAREA appended to a container outside the
 *     pointer surface, styled to nothing (no border, background, padding,
 *     outline or resize grip), laid out in SCENE px and scaled to the zoom
 *     with a CSS transform (`getTransform`), so the browser wraps the draft
 *     exactly as it does at 100 percent.
 *   - The key contract. Enter is a newline. Escape and Ctrl/Cmd+Enter
 *     submit. Tab, Shift+Tab, Ctrl+] and Ctrl+[ indent and outdent every
 *     selected line. Ctrl+= / Ctrl+- / Ctrl+0 zoom the canvas without
 *     leaving the editor; Ctrl+Shift+> / < step the text size. Composition
 *     (IME) is never interrupted.
 *   - Input normalisation: every line ending becomes \n and every literal
 *     tab becomes spaces, on input and on paste, with the caret put back.
 *   - The blur contract. Blur submits, except that a pointerdown on the
 *     editing chrome (the format bar, the zoom control) disarms blur until
 *     the following pointerup, which re-arms it and refocuses the editor
 *     unless the pointer landed in that chrome. Alt-tabbing away while
 *     disarmed submits via the window blur. A pointerdown on the canvas
 *     itself submits on the next frame, which is what makes a tap outside
 *     the editor reliable on mobile, where blur does not always fire.
 *   - Submit runs exactly once: an `isDestroyed` latch, and cleanup runs
 *     BEFORE the submit callback so a refocus in the callback cannot loop
 *     back into blur -> submit.
 *   - The caret is placed at the double-clicked character by measuring the
 *     line in a hidden mirror element with a DOM Range, and everything is
 *     selected otherwise (never on a touch screen, where a selection is
 *     hard to dismiss).
 *   - The editor follows the element: on every scene update or scroll the
 *     style is recomputed from the live element, and focus is restored
 *     unless a popup has it.
 *
 * WHAT IS ADAPTED, AND WHY:
 *
 *   - Excalidraw writes every keystroke into the scene and captures history
 *     on submit. Here the draft stays in the canvas's state and reaches the
 *     topology in one commit, which is this app's rule for history; the
 *     editor sees the live draft through `getText`. The effect on undo is
 *     the same: one entry per edit.
 *   - A note's box is `layoutNoteOf(note, draft)`, the same function that
 *     paints the SVG, rather than Excalidraw's `refreshTextDimensions`. An
 *     auto-sized note (Note.autoResize, Excalidraw's autoResize) never
 *     wraps and the editor grows with it; a fixed-width note wraps at its
 *     width. The width is NOT clamped to the viewport as Excalidraw clamps
 *     unbound text: that clamp changes the wrap width, and a wrap width
 *     that differs from the paint's is exactly the jump this editor exists
 *     to remove.
 *   - Face, weight, slant and colour are the note's own, applied through
 *     the same stylesheet rules the SVG text uses (class and data
 *     attributes) instead of an inline `strokeColor`.
 *   - `TAB_SIZE` is this app's 2, not Excalidraw's 4: the Tab key already
 *     inserted two spaces here, and a note painted as SVG has no tab stops,
 *     so a literal tab is normalised to the same two spaces.
 *   - Ctrl+Enter and Cmd+Enter both submit on every platform, matching the
 *     shortcut this app already documents.
 *   - No `beforeunload` submit: a note edit is a few words, and the browser
 *     dialog that hook can raise is worse than losing them.
 */

import type { Note } from '../sim/annotations';
import { NOTE_MAX_CHARS } from '../sim/annotations';
import {
  TAB,
  TAB_SIZE,
  layoutNoteOf,
  lineStartOffsets,
  normalizeText,
  noteStyle,
  scaledSpec,
} from './annotationLayout';
import { fontString } from './textMetrics';

/* ------------------------------------------------------------------ *
 * Ported helpers
 * ------------------------------------------------------------------ */

/**
 * Excalidraw's `getTransform`. The textarea has the default transform
 * origin (its centre), so scaling it by the zoom moves its top-left corner;
 * the translate puts the corner back where the scene coordinates say it
 * is. When the box is wider or taller than the room it has, the correction
 * is computed against the room instead, so the visible part stays put.
 */
export function getTransform(
  width: number,
  height: number,
  angle: number,
  zoom: number,
  maxWidth: number,
  maxHeight: number,
): string {
  const degree = (180 * angle) / Math.PI;
  let translateX = (width * (zoom - 1)) / 2;
  let translateY = (height * (zoom - 1)) / 2;
  if (width > maxWidth && zoom !== 1) {
    translateX = (maxWidth * (zoom - 1)) / 2;
  }
  if (height > maxHeight && zoom !== 1) {
    translateY = (maxHeight * (zoom - 1)) / 2;
  }
  return `translate(${translateX}px, ${translateY}px) scale(${zoom}) rotate(${degree}deg)`;
}

const RS_LTR_CHARS =
  'A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02B8\u0300-\u0590\u0800-\u1FFF' +
  '\u2C00-\uFB1C\uFDFE-\uFE6F\uFEFD-\uFFFF';
const RS_RTL_CHARS = '\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC';
const RE_RTL_CHECK = new RegExp(`^[^${RS_LTR_CHARS}]*[${RS_RTL_CHARS}]`);

/**
 * Whether the first directional character is RTL: the text starts with RTL
 * characters, or with indeterminate ones (digits, punctuation) followed by
 * RTL. Excalidraw's `isRTL`.
 */
export const isRTL = (text: string): boolean => RE_RTL_CHECK.test(text);

/** Direction of the hard (newline-delimited) line that holds `offset`. */
export function getLineDirection(text: string, offset: number): 'ltr' | 'rtl' {
  const hardLineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const hardLineEnd = text.indexOf('\n', offset);
  const hardLineText = text.slice(
    hardLineStart,
    hardLineEnd === -1 ? text.length : hardLineEnd,
  );
  return isRTL(hardLineText) ? 'rtl' : 'ltr';
}

/**
 * Every offset a caret can sit at, in UTF-16 units, stepping by code point
 * so a surrogate pair is never split.
 */
export function getCaretBoundaryOffsets(text: string): number[] {
  const offsets = [0];
  let offset = 0;
  for (const char of Array.from(text)) {
    offset += char.length;
    offsets.push(offset);
  }
  return offsets;
}

/**
 * The caret offset within one laid-out line nearest `targetX`, measured by
 * the browser's own layout: the line is rendered into a hidden mirror in the
 * editor's font, and a collapsed Range is walked along it to read where each
 * boundary lands. Returns null where that is not possible (no body, no
 * Range support, a non-finite rect), and the caller falls back to the line
 * start.
 */
export function getLineCaretOffsetFromNativeLayout({
  text,
  font,
  lineHeightPx,
  direction,
  targetX,
  ownerDocument,
}: {
  text: string;
  font: string;
  lineHeightPx: number;
  direction: 'ltr' | 'rtl';
  targetX: number;
  ownerDocument: Document;
}): number | null {
  if (!text || !ownerDocument.body || typeof ownerDocument.createRange !== 'function') {
    return null;
  }

  const offsets = getCaretBoundaryOffsets(text);
  const mirror = ownerDocument.createElement('div');
  const textNode = ownerDocument.createTextNode(text);
  const range = ownerDocument.createRange();
  const positions: number[] = [];

  mirror.dir = direction;
  Object.assign(mirror.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    margin: '0',
    padding: '0',
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
    whiteSpace: 'pre',
    font,
    lineHeight: `${lineHeightPx}px`,
  });
  mirror.append(textNode);
  ownerDocument.body.append(mirror);

  try {
    for (const offset of offsets) {
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset);
      const caretRect = range.getBoundingClientRect();
      if (!Number.isFinite(caretRect.left)) return null;
      positions.push(caretRect.left);
    }
  } catch {
    return null;
  } finally {
    mirror.remove();
  }

  const leftEdge = Math.min(...positions);
  let closestOffset = offsets[0]!;
  let closestDistance = Infinity;
  for (let index = 0; index < offsets.length; index++) {
    const distance = Math.abs(positions[index]! - leftEdge - targetX);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestOffset = offsets[index]!;
    }
  }
  return closestOffset;
}

/**
 * Excalidraw's `isWritableElement`: a target that takes typed text, so a
 * pointerdown on it inside the chrome must not be treated as a button press.
 */
export function isWritableElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    (target instanceof HTMLElement && target.dataset.type === 'wysiwyg') ||
    target instanceof HTMLBRElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement &&
      (target.type === 'text' ||
        target.type === 'number' ||
        target.type === 'password' ||
        target.type === 'search'))
  );
}

/* ------------------------------------------------------------------ *
 * The editor
 * ------------------------------------------------------------------ */

export interface TextWysiwygActions {
  zoomIn?: () => void;
  zoomOut?: () => void;
  resetZoom?: () => void;
  increaseFontSize?: () => void;
  decreaseFontSize?: () => void;
}

export interface TextWysiwygOptions {
  /** The note as it currently is in the topology, or null once it is gone. */
  getNote: () => Note | null;
  /** The text the edit starts from. From then on the textarea holds it. */
  initialText: string;
  /** Scene (world) -> container px, the canvas's own transform. */
  getViewportCoords: (x: number, y: number) => [number, number];
  getZoom: () => number;
  /** Where the textarea is appended: a sibling of the pointer surface. */
  container: HTMLElement;
  /** The pointer surface. A press on it submits on the next frame. */
  surface: HTMLElement;
  /**
   * Chrome that is part of the editing interaction: a press inside it
   * disarms the blur submit until the following pointerup. Excalidraw's
   * shape actions menu and zoom buttons; here the format bar and the zoom
   * control.
   */
  chromeSelector: string;
  onChange: (nextText: string) => void;
  onSubmit: (data: { viaKeyboard: boolean; nextText: string }) => void;
  actions?: TextWysiwygActions;
  autoSelect?: boolean;
  /** Scene point that was double-clicked; null selects everything. */
  initialCaretSceneCoords?: { x: number; y: number } | null;
}

export interface TextWysiwyg {
  /** Recompute position, size and style from the live note and view. */
  update: () => void;
  /** Submit now. Idempotent. */
  submit: () => void;
  /** Focus the textarea unless a popup has focus. */
  focus: () => void;
  readonly editable: HTMLTextAreaElement;
}

interface TextLayout {
  font: string;
  lineHeightPx: number;
  width: number;
  height: number;
  x: number;
  y: number;
  lines: string[];
}

export function textWysiwyg({
  getNote,
  initialText,
  getViewportCoords,
  getZoom,
  container,
  surface,
  chromeSelector,
  onChange,
  onSubmit,
  actions = {},
  autoSelect = true,
  initialCaretSceneCoords = null,
}: TextWysiwygOptions): TextWysiwyg {
  const ownerDocument = container.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  let currentTextLayout: TextLayout | null = null;

  const editable = ownerDocument.createElement('textarea');
  editable.dir = 'auto';
  editable.tabIndex = 0;
  editable.dataset.type = 'wysiwyg';
  editable.dataset.chrome = 'note-edit';
  // prevent line wrapping on Safari
  editable.wrap = 'off';
  editable.classList.add('cv-note-editor');
  editable.setAttribute('aria-label', 'Note text');
  editable.spellcheck = false;
  editable.autocomplete = 'off';
  // The bound sanitizeAnnotations applies to a note arriving from a link,
  // so typing stops where a round trip would cut. The browser refuses
  // further input visibly rather than dropping it silently on commit.
  editable.maxLength = NOTE_MAX_CHARS;

  Object.assign(editable.style, {
    position: 'absolute',
    display: 'inline-block',
    minHeight: '1em',
    backfaceVisibility: 'hidden',
    margin: '0',
    padding: '0',
    border: '0',
    // Inline, because the app's global :focus-visible rule rounds every
    // focused element and overflow:hidden then clips the selection
    // highlight to rounded corners.
    borderRadius: '0',
    outline: '0',
    resize: 'none',
    background: 'transparent',
    overflow: 'hidden',
    zIndex: '4',
    overflowWrap: 'break-word',
    boxSizing: 'content-box',
  });
  editable.value = initialText;

  const updateWysiwygStyle = () => {
    const note = getNote();
    if (!note) return;
    // The textarea is where the text is while the edit is open; the
    // canvas's draft mirrors it one render later. Reading it here keeps
    // the box in step with the keystroke that just landed.
    const text = editable.value;
    const zoom = getZoom();
    const spec = scaledSpec(note.size, note.scale);
    const style = noteStyle(note.size, note.font, note.bold, note.italic, note.scale);
    const layout = layoutNoteOf(note, text || ' ');

    // An auto-sized note never wraps: the textarea is as wide as its widest
    // line and grows with the typing (Excalidraw's autoResize text, where
    // `whiteSpace: pre` and the width is refreshed on every change). A
    // fixed-width note wraps at its width and breaks long words, exactly as
    // the paint does.
    let whiteSpace = 'pre';
    let wordBreak = 'normal';
    if (!note.autoResize) {
      whiteSpace = 'pre-wrap';
      wordBreak = 'break-word';
    }

    const coordX = note.x;
    const coordY = note.y;
    // Excalidraw adds half a pixel to a bound text's width so a line that
    // measures exactly at the width does not wrap one word early in the
    // editor: canvas measureText and the textarea's layout round the last
    // fraction of a pixel differently.
    const width = (note.autoResize ? layout.width : note.width) + 0.5;
    let height = layout.height;
    const maxWidth = width;

    const [viewportX, viewportY] = getViewportCoords(coordX, coordY);

    // add 5% buffer otherwise it causes wysiwyg to jump
    height *= 1.05;

    const font = fontString(style);

    // Make sure text editor height doesn't go beyond viewport. The
    // surface is the viewport here (Excalidraw reads appState.height); the
    // container the textarea lives in has no box of its own.
    const editorMaxHeight = (surface.clientHeight - viewportY) / zoom;

    editable.className = `cv-note-editor is-${note.size}${note.bold ? ' is-bold' : ''}${
      note.italic ? ' is-italic' : ''
    }${note.underline ? ' is-underline' : ''}`;
    editable.dataset.font = note.font ?? 'sans';
    if (note.tone === undefined) delete editable.dataset.tone;
    else editable.dataset.tone = String(note.tone);

    Object.assign(editable.style, {
      font,
      // must be defined *after* font ¯\_(ツ)_/¯
      lineHeight: `${spec.line}px`,
      wordBreak,
      // prevent line wrapping (`whitespace: nowrap` doesn't work on FF)
      whiteSpace,
      width: `${width}px`,
      height: `${height}px`,
      left: `${viewportX}px`,
      top: `${viewportY}px`,
      transform: getTransform(width, height, 0, zoom, maxWidth, editorMaxHeight),
      maxHeight: `${editorMaxHeight}px`,
    });
    currentTextLayout = {
      font,
      lineHeightPx: spec.line,
      width: note.width,
      height: layout.height,
      x: coordX,
      y: coordY,
      lines: layout.lines,
    };
    editable.scrollTop = 0;
  };

  updateWysiwygStyle();

  const getCaretIndexFromInitialSceneCoords = () => {
    if (!initialCaretSceneCoords || !currentTextLayout) return null;

    const layout = currentTextLayout;
    const localX = initialCaretSceneCoords.x - layout.x;
    const localY = initialCaretSceneCoords.y - layout.y;
    const text = editable.value;
    const lines = layout.lines;
    const starts = lineStartOffsets(text, lines);
    const lineIndex = Math.max(
      0,
      Math.min(lines.length - 1, Math.floor(localY / layout.lineHeightPx)),
    );
    const lineText = lines[lineIndex] ?? '';
    const lineStart = starts[lineIndex] ?? 0;
    const direction = getLineDirection(text, lineStart);
    // Notes are left-aligned; a centred or right-aligned line would shift
    // its start by the free space, as Excalidraw computes it.
    const lineStartX = 0;
    const relativeX = localX - lineStartX;

    if (!lineText) return lineStart;

    const lineCaretOffset = getLineCaretOffsetFromNativeLayout({
      text: lineText,
      font: layout.font,
      lineHeightPx: layout.lineHeightPx,
      direction,
      targetX: relativeX,
      ownerDocument,
    });

    return lineStart + (lineCaretOffset || 0);
  };

  let pendingInitialSelection = (() => {
    const caretIndex = getCaretIndexFromInitialSceneCoords();
    if (caretIndex === null) return null;
    return { start: caretIndex, end: caretIndex };
  })();

  // Plain text is left to the browser to paste; oninput below normalises
  // it exactly as it normalises typed text. Excalidraw's paste handler
  // additionally unpacks its own clipboard format, which never reaches a
  // focused textarea here (see the document paste handler's isTypingTarget
  // guard).

  editable.oninput = () => {
    const normalized = normalizeText(editable.value).slice(0, NOTE_MAX_CHARS);
    if (editable.value !== normalized) {
      const selectionStart = editable.selectionStart;
      editable.value = normalized;
      // put the cursor at some position close to where it was before
      // normalization (otherwise it'll end up at the end of the text)
      editable.selectionStart = selectionStart;
      editable.selectionEnd = selectionStart;
    }
    onChange(editable.value);
    updateWysiwygStyle();
  };

  const ctrlOrCmd = (event: KeyboardEvent) => event.ctrlKey || event.metaKey;

  editable.onkeydown = (event) => {
    // The window-level shortcut handlers already ignore text fields;
    // stopping propagation is belt and braces on top of that.
    event.stopPropagation();
    if (
      !event.shiftKey &&
      ctrlOrCmd(event) &&
      (event.code === 'Equal' || event.code === 'NumpadAdd')
    ) {
      event.preventDefault();
      actions.zoomIn?.();
      updateWysiwygStyle();
    } else if (
      !event.shiftKey &&
      ctrlOrCmd(event) &&
      (event.code === 'Minus' || event.code === 'NumpadSubtract')
    ) {
      event.preventDefault();
      actions.zoomOut?.();
      updateWysiwygStyle();
    } else if (
      !event.shiftKey &&
      ctrlOrCmd(event) &&
      (event.code === 'Digit0' || event.code === 'Numpad0')
    ) {
      event.preventDefault();
      actions.resetZoom?.();
      updateWysiwygStyle();
    } else if (
      ctrlOrCmd(event) &&
      event.shiftKey &&
      (event.key === '<' || event.key === ',')
    ) {
      event.preventDefault();
      actions.decreaseFontSize?.();
    } else if (
      ctrlOrCmd(event) &&
      event.shiftKey &&
      (event.key === '>' || event.key === '.')
    ) {
      event.preventDefault();
      actions.increaseFontSize?.();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // An IME candidate window takes Escape to dismiss a candidate;
      // submitting on it would end the edit mid-word. Excalidraw does not
      // guard Escape; this app's editors always have.
      if (event.isComposing || event.keyCode === 229) return;
      submittedViaKeyboard = true;
      handleSubmit();
    } else if (event.key === 'Enter' && ctrlOrCmd(event)) {
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) return;
      submittedViaKeyboard = true;
      handleSubmit();
    } else if (
      event.key === 'Tab' ||
      (ctrlOrCmd(event) &&
        (event.code === 'BracketLeft' || event.code === 'BracketRight'))
    ) {
      event.preventDefault();
      if (event.isComposing) return;
      if (event.shiftKey || event.code === 'BracketLeft') outdent();
      else indent();
      // We must send an input event to resize the element
      editable.dispatchEvent(new Event('input'));
    }
  };

  const RE_LEADING_TAB = new RegExp(`^ {1,${TAB_SIZE}}`);
  const indent = () => {
    const { selectionStart, selectionEnd } = editable;
    const linesStartIndices = getSelectedLinesStartIndices();

    let value = editable.value;
    if (value.length + TAB_SIZE * linesStartIndices.length > NOTE_MAX_CHARS) return;
    linesStartIndices.forEach((startIndex: number) => {
      const startValue = value.slice(0, startIndex);
      const endValue = value.slice(startIndex);
      value = `${startValue}${TAB}${endValue}`;
    });

    editable.value = value;

    editable.selectionStart = selectionStart + TAB_SIZE;
    editable.selectionEnd = selectionEnd + TAB_SIZE * linesStartIndices.length;
  };

  const outdent = () => {
    const { selectionStart, selectionEnd } = editable;
    const linesStartIndices = getSelectedLinesStartIndices();
    const removedTabs: number[] = [];

    let value = editable.value;
    linesStartIndices.forEach((startIndex) => {
      const tabMatch = value
        .slice(startIndex, startIndex + TAB_SIZE)
        .match(RE_LEADING_TAB);

      if (tabMatch) {
        const startValue = value.slice(0, startIndex);
        const endValue = value.slice(startIndex + tabMatch[0].length);
        // Delete a tab from the line
        value = `${startValue}${endValue}`;
        removedTabs.push(startIndex);
      }
    });

    editable.value = value;

    if (removedTabs.length) {
      const last = removedTabs[removedTabs.length - 1]!;
      if (selectionStart > last) {
        editable.selectionStart = Math.max(selectionStart - TAB_SIZE, last);
      } else {
        // If the cursor is before the first tab removed, ex:
        // Line| #1
        //     Line #2
        // Lin|e #3
        // we should reset the selectionStart to his initial value.
        editable.selectionStart = selectionStart;
      }
      editable.selectionEnd = Math.max(
        editable.selectionStart,
        selectionEnd - TAB_SIZE * removedTabs.length,
      );
    }
  };

  /**
   * @returns indices of start positions of selected lines, in reverse order
   */
  const getSelectedLinesStartIndices = () => {
    let { selectionStart } = editable;
    const { selectionEnd, value } = editable;

    // chars before selectionStart on the same line
    const startOffset = /[^\n]*$/.exec(value.slice(0, selectionStart))![0].length;
    // put caret at the start of the line
    selectionStart = selectionStart - startOffset;

    const selected = value.slice(selectionStart, selectionEnd);

    return selected
      .split('\n')
      .reduce(
        (startIndices, _line, idx, lines) =>
          startIndices.concat(
            idx
              ? // curr line index is prev line's start + prev line's length + \n
                startIndices[idx - 1]! + lines[idx - 1]!.length + 1
              : // first selected line
                selectionStart,
          ),
        [] as number[],
      )
      .reverse();
  };

  // using a state variable instead of passing it to the handleSubmit callback
  // so that we don't need to create separate a callback for event handlers
  let submittedViaKeyboard = false;
  const handleSubmit = () => {
    // prevent double submit
    if (isDestroyed) return;
    isDestroyed = true;
    // cleanup must be run before onSubmit otherwise when app blurs the wysiwyg
    // it'd get stuck in an infinite loop of blur→onSubmit after we re-focus the
    // wysiwyg on update
    cleanup();
    onSubmit({
      viaKeyboard: submittedViaKeyboard,
      nextText: editable.value,
    });
  };

  const cleanup = () => {
    // remove events to ensure they don't late-fire
    editable.onblur = null;
    editable.oninput = null;
    editable.onkeydown = null;

    if (observer) observer.disconnect();

    ownerWindow.removeEventListener('resize', updateWysiwygStyle);
    ownerWindow.removeEventListener('pointerdown', onPointerDown, { capture: true });
    ownerWindow.removeEventListener('pointerup', bindBlurEvent);
    ownerWindow.removeEventListener('blur', handleSubmit);
    if (pendingPointerdownBind !== null) {
      ownerWindow.cancelAnimationFrame(pendingPointerdownBind);
    }
    if (pendingSurfaceSubmit !== null) {
      ownerWindow.cancelAnimationFrame(pendingSurfaceSubmit);
    }

    editable.remove();
  };

  const inChrome = (target: EventTarget | null | undefined) =>
    (target instanceof ownerWindow.HTMLElement ||
      target instanceof ownerWindow.SVGElement) &&
    !!(target as Element).closest(chromeSelector);

  const bindBlurEvent = (event?: MouseEvent) => {
    ownerWindow.removeEventListener('pointerup', bindBlurEvent);
    // Deferred so that the pointerdown that initiates the wysiwyg doesn't
    // trigger the blur on ensuing pointerup.
    // Also to handle cases such as picking a color which would trigger a blur
    // in that same tick.
    // Excalidraw leaves focus where it landed when the press was inside its
    // shape actions menu, because that menu opens popovers with inputs of
    // their own. This app's editing chrome is buttons only, so every press
    // in it ends with the caret back in the note, the way Excalidraw's zoom
    // buttons do.
    void event;

    ownerWindow.setTimeout(() => {
      if (isDestroyed) return;

      // Re-enable submit on blur and refocus the editor.
      editable.onblur = handleSubmit;
      editable.focus();
      if (pendingInitialSelection) {
        editable.setSelectionRange(
          pendingInitialSelection.start,
          pendingInitialSelection.end,
        );
        pendingInitialSelection = null;
      }
    });
  };

  const temporarilyDisableSubmit = () => {
    editable.onblur = null;
    ownerWindow.addEventListener('pointerup', bindBlurEvent);
    // handle edge-case where pointerup doesn't fire e.g. due to user
    // alt-tabbing away
    ownerWindow.addEventListener('blur', handleSubmit);
  };

  let pendingSurfaceSubmit: number | null = null;

  // prevent blur when changing properties from the menu
  const onPointerDown = (event: PointerEvent) => {
    const target = event?.target;

    // panning canvas
    if (event.button === 1) {
      // A middle press anywhere pans; the editor stays open and follows.
      temporarilyDisableSubmit();
      return;
    }

    if (inChrome(target) && !isWritableElement(target)) {
      temporarilyDisableSubmit();
    } else if (
      target instanceof ownerWindow.Element &&
      surface.contains(target) &&
      !editable.contains(target)
    ) {
      // On mobile, blur event doesn't seem to always fire correctly,
      // so we want to also submit on pointerdown outside the wysiwyg.
      // Done in the next frame to prevent pointerdown from creating a new text
      // immediately (if tools locked) so that users on mobile have chance
      // to submit first (to hide virtual keyboard).
      pendingSurfaceSubmit = ownerWindow.requestAnimationFrame(() => {
        pendingSurfaceSubmit = null;
        handleSubmit();
      });
    }
  };

  // ---------------------------------------------------------------------------

  let isDestroyed = false;

  if (autoSelect && !pendingInitialSelection) {
    // select on init (focusing is done separately inside the bindBlurEvent()
    // because we need it to happen *after* the blur event from `pointerdown`)
    editable.select();
  }
  bindBlurEvent();

  // reposition wysiwyg in case of canvas is resized. Using ResizeObserver
  // is preferred so we catch changes from host, where window may not resize.
  let observer: ResizeObserver | null = null;
  if (typeof ownerWindow.ResizeObserver === 'function') {
    observer = new ownerWindow.ResizeObserver(() => {
      updateWysiwygStyle();
    });
    observer.observe(surface);
  } else {
    ownerWindow.addEventListener('resize', updateWysiwygStyle);
  }

  editable.onpointerdown = (event) => event.stopPropagation();

  // rAF (+ capture to by doubly sure) so we don't catch te pointerdown that
  // triggered the wysiwyg
  let pendingPointerdownBind: number | null = ownerWindow.requestAnimationFrame(() => {
    pendingPointerdownBind = null;
    ownerWindow.addEventListener('pointerdown', onPointerDown, { capture: true });
  });
  container.appendChild(editable);

  return {
    editable,
    update: () => {
      if (isDestroyed) return;
      updateWysiwygStyle();
    },
    focus: () => {
      if (isDestroyed) return;
      // handle updates of textElement properties of editing element
      const active = ownerDocument.activeElement;
      const isPopupOpened =
        !!active &&
        active !== editable &&
        inChrome(active) &&
        isWritableElement(active);
      if (!isPopupOpened) editable.focus();
    },
    submit: handleSubmit,
  };
}
