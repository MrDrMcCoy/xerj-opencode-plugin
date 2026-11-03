// TUI part: a live sidebar block, a details panel, and four commands. Every
// value comes over RPC from the server part, so the TUI never opens the node,
// reads the index, or touches the filesystem.

import { Plugin } from "@opencode/plugin/tui";
import { XerjRpc, type StatusSnapshot } from "./rpc.ts";
import { panelSections, sidebarLines } from "./ui/format.ts";

const PANEL_NAME = "xerj.stats";
const FALLBACK_POLL_MS = 30_000;
const SEARCH_CLIP = 6_000;

interface TuiState {
  lines: string[];
  ready: boolean;
  snapshot: StatusSnapshot | null;
}

export default Plugin.define({
  id: "xerj.tui",
  setup(context) {
    const rpc = context.client.rpc(XerjRpc);
    const [state, update] = context.storage.memory<TuiState>("status", {
      initial: { lines: ["XERJ  ○ starting"], ready: false, snapshot: null },
    });

    const abort = new AbortController();
    let inFlight = false;
    let disposed = false;

    const refresh = async (): Promise<void> => {
      if (disposed || inFlight) return;
      inFlight = true;

      try {
        const snapshot = (await rpc.status({})) as StatusSnapshot;
        update((draft) => {
          draft.snapshot = snapshot;
          draft.lines = sidebarLines(snapshot, Date.now());
          draft.ready = snapshot.node.phase === "ready";
        });
      } catch {
        update((draft) => {
          draft.snapshot = null;
          draft.lines = ["XERJ  ○ offline", "the server plugin is not loaded"];
          draft.ready = false;
        });
      } finally {
        inFlight = false;
      }
    };

    const showStatus = async (): Promise<void> => {
      await refresh();
      if (context.ui.panel.open(PANEL_NAME)) return;

      await context.ui.dialog.alert({
        title: "XERJ",
        message: statusText(state.snapshot, state.lines),
      });
    };

    const reindex = async (): Promise<void> => {
      try {
        const result = (await rpc.reindex({})) as { queued?: boolean };
        context.ui.toast.show({
          message: result.queued
            ? "XERJ reindex queued"
            : "XERJ indexing is disabled",
          variant: result.queued ? "success" : "info",
        });
      } catch {
        context.ui.toast.show({
          message: "XERJ is not available",
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
        const result = (await rpc.remember({ text })) as {
          id: string;
          created: boolean;
        };
        context.ui.toast.show({
          message: result.created
            ? `Remembered as ${result.id}`
            : `Already remembered as ${result.id}`,
          variant: result.created ? "success" : "info",
        });
      } catch {
        context.ui.toast.show({
          message: "XERJ memory is not available",
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
        const result = (await rpc.search({ query })) as {
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
      } catch {
        context.ui.toast.show({
          message: "XERJ search is not available",
          variant: "error",
        });
      }
    };

    void refresh();
    // A host without event support still gets the poll fallback.
    const off = subscribe(rpc, () => void refresh(), abort.signal);
    const timer = setInterval(() => void refresh(), FALLBACK_POLL_MS);

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
      render: () => (
        <box flexDirection="column">
          {state.lines.map((line) => {
            const color = line.startsWith("XERJ")
              ? context.theme.text.base
              : context.theme.text.muted;
            return <text fg={color}>{line}</text>;
          })}
        </box>
      ),
    });

    const detachPanel = context.ui.slot({
      append: "session.panel",
      render: (input) => {
        if (input.name !== PANEL_NAME) return null;

        const snapshot = state.snapshot;
        const sections = snapshot ? panelSections(snapshot, Date.now()) : [];

        return (
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
                waiting for the XERJ server part
              </text>
            ) : null}
          </scrollbox>
        );
      },
    });

    return () => {
      disposed = true;
      abort.abort();
      clearInterval(timer);
      off();
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

function clip(text: string): string {
  if (text.length <= SEARCH_CLIP) return text;
  return `${text.slice(0, SEARCH_CLIP)}\n…`;
}
