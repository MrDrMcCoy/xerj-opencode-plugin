// TUI part: a live sidebar block, a details panel, and four commands. Every
// value comes over RPC from the server part, so the TUI never opens the node,
// reads the index, or touches the filesystem.

/* @jsxImportSource @opentui/solid */

import { createSignal } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import { XerjRpc, type StatusSnapshot } from "./rpc.ts";
import { panelSections, sidebarLines, sidebarView, type SidebarRow } from "./ui/format.ts";
import {
  DEFAULT_PREFS,
  readPrefs,
  seedCollapsed,
  writePrefs,
  type SidebarPrefs,
} from "./ui/prefs.ts";

const PANEL_NAME = "xerj.stats";
const FALLBACK_POLL_MS = 30_000;
const SEARCH_CLIP = 6_000;
/** A busy turn emits several updates; one render per burst is enough. */
const REFRESH_DEBOUNCE_MS = 150;
/** The TUI half has no log ring; a failed preference write is invisible. */
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  entries: async () => [],
  flush: async () => {},
} as const;

interface TuiState {
  lines: string[];
  ready: boolean;
  snapshot: StatusSnapshot | null;
  reason: string | null;
}

export default Plugin.define({
  id: "xerj.tui",
  setup(context) {
    // Read the client on every call: the host replaces it after a server
    // restart, and a captured sub-client then fails without sending anything.
    const rpc = () => context.client.rpc(XerjRpc);
    const [state, update] = context.storage.memory<TuiState>("status", {
      initial: {
        lines: ["XERJ  ○ starting"],
        ready: false,
        snapshot: null,
        reason: null,
      },
    });

    // The RPC lookup is per location; without one the server reports the RPC as
    // unavailable even though this project's copy is registered.
    const at = () =>
      context.location ? { location: context.location } : undefined;

    // The controller lives here, not in the component: the host unmounts and
    // remounts `sidebar.content` when the user switches views, and a signal
    // created inside the component body would reset on the way back.
    let prefs: SidebarPrefs = DEFAULT_PREFS;
    const [collapsed, setCollapsed] = createSignal(false);
    // Elapsed figures on a running job are read from this clock; the ticker
    // below moves it once a second only while something is running.
    const [clock, setClock] = createSignal(Date.now());
    void readPrefs()
      .then((loaded) => {
        prefs = loaded;
        setCollapsed(seedCollapsed(loaded));
      })
      .catch(() => {
        // A broken shared prefs file must not stop the sidebar from rendering.
      });

    const toggleCollapsed = (): void => {
      const next = !collapsed();
      setCollapsed(next);
      if (prefs.rememberCollapsed) {
        void writePrefs({ collapsed: next }, silentLogger);
      }
    };

    const abort = new AbortController();
    let inFlight = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    // Subscriptions do not survive a server restart, so they are re-armed
    // against the current client after each successful poll.
    const resubscribe = (): void => {
      if (disposed || unsubscribe) return;
      unsubscribe = subscribe(rpc(), () => scheduleRefresh(), abort.signal);
    };

    const unsubscribeEvents = (): void => {
      unsubscribe?.();
      unsubscribe = null;
    };

    /** Coalesces a burst of events into one status call. */
    const scheduleRefresh = (): void => {
      if (refreshTimer !== null) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    const refresh = async (): Promise<void> => {
      if (disposed || inFlight) return;
      inFlight = true;

      try {
        const snapshot = (await rpc().status({}, at())) as StatusSnapshot;
        update((draft) => {
          draft.snapshot = snapshot;
          draft.lines = sidebarLines(snapshot, Date.now());
          draft.ready = snapshot.node.phase === "ready";
          draft.reason = null;
        });
        setClock(Date.now());
        resubscribe();
      } catch (error) {
        const reason = describe(error);
        unsubscribeEvents();
        update((draft) => {
          draft.snapshot = null;
          draft.reason = reason;
          draft.lines = ["XERJ  ○ offline", reason];
          draft.ready = false;
        });
      } finally {
        inFlight = false;
      }
    };

    const showStatus = async (): Promise<void> => {
      await refresh();
      // Re-running the command closes the panel it opened.
      if (context.ui.panel.current()?.name === PANEL_NAME) {
        context.ui.panel.close();
        return;
      }
      if (context.ui.panel.open(PANEL_NAME)) return;

      await context.ui.dialog.alert({
        title: "XERJ",
        message: statusText(state.snapshot, state.lines),
      });
    };

    const wrapup = async (): Promise<void> => {
      try {
        // The host owns compaction; this asks it to run now. Nothing is
        // rewritten by this plugin.
        const result = (await rpc().wrapup({}, at())) as {
          compacted?: boolean;
          detail?: string;
        };
        context.ui.toast.show({
          message: result.compacted
            ? "XERJ · the host compacted this session"
            : `XERJ · ${result.detail ?? "compaction did not run"}`,
          variant: result.compacted ? "success" : "info",
        });
      } catch (error) {
        context.ui.toast.show({
          message: `XERJ wrapup failed: ${describe(error)}`,
          variant: "error",
        });
      }
    };

    const reindex = async (): Promise<void> => {
      try {
        // The RPC awaits the pass, so a result means the index is current.
        const result = (await rpc().reindex({}, at())) as {
          queued?: boolean;
          records?: number | null;
        };
        const message = !result.queued
          ? "XERJ indexing is disabled"
          : typeof result.records === "number"
            ? `XERJ reindexed · ${result.records.toLocaleString("en-US")} records`
            : "XERJ reindex queued";
        context.ui.toast.show({
          message,
          variant: result.queued ? "success" : "info",
        });
      } catch (error) {
        context.ui.toast.show({
          message: `XERJ is not available: ${describe(error)}`,
          variant: "error",
        });
      }
    };

    const promptFor = async (title: string, description: string): Promise<string> => {
      const answer = await context.ui.dialog.prompt({ title, description });
      return answer?.trim() ?? "";
    };

    const remember = async (prefill?: string): Promise<void> => {
      const text =
        prefill?.trim() ||
        (await promptFor("Remember in XERJ", "Durable fact or decision"));
      if (!text) return;

      try {
        const result = (await rpc().remember({ text }, at())) as {
          id: string;
          created: boolean;
        };
        context.ui.toast.show({
          message: result.created
            ? `Remembered as ${result.id}`
            : `Already remembered as ${result.id}`,
          variant: result.created ? "success" : "info",
        });
      } catch (error) {
        context.ui.toast.show({
          message: `XERJ remember failed: ${describe(error)}`,
          variant: "error",
        });
      }
    };

    const prjdocs = async (prefill?: string): Promise<void> => {
      // `eager` is opt-in per run: it removes the crawl limits, so it should be
      // a deliberate choice rather than what happens by accident.
      const eager = (prefill ?? "").trim().toLowerCase().includes("eager");
      context.ui.toast.show({
        message: eager
          ? "XERJ is reading documentation (eager)…"
          : "XERJ is reading official documentation…",
        variant: "info",
      });
      try {
        const result = (await rpc().prjdocs(
          eager ? { eager: true } : {},
          at(),
        )) as {
          techs?: string[];
          targets?: number;
          indexed?: number;
          skipped?: number;
          pruned?: number;
          failed?: number;
        };
        const indexed = result.indexed ?? 0;
        const skipped = result.skipped ?? 0;
        const pruned = result.pruned ?? 0;
        const failed = result.failed ?? 0;
        const techs = result.techs?.length ?? 0;
        context.ui.toast.show({
          message:
            `XERJ project docs · ${techs} technologies · ` +
            `${indexed.toLocaleString("en-US")} pages indexed · ` +
            `${skipped.toLocaleString("en-US")} unchanged · ` +
            `${pruned.toLocaleString("en-US")} pruned` +
            (failed > 0 ? ` · ${failed} failed` : ""),
          variant: failed > 0 ? "info" : "success",
        });
      } catch (error) {
        context.ui.toast.show({
          message: `XERJ project docs failed: ${describe(error)}`,
          variant: "error",
        });
      }
    };

    const sysdocs = async (): Promise<void> => {
      context.ui.toast.show({
        message: "XERJ is reading system documentation…",
        variant: "info",
      });
      try {
        const result = (await rpc().sysdocs({}, at())) as {
          discovered?: number;
          indexed?: number;
          skipped?: number;
          pruned?: number;
          failed?: number;
        };
        const indexed = result.indexed ?? 0;
        const skipped = result.skipped ?? 0;
        const pruned = result.pruned ?? 0;
        const failed = result.failed ?? 0;
        context.ui.toast.show({
          message:
            `XERJ system docs · ${indexed.toLocaleString("en-US")} indexed · ` +
            `${skipped.toLocaleString("en-US")} unchanged · ` +
            `${pruned.toLocaleString("en-US")} pruned` +
            (failed > 0 ? ` · ${failed} failed` : ""),
          variant: failed > 0 ? "info" : "success",
        });
      } catch (error) {
        context.ui.toast.show({
          message: `XERJ system docs failed: ${describe(error)}`,
          variant: "error",
        });
      }
    };

    const search = async (prefill?: string): Promise<void> => {
      const query =
        prefill?.trim() ||
        (await promptFor("Search XERJ", "What to look for"));
      if (!query) return;

      try {
        const result = (await rpc().search({ query }, at())) as {
          text: string;
          hits: number;
          bytes: number;
        };
        await context.ui.dialog.alert({
          title: [
            "XERJ search",
            `${result.hits} ${result.hits === 1 ? "hit" : "hits"}`,
          ].join(" · "),
          message:
            result.hits === 0 ? "No passages matched." : clip(result.text),
        });
      } catch (error) {
        context.ui.toast.show({
          message: `XERJ search failed: ${describe(error)}`,
          variant: "error",
        });
      }
    };

    void refresh();
    // Events arrive on the first success; the timer covers host or node gaps.
    const timer = setInterval(() => void refresh(), FALLBACK_POLL_MS);
    // A running job counts up without an RPC per second. Nothing ticks when
    // the service is idle, so a settled sidebar does no work.
    const ticker = setInterval(() => {
      if ((state.snapshot?.state.jobs.length ?? 0) > 0) setClock(Date.now());
    }, 1000);

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "xerj.status",
          title: "XERJ status",
          description: "Open the XERJ details panel",
          group: "XERJ",
          palette: true,
          slash: { name: "xerj", arguments: true },
          run: async (input) => {
            const text = (input ?? "").trim();
            if (text.length === 0 || text === "status") return showStatus();

            const [head, ...rest] = text.split(/\s+/);
            const argument = rest.join(" ").trim();

            if (head === "reindex") return reindex();
            if (head === "remember") return remember(argument);
            if (head === "search") return search(argument);

            context.ui.toast.show({
              message: `Unknown XERJ command: ${head}`,
              variant: "warning",
            });
          },
        },
        {
          id: "xerj.close",
          title: "Close XERJ panel",
          description: "Close the XERJ details panel",
          group: "XERJ",
          bind: "escape",
          enabled: () => context.ui.panel.current()?.name === PANEL_NAME,
          run: () => context.ui.panel.close(),
        },
        {
          id: "xerj.reindex",
          title: "XERJ reindex",
          description: "Queue an incremental reindex of this project",
          group: "XERJ",
          palette: true,
          slash: { name: "xerj-reindex" },
          enabled: () => state.ready,
          run: () => reindex(),
        },
        {
          id: "xerj.wrapup",
          title: "XERJ wrap up",
          description: "Ask the host to compact this session now",
          group: "XERJ",
          palette: true,
          slash: { name: "xerj-wrapup" },
          enabled: () => state.ready,
          run: () => wrapup(),
        },
        {
          id: "xerj.prjdocs",
          title: "XERJ project docs",
          description:
            "Index official docs for this project's languages, frameworks, and cloud APIs; keywords add terms the project does not use yet",
          group: "XERJ",
          palette: true,
          slash: { name: "xerj-prjdocs", arguments: true },
          enabled: () => state.ready,
          run: (input) => prjdocs(input),
        },
        {
          id: "xerj.sysdocs",
          title: "XERJ system docs",
          description:
            "Index this machine's man and info pages, skipping unchanged ones",
          group: "XERJ",
          palette: true,
          slash: { name: "xerj-sysdocs" },
          enabled: () => state.ready,
          run: () => sysdocs(),
        },
        {
          id: "xerj.remember",
          title: "XERJ remember",
          description: "Store a durable project fact in XERJ memory",
          group: "XERJ",
          palette: true,
          slash: { name: "xerj-remember", arguments: true },
          enabled: () => state.ready,
          run: (input) => remember(input),
        },
        {
          id: "xerj.search",
          title: "XERJ search",
          description: "Search the project index and show cited passages",
          group: "XERJ",
          palette: true,
          slash: { name: "xerj-search", arguments: true },
          enabled: () => state.ready,
          run: (input) => search(input),
        },
      ],
    }));

    const detachSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const snapshot = state.snapshot;
        if (snapshot === null) {
          return (
            <box flexDirection="column">
              <text fg={context.theme.text.muted}>{state.lines[0]}</text>
              <text fg={context.theme.text.faint}>{state.lines[1] ?? ""}</text>
            </box>
          );
        }

        const view = sidebarView(snapshot, clock(), prefs.sections);
        const toneColor = (tone: SidebarRow["tone"]) =>
          tone === "bad"
            ? context.theme.text.feedback.error.base
            : tone === "warn"
              ? context.theme.text.feedback.warning.base
              : context.theme.text.muted;

        const row = (entry: SidebarRow) => (
          <box width="100%" flexDirection="row" justifyContent="space-between">
            <text fg={context.theme.text.muted}>{entry.label}</text>
            <text fg={toneColor(entry.tone)}>{entry.value}</text>
          </box>
        );

        // Plain conditionals and `.map` rather than `Show`/`For`: the render
        // bodies are pure functions of a signal, and plain JavaScript is both
        // simpler and testable without a live renderer.
        const trouble = snapshot.index.lastError ?? snapshot.warnings[0] ?? null;

        return (
          <box
            width="100%"
            flexDirection="column"
            border
            borderColor={context.theme.border.base}
            paddingLeft={1}
            paddingRight={1}
          >
            <box
              flexDirection="row"
              justifyContent="space-between"
              alignItems="center"
              onMouseDown={() => toggleCollapsed()}
            >
              <box flexDirection="row" alignItems="center" gap={1}>
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={context.theme.background.raised.base}
                >
                  <text fg={context.theme.text.base}>
                    <b>
                      {collapsed() ? "▶ " : "▼ "}
                      {prefs.headerLabel}
                    </b>
                  </text>
                </box>
                <text fg={context.theme.text.muted}>{view.badge}</text>
              </box>
              {prefs.showVersion ? (
                <text fg={context.theme.text.faint}>v{view.version}</text>
              ) : null}
            </box>

            {trouble === null ? null : (
              <text fg={context.theme.text.feedback.warning.base}>⚠ {trouble}</text>
            )}

            {collapsed()
              ? view.collapsed.map(row)
              : [
                  ...view.sections.map((section) => (
                    <box flexDirection="column" marginTop={1}>
                      <text fg={context.theme.text.base}>
                        <b>{section.title}</b>
                      </text>
                      {section.rows.map(row)}
                    </box>
                  )),
                  <box marginTop={1}>
                    <text fg={context.theme.text.faint}>▸ /xerj for details</text>
                  </box>,
                ]}
          </box>
        );
      },
    });

    const detachPanel = context.ui.slot({
      append: "session.panel",
      render: (input) => {
        if (input.name !== PANEL_NAME) return null;

        const snapshot = state.snapshot;
        const sections = snapshot ? panelSections(snapshot, clock()) : [];

        return (
          <box flexDirection="column">
            <scrollbox flexDirection="column">
              {sections.map((section) => (
                <box flexDirection="column" marginBottom={1}>
                  <text fg={context.theme.text.base}>{section.title}</text>
                  {section.lines.map((line) => (
                    <text fg={context.theme.text.muted}>{line}</text>
                  ))}
                </box>
              ))}
              {sections.length === 0 ? (
                <text fg={context.theme.text.faint}>
                  {state.reason ?? "waiting for the XERJ server part"}
                </text>
              ) : null}
            </scrollbox>
            <box
              flexDirection="row"
              justifyContent="space-between"
              marginTop={1}
            >
              <text fg={context.theme.text.faint}>esc or /xerj closes</text>
              <box
                border
                borderColor={context.theme.border.base}
                paddingLeft={1}
                paddingRight={1}
                onMouseDown={() => input.close()}
              >
                <text fg={context.theme.text.base}>✕ close</text>
              </box>
            </box>
          </box>
        );
      },
    });

    return () => {
      disposed = true;
      abort.abort();
      clearInterval(timer);
      clearInterval(ticker);
      unsubscribeEvents();
      detachPanel();
      detachSidebar();
    };
  },
});

type EventSource = {
  events?: {
    on?: (
      name: "updated",
      handler: () => void,
      options: { signal: AbortSignal },
    ) => () => void;
  };
};

function subscribe(
  rpc: EventSource,
  handler: () => void,
  signal: AbortSignal,
): () => void {
  try {
    return rpc.events?.on?.("updated", handler, { signal }) ?? (() => {});
  } catch {
    return () => {};
  }
}

function statusText(
  snapshot: StatusSnapshot | null,
  lines: ReadonlyArray<string>,
): string {
  if (!snapshot) return lines.join("\n");

  return panelSections(snapshot, Date.now())
    .flatMap((section) => [section.title, ...section.lines])
    .join("\n");
}

// Short, single-line failure reason for the sidebar and the empty panel.
function describe(error: unknown): string {
  // The RPC client rejects with a plain `{ type, message }` object, not an
  // `Error`, so both shapes have to be read.
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : String(error);
  const first = raw.split("\n")[0]?.trim();
  if (!first) return "the XERJ server part did not answer";
  return first.length > 72 ? `${first.slice(0, 71)}…` : first;
}

function clip(text: string): string {
  if (text.length <= SEARCH_CLIP) return text;
  return `${text.slice(0, SEARCH_CLIP)}\n…`;
}
