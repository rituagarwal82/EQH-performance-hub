import { uiMessage } from "@/lib/error-copy";
import { useQueryClient } from "@tanstack/react-query";
import { Database } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Every hand-run data job on one menu.
 *
 * These are the only buttons on the product that change data, so they are kept
 * together, off the reading surface, and behind a dialog that says in full
 * sentences what is about to run. Afterwards the screen re-reads its queries —
 * it never reloads the page out from under the reader.
 */
export type DataAction = {
  key: string;
  label: string;
  /** One sentence shown in the menu. */
  description: string;
  /** When set, the action asks first, in these words. */
  confirm?: string | undefined;
  /**
   * When set, the action also makes the reader type this exact phrase. Reserved
   * for the few actions that can lose data rather than just re-read it.
   */
  typeToConfirm?: string | undefined;
  /** Returns the sentence to show on success. */
  run: () => Promise<string>;
};

export function DataMenu({ actions }: { actions: DataAction[] }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<DataAction | null>(null);
  const [running, setRunning] = useState(false);
  const [typed, setTyped] = useState("");
  const phrase = pending?.typeToConfirm;
  const unlocked = !phrase || typed.trim().toUpperCase() === phrase.toUpperCase();

  async function execute(action: DataAction) {
    setRunning(true);
    const id = toast.loading(`${action.label}…`);
    try {
      const message = await action.run();
      toast.success(message, { id });
      await qc.invalidateQueries();
    } catch (e) {
      toast.error(uiMessage(e, "that action"), { id });
    } finally {
      setRunning(false);
      setPending(null);
      setTyped("");
    }
  }

  if (actions.length === 0) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1.5 text-xs"
            disabled={running}
            aria-label="Data — refresh or re-import data"
            title="Data — refresh or re-import data"
          >
            <Database className="size-3.5" />
            Data
          </Button>

        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[300px]">
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
            These run against the live sources and can take minutes.
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {actions.map((a) => (
            <DropdownMenuItem
              key={a.key}
              onSelect={() => {
                if (a.confirm) setPending(a);
                else void execute(a);
              }}
              className="flex-col items-start gap-0.5"
            >
              <span className="text-[12px] font-medium">{a.label}</span>
              <span className="text-[11px] text-muted-foreground">{a.description}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (o) return;
          setPending(null);
          setTyped("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending?.label}</DialogTitle>
            <DialogDescription>{pending?.confirm}</DialogDescription>
          </DialogHeader>
          {phrase ? (
            <div className="space-y-1.5">
              <label htmlFor="confirm-phrase" className="text-[12px] text-muted-foreground">
                Type <span className="font-medium text-foreground">{phrase}</span> to continue.
              </label>
              <Input
                id="confirm-phrase"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={phrase}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPending(null);
                setTyped("");
              }}
              disabled={running}
            >
              Cancel
            </Button>
            <Button
              onClick={() => pending && void execute(pending)}
              disabled={running || !unlocked}
            >
              {running ? "Running…" : "Run it"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
