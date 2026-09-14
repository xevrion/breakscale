// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Canvas from './Canvas';
import { makeNote } from '../sim/annotations';
import type { Annotation } from '../sim/annotations';
import type { Topology } from '../sim/types';
import { makeNode } from '../sim/presets';

/**
 * Note editing as the canvas wires the ported editor: how an edit starts,
 * what the canvas shows while it is open, what keeps it open, and the one
 * path by which the text reaches the shell.
 *
 * Driven with real events on the mounted canvas rather than by calling
 * props, because the behaviours here are exactly the ones a shortcut would
 * hide: that a double-click on the painted note is what opens the editor,
 * that a press on the format bar disarms the blur submit and the release
 * re-arms it, that the commit callback fires once however the edit ends.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function topologyWith(annotations: Annotation[]): Topology {
  const svc = makeNode('service', 100, 100);
  return { nodes: [svc], edges: [], annotations };
}

interface Mounted {
  onEditNote: ReturnType<typeof vi.fn>;
  onSetNoteStyle: ReturnType<typeof vi.fn>;
  onSetNoteSize: ReturnType<typeof vi.fn>;
  onSelectionChange: ReturnType<typeof vi.fn>;
  render: (topology: Topology, selected?: readonly string[]) => void;
}

function mount(topology: Topology, selected: readonly string[] = []): Mounted {
  const onEditNote = vi.fn();
  const onSetNoteStyle = vi.fn();
  const onSetNoteSize = vi.fn();
  // The shell owns the selection; mirror it back the way App does so the
  // canvas sees its own deselect-on-edit land.
  let sel: ReadonlySet<string> = new Set(selected);
  let topo = topology;
  const onSelectionChange = vi.fn((ids: ReadonlySet<string>) => {
    sel = ids;
    render(topo);
  });
  const render = (t: Topology, s?: readonly string[]) => {
    topo = t;
    if (s) sel = new Set(s);
    act(() =>
      root.render(
        <Canvas
          topology={t}
          snapshot={null}
          selectedIds={sel}
          onSelectionChange={onSelectionChange}
          onMoveNode={() => {}}
          onConnect={() => {}}
          onDeleteSelection={() => {}}
          onDropNode={() => {}}
          onEditNote={onEditNote}
          onSetNoteStyle={onSetNoteStyle}
          onSetNoteSize={onSetNoteSize}
        />,
      ),
    );
  };
  render(topology);
  return { onEditNote, onSetNoteStyle, onSetNoteSize, onSelectionChange, render };
}

function editor(): HTMLTextAreaElement | null {
  return container.querySelector<HTMLTextAreaElement>('textarea.cv-note-editor');
}

function noteHit(id: string): Element {
  const el = container.querySelector(`[data-hit="note"][data-id="${id}"]`);
  if (!el) throw new Error(`no hit rect for ${id}`);
  return el;
}

/** Double-click, then let the editor's deferred focus and listeners land. */
function dblclick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  act(() => {
    vi.runAllTimers();
  });
}

function type(el: HTMLTextAreaElement, value: string): void {
  act(() => {
    el.value = value;
    el.setSelectionRange(value.length, value.length);
    el.dispatchEvent(new Event('input'));
  });
}

function key(el: Element, k: string, init: KeyboardEventInit = {}): void {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: k,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

function pointer(kind: 'pointerdown' | 'pointerup', el: Element): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent(kind, { bubbles: true, cancelable: true, button: 0 }),
    );
  });
}

function blur(el: Element): void {
  act(() => {
    el.dispatchEvent(new FocusEvent('blur'));
  });
}

describe('note editing: entering', () => {
  it('double-clicking a note opens the editor over it, hides the SVG text, deselects', () => {
    const note = makeNote(40, 60, 'hello world');
    const { onSelectionChange } = mount(topologyWith([note]), [note.id]);
    expect(editor()).toBeNull();
    expect(container.querySelector('.cv-note-text')).not.toBeNull();
    expect(container.querySelector('.cv-ann-sel')).not.toBeNull();

    dblclick(noteHit(note.id));

    const el = editor();
    expect(el).not.toBeNull();
    expect(el!.value).toBe('hello world');
    expect(document.activeElement).toBe(el);
    // The paint yields to the editor; the selection ring yields to the
    // dashed text box, because editing deselects (as Excalidraw does).
    expect(container.querySelector('.cv-note-text')).toBeNull();
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
    expect(container.querySelector('.cv-ann-sel')).toBeNull();
    expect(container.querySelector('.cv-text-box')).not.toBeNull();
    // The format bar stays up for the note being edited.
    expect(container.querySelector('.cv-format')).not.toBeNull();
  });

  it('a double-click that lands on a note handle still edits the note', () => {
    const note = makeNote(0, 0, 'abc');
    mount(topologyWith([note]), [note.id]);
    const handle = container.querySelector(
      `[data-hit="note-resize"][data-id="${note.id}"]`,
    );
    expect(handle).not.toBeNull();
    dblclick(handle!);
    expect(editor()).not.toBeNull();
  });

  it('the editor is appended to its own container, a sibling of the surface', () => {
    const note = makeNote(0, 0, 'abc');
    mount(topologyWith([note]), [note.id]);
    dblclick(noteHit(note.id));
    const el = editor()!;
    expect(el.parentElement?.className).toBe('cv-text-editor-container');
    expect(el.closest('.cv-surface')).toBeNull();
  });
});

