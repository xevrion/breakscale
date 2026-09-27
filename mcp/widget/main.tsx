import { App as Host, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultConfig } from '../../src/sim/presets';
import type { Topology } from '../../src/sim/types';
import { buildTopology } from '../src/design';
import '../../src/index.css';
import './widget.css';

/*
 * The view a chat host draws when a model calls create_view.
 *
 * It is the whole app, unchanged, in the same way the VS Code panel is.
 * The app restores its last session from localStorage on boot, and a
 * sandboxed iframe has no localStorage, so this installs an in-memory one
 * seeded with the design the server accepted, then mounts. The app
 * never learns it is inside a chat.
 *
 * The same shim is how edits get back to the model. The app writes its
 * session on every change; each write that differs from what the model
 * last saw is passed on as model context, so "now make the database
 * bigger" starts from what the user is looking at.
 */

const SESSION_KEY = 'breakscale.session.v1';
const PREFS_KEY = 'breakscale.preferences.v1';
/** Dragging a node writes on every frame; the model needs the result, not the path. */
const SYNC_DELAY_MS = 1500;

interface ViewData {
  topology: Topology;
  name: string | null;
}

const host = new Host({ name: 'Breakscale', version: '0.1.0' }, {});

function applyContext(ctx: McpUiHostContext | undefined): void {
  const mode = ctx?.displayMode ?? 'inline';
  document.documentElement.dataset.display = mode;
}

function clientRps(t: Topology): number {
  return t.nodes.reduce(
    (sum, n) => (n.kind === 'client' ? sum + n.config.rps : sum),
    0,
  );
}

/**
 * The design in the short form create_view accepts: only the settings that
 * differ from a kind's defaults. A full topology repeats forty-odd fields a
 * node, which would spend the model's context on numbers nobody changed.
 */
function compact(t: Topology): unknown {
  return {
    nodes: t.nodes.map((n) => {
      const defaults = defaultConfig(n.kind) as unknown as Record<string, unknown>;
      const changed = Object.entries(n.config).filter(([k, v]) => defaults[k] !== v);
      return {
        id: n.id,
        kind: n.kind,
        label: n.label,
        x: Math.round(n.x),
        y: Math.round(n.y),
        ...(changed.length > 0 ? { config: Object.fromEntries(changed) } : {}),
      };
    }),
    edges: t.edges.map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.weight !== 1 ? { weight: e.weight } : {}),
      ...(e.control ? { control: true } : {}),
    })),
  };
}

/** Replace localStorage with a map, and report session writes to the model. */
function installStorage(seed: Record<string, string>, initial: Topology): void {
  const map = new Map(Object.entries(seed));
  let lastSent = JSON.stringify(compact(initial));
  let timer: ReturnType<typeof setTimeout> | undefined;

  const sync = () => {
    const raw = map.get(SESSION_KEY);
    if (!raw) return;
    let topology: Topology;
    try {
      topology = (JSON.parse(raw) as { topology: Topology }).topology;
    } catch {
      return;
    }
    const body = JSON.stringify(compact(topology));
    if (body === lastSent) return;
    lastSent = body;
    void host
      .updateModelContext({
        content: [
          {
            type: 'text',
            text:
              'The user edited the design on the Breakscale canvas. This is the current design; ' +
              `start from it for any change:\n${body}`,
          },
        ],
      })
      .catch(() => {});
  };

  const shim: Storage = {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem(k, v) {
      map.set(k, String(v));
      if (k === SESSION_KEY) {
        clearTimeout(timer);
        timer = setTimeout(sync, SYNC_DELAY_MS);
      }
    },
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
  Object.defineProperty(window, 'localStorage', { value: shim, configurable: true });
}

function showError(root: HTMLElement, message: string): void {
  const p = document.createElement('p');
  p.className = 'view-error';
  p.textContent = message;
  root.replaceChildren(p);
}

/**
 * The design, once the host has sent both the tool's input and its result.
 *
 * Built here from the input with the server's own `buildTopology`, which is
 * deterministic, rather than shipped back in the result: a result field
 * meant for the view is one some hosts show the model instead of the text.
 * The result still decides whether there is anything to show, since the
 * server may have rejected the design.
 */
function awaitDesign(): Promise<ViewData | null> {
  let input: unknown;
  let accepted: boolean | undefined;
  return new Promise((resolve) => {
    const settle = () => {
      if (input === undefined || accepted === undefined) return;
      const built = accepted ? buildTopology(input) : null;
      resolve(built?.ok ? { topology: built.topology, name: built.name } : null);
    };
    host.ontoolinput = (params) => {
      input = params.arguments ?? {};
      settle();
    };
    host.ontoolresult = (result) => {
      accepted = !result.isError;
      settle();
    };
  });
}

async function start(root: HTMLElement): Promise<void> {
  const design = awaitDesign();
  host.onhostcontextchanged = () => applyContext(host.getHostContext());
  host.onteardown = async () => ({});
  await host.connect();
  applyContext(host.getHostContext());
  const data = await design;

  if (!data) {
    showError(root, 'This design was not accepted, so there is nothing to show.');
    return;
  }

  const theme = host.getHostContext()?.theme;
  installStorage(
    {
      [SESSION_KEY]: JSON.stringify({
        topology: data.topology,
        rps: clientRps(data.topology),
        presetId: null,
      }),
      ...(theme ? { [PREFS_KEY]: JSON.stringify({ theme }) } : {}),
    },
    data.topology,
  );

  // Imported only now: some of the app's modules read storage as they load.
  const { default: App } = await import('../../src/App');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');
void start(root);
