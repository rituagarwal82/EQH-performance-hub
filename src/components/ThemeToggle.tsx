import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Mode = "light" | "dark" | "system";
const KEY = "eqh.theme";
const MODES: Mode[] = ["light", "dark", "system"];
const ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const LABEL = { light: "Light", dark: "Dark", system: "Match my device" } as const;

function systemDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(mode: Mode) {
  const dark = mode === "dark" || (mode === "system" && systemDark());
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Light / dark / follow the device. The device option keeps listening, so a
 * screen that flips at sunset flips with it instead of staying where it was
 * when the page happened to load.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stored: Mode = "system";
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw === "light" || raw === "dark" || raw === "system") stored = raw;
    } catch {
      /* private browsing */
    }
    setMode(stored);
    setReady(true);
    apply(stored);
  }, []);

  useEffect(() => {
    if (!ready) return;
    apply(mode);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (mode === "system") apply("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode, ready]);

  function choose(next: Mode) {
    setMode(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      /* private browsing */
    }
  }

  return (
    <div className="border-border flex shrink-0 items-center rounded border p-0.5">
      {MODES.map((m) => {
        const Icon = ICON[m];
        return (
          <button
            key={m}
            type="button"
            onClick={() => choose(m)}
            aria-pressed={ready && mode === m}
            aria-label={LABEL[m]}
            title={LABEL[m]}
            className={`rounded px-1.5 py-1 transition-colors ${
              ready && mode === m
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