describe('note editing: the box hugs the text', () => {
  it('a fresh note is auto-sized: ring, hit area and frame hug the text and grow with it', () => {
    const note = makeNote(0, 0, 'Note');
    expect(note.autoResize).toBe(true);
    mount(topologyWith([note]), [note.id]);
    const hit = noteHit(note.id);
    const ring = container.querySelector('.cv-ann-ring')!;
    const hitW = Number(hit.getAttribute('width'));
    expect(hitW).toBeLessThan(note.width);
    expect(Number(ring.getAttribute('width'))).toBe(hitW);
    dblclick(hit);
    const narrow = Number(
      container.querySelector('.cv-text-box')!.getAttribute('width'),
    );
    expect(narrow).toBeLessThan(note.width);
    // Typing widens the frame past the default wrap width: nothing wraps.
    type(editor()!, 'Note that has grown much longer than the placeholder was');
    const grown = Number(
      container.querySelector('.cv-text-box')!.getAttribute('width'),
    );
    expect(grown).toBeGreaterThan(note.width);
  });

  it('a fixed-width note wraps at its width and its frame stops there', () => {
    const note = { ...makeNote(0, 0, 'Note'), width: 220, autoResize: undefined };
    mount(topologyWith([note]), [note.id]);
    dblclick(noteHit(note.id));
    type(editor()!, 'Note that has grown much longer than the placeholder was');
    const grown = Number(
      container.querySelector('.cv-text-box')!.getAttribute('width'),
    );
    expect(grown).toBeLessThanOrEqual(220 + 12);
    expect(editor()!.value.length).toBeGreaterThan(0);
  });
});

describe('note editing: the draft', () => {
  it('is not written to the topology until submit, and the text box follows it', () => {
    const note = { ...makeNote(0, 0, 'abc'), width: 220 };
    const { onEditNote } = mount(topologyWith([note]), [note.id]);
    dblclick(noteHit(note.id));
    const before = container.querySelector('.cv-text-box')!.getAttribute('height');
    type(editor()!, 'abc\nline two\nline three');
    expect(onEditNote).not.toHaveBeenCalled();
    expect(editor()!.value).toBe('abc\nline two\nline three');
    const after = container.querySelector('.cv-text-box')!.getAttribute('height');
    expect(Number(after)).toBeGreaterThan(Number(before));
  });
});

describe('note editing: chrome that must not end the edit', () => {
  it('a press on a format button disarms blur; the release refocuses; the style lands live', () => {
    const note = makeNote(0, 0, 'abc');
    const { onEditNote, onSetNoteStyle, render } = mount(topologyWith([note]), [
      note.id,
    ]);
    dblclick(noteHit(note.id));
    const bold = container.querySelector<HTMLButtonElement>('.cv-format-bold')!;
    const el = editor()!;

    pointer('pointerdown', bold);
    // In a browser the button takes focus here; the blur must not submit.
    blur(el);
    expect(onEditNote).not.toHaveBeenCalled();
    act(() => bold.click());
    expect(onSetNoteStyle).toHaveBeenCalledWith(note.id, { bold: 'toggle' });
    pointer('pointerup', bold);
    act(() => {
      vi.runAllTimers();
    });
    expect(document.activeElement).toBe(el);

    // The shell applies the style; the same textarea restyles in place.
    type(el, 'abcd');
    render(topologyWith([{ ...note, bold: true }]));
    expect(editor()).toBe(el);
    expect(el.className).toContain('is-bold');
    expect(el.value).toBe('abcd');
    expect(onEditNote).not.toHaveBeenCalled();

    // Armed again: the next blur submits.
    blur(el);
    expect(onEditNote).toHaveBeenCalledTimes(1);
    expect(onEditNote).toHaveBeenCalledWith(note.id, 'abcd');
  });

  it('the zoom buttons keep the editor open too, and it follows the zoom', () => {
    const note = makeNote(0, 0, 'abc');
    const { onEditNote } = mount(topologyWith([note]), [note.id]);
    dblclick(noteHit(note.id));
    const el = editor()!;
    const before = el.style.transform;
    const zoomIn = container.querySelector<HTMLButtonElement>(
      '.cv-zoom button[aria-label="Zoom in"]',
    )!;
    pointer('pointerdown', zoomIn);
    blur(el);
    act(() => zoomIn.click());
    pointer('pointerup', zoomIn);
    act(() => {
      vi.runAllTimers();
    });
    expect(editor()).toBe(el);
    expect(el.style.transform).not.toBe(before);
    expect(onEditNote).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+> steps the note size from inside the editor', () => {
    const note = makeNote(0, 0, 'abc');
    const { onSetNoteSize } = mount(topologyWith([note]), [note.id]);
    dblclick(noteHit(note.id));
    key(editor()!, '>', { ctrlKey: true, shiftKey: true });
    expect(onSetNoteSize).toHaveBeenCalledWith(note.id, 'lg');
    expect(editor()).not.toBeNull();
  });
});

describe('note editing: submitting', () => {
  it('Escape submits the draft exactly once, closes the editor and re-selects the note', () => {
    const note = makeNote(0, 0, 'abc');
    const { onEditNote, onSelectionChange } = mount(topologyWith([note]), [note.id]);
    dblclick(noteHit(note.id));
    const el = editor()!;
    type(el, 'abc changed');
    key(el, 'Escape');
    expect(onEditNote).toHaveBeenCalledTimes(1);
    expect(onEditNote).toHaveBeenCalledWith(note.id, 'abc changed');
    expect(editor()).toBeNull();
    expect(container.querySelector('.cv-text-box')).toBeNull();
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set([note.id]));
    // Nothing late-fires from the removed element.
    blur(el);
    key(el, 'Escape');
    act(() => {
      vi.runAllTimers();
    });
    expect(onEditNote).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Enter submits exactly once', () => {
    const note = makeNote(0, 0, 'abc');
    const { onEditNote } = mount(topologyWith([note]), [note.id]);
    dblclick(noteHit(note.id));
    type(editor()!, 'x');
    key(editor()!, 'Enter', { ctrlKey: true });
    expect(onEditNote).toHaveBeenCalledTimes(1);
    expect(onEditNote).toHaveBeenCalledWith(note.id, 'x');
  });

  it('blur submits exactly once, leaves nothing selected, and the paint comes back', () => {
    const note = makeNote(0, 0, 'abc');
    const { onEditNote, onSelectionChange, render } = mount(topologyWith([note]), [
      note.id,
    ]);
    dblclick(noteHit(note.id));
    type(editor()!, 'y');
    blur(editor()!);
    expect(onEditNote).toHaveBeenCalledTimes(1);
    expect(onEditNote).toHaveBeenCalledWith(note.id, 'y');
    expect(editor()).toBeNull();
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());
    render(topologyWith([{ ...note, text: 'y' }]));
    expect(container.querySelector('.cv-note-text')?.textContent).toBe('y');
  });

  it('a press on the canvas submits on the next frame', () => {
    const note = makeNote(0, 0, 'abc');
    const { onEditNote } = mount(topologyWith([note]), [note.id]);
    dblclick(noteHit(note.id));
    type(editor()!, 'z');
    pointer('pointerdown', container.querySelector('.cv-surface')!);
    act(() => {
      vi.runAllTimers();
    });
    expect(onEditNote).toHaveBeenCalledTimes(1);
    expect(onEditNote).toHaveBeenCalledWith(note.id, 'z');
  });

  it('an unchanged draft submits nothing, so no history entry is spent', () => {
    const note = makeNote(0, 0, 'abc');
    const { onEditNote } = mount(topologyWith([note]), [note.id]);
    dblclick(noteHit(note.id));
    key(editor()!, 'Escape');
    expect(onEditNote).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
  });

  it('passes empty and whitespace-only text through for the shell to delete', () => {
    // The decision to remove an emptied note is the shell's (handleEditNote
    // in App.tsx, which trims); the canvas reports what was typed, and does
    // not re-select a note that is about to vanish.
    const note = makeNote(0, 0, 'abc');
    const { onEditNote, onSelectionChange } = mount(topologyWith([note]), [note.id]);
    dblclick(noteHit(note.id));
    type(editor()!, '');
    key(editor()!, 'Escape');
    expect(onEditNote).toHaveBeenLastCalledWith(note.id, '');
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set());

    dblclick(noteHit(note.id));
    type(editor()!, '  \n ');
    key(editor()!, 'Escape');
    expect(onEditNote).toHaveBeenLastCalledWith(note.id, '  \n ');
    expect(onEditNote).toHaveBeenCalledTimes(2);
  });

  it('tears down without committing when the note disappears under it', () => {
    const note = makeNote(0, 0, 'abc');
    const { onEditNote, render } = mount(topologyWith([note]), [note.id]);
    dblclick(noteHit(note.id));
    type(editor()!, 'abcd');
    render(topologyWith([]), []);
    expect(editor()).toBeNull();
    expect(container.querySelector('.cv-text-box')).toBeNull();
    expect(onEditNote).not.toHaveBeenCalled();
  });
});
