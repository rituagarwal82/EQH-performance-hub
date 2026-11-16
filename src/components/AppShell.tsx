import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Building2,
  BadgeIndianRupee,
  BookOpen,
  ChevronsLeft,
  ChevronsRight,
  Gauge,
  Image as ImageIcon,
  ListChecks,
  LogOut,
  Menu,
  MessageSquare,
  Settings as SettingsIcon,
  ShieldCheck,
  TrendingUp,
  Users,
  CalendarDays,
  Compass,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";

import { useDensityMode } from "@/components/DensityProvider";
import { FreshnessBanner } from "@/components/FreshnessBanner";
import { DensitySwitch } from "@/components/RangeBar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { supabase } from "@/integrations/supabase/client";
import { feedHealthQuery, liveCount } from "@/lib/feed-health";

/** Screens that actually have a shorter view. Elsewhere the switch says so. */
const DENSITY_SCREENS = ["/", "/ads", "/creative", "/pages", "/show-up", "/sales", "/ask"];

function densityApplies(pathname: string) {
  return DENSITY_SCREENS.includes(pathname.replace(/\/$/, "") || "/");
}

function SignOutButton() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <button
      aria-label="Sign out of the engine"
      title="Sign out"
      onClick={async () => {
        await queryClient.cancelQueries();
        queryClient.clear();
        await supabase.auth.signOut();
        void navigate({ to: "/auth", replace: true });
      }}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <LogOut className="size-4" />
    </button>
  );
}


/**
 * Strict division of labour:
 *   sidebar = WHERE AM I   (never scrolls with content)
 *   top bar = WHAT AM I LOOKING AT (range, comparison, freshness, data jobs)
 *   density = HOW MUCH OF IT (Brief ⇄ Working, same on every screen)
 */
const GROUPS = [
  {
    // The agency comparison is the first question the owner asks each morning,
    // so it sits above everything else. Cohort return now lives inside it.
    label: "Agencies",
    items: [{ to: "/agencies", label: "Agencies", icon: Building2 }],
  },
  {
    label: "Daily",
    items: [
      { to: "/", label: "Today", icon: Gauge, exact: true },
      { to: "/weekly", label: "Weekly", icon: CalendarDays },
      { to: "/ask", label: "Ask", icon: MessageSquare },
    ],
  },

  {
    label: "The funnel",
    items: [
      { to: "/ads", label: "Ads", icon: TrendingUp },
      { to: "/creative", label: "Creative", icon: ImageIcon },
      { to: "/pages", label: "Pages", icon: ImageIcon },
      { to: "/show-up", label: "Show-up", icon: Users },
      { to: "/sales", label: "Sales", icon: BadgeIndianRupee },
      { to: "/sources", label: "Sources", icon: Compass },
      
    ],
  },
  {
    // One owner-facing answer. The three technical screens still exist, in
    // full, under "For the builder" at the bottom.
    label: "Trust",
    items: [{ to: "/confidence", label: "Can I trust the numbers?", icon: ShieldCheck }],
  },
  {
    label: "System",
    items: [
      { to: "/rules", label: "Decisions & rules", icon: BookOpen },
      { to: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
  {
    label: "For the builder",
    items: [
      { to: "/health", label: "Feed Health", icon: Activity },
      { to: "/trust", label: "Data Trust", icon: ShieldCheck },
      { to: "/queue", label: "Review Queue", icon: ListChecks },
    ],
  },
] as const;

const STORAGE_KEY = "eqh.sidebar.collapsed";

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  return (
    <nav className="flex-1 overflow-y-auto py-2">
      {GROUPS.map((group) => (
        <div key={group.label} className="mb-1.5">
          {collapsed ? (
            <div className="border-border mx-3 my-2 border-t" />
          ) : (
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {group.label}
            </div>
          )}
          {group.items.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                // The range you are reading follows you between screens.
                search={(prev: Record<string, unknown>) => prev}
                title={item.label}
                onClick={onNavigate}
                activeOptions={{ exact: "exact" in item ? item.exact : false }}
                activeProps={{
                  className: "bg-muted text-foreground border-l-primary font-semibold",
                }}
                inactiveProps={{ className: "text-muted-foreground border-l-transparent" }}
                className={`flex items-center gap-2.5 border-l-2 px-3 py-1.5 text-[13px] transition-colors hover:bg-muted hover:text-foreground ${
                  collapsed ? "justify-center" : ""
                }`}
              >
                <Icon className="size-4 shrink-0" />
                {collapsed ? null : <span className="truncate">{item.label}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function AppShell({ topBar, children }: { topBar?: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { density, setDensity } = useDensityMode();
  const pathname = useRouterState({ select: (s) => s.location.pathname });


  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);

  function toggle() {
    setCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Below 768px the sidebar is a sheet — a fixed 232px rail eats a phone. */}
      <aside
        className={`border-border fixed inset-y-0 left-0 z-20 hidden flex-col border-r bg-card transition-[width] md:flex ${
          collapsed ? "w-14" : "w-[232px]"
        }`}
      >
        <div className="border-border flex h-[52px] items-center gap-2 border-b px-3">
          {collapsed ? null : (
            <span className="truncate text-sm font-semibold tracking-tight">EQH Engine</span>
          )}
          <button
            onClick={toggle}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          </button>
        </div>

        <NavList collapsed={collapsed} />

        {collapsed ? null : <FeedFooter />}
      </aside>

      <div className={`transition-[padding] ${collapsed ? "md:pl-14" : "md:pl-[232px]"}`}>
        <FreshnessBanner />
        <div className="border-border sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
          <div className="flex h-[52px] items-center gap-3 overflow-x-auto px-3 md:px-5">
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger
                aria-label="Open navigation"
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
              >
                <Menu className="size-4" />
              </SheetTrigger>
              <SheetContent side="left" className="w-[232px] p-0">
                <SheetTitle className="border-border flex h-[52px] items-center border-b px-3 text-sm font-semibold">
                  EQH Engine
                </SheetTitle>
                <NavList collapsed={false} onNavigate={() => setSheetOpen(false)} />
              </SheetContent>
            </Sheet>
            {topBar}
            <div className={`flex items-center gap-2 ${topBar ? "shrink-0" : "ml-auto shrink-0"}`}>
              <DensitySwitch
                density={density}
                onChange={setDensity}
                available={densityApplies(pathname)}
              />
              <ThemeToggle />
              <SignOutButton />
            </div>

          </div>
        </div>
        <main>{children}</main>
      </div>
    </div>
  );
}

/**
 * Replaces the old claim that nothing here is estimated — it sat four feet
 * below a tile whose own badge said "modelled". A live count is checkable.
 */
function FeedFooter() {
  const { data } = useQuery(feedHealthQuery());
  const { total, live, notLive } = liveCount(data?.feeds);
  return (
    <Link
      to="/health"
      className="border-border block border-t px-3 py-2 text-[10px] leading-snug text-muted-foreground hover:text-foreground"
    >
      {total === 0 ? (
        "feed health unavailable"
      ) : (
        <>
          {total} feeds · {live} live
          {notLive > 0 ? <span className="text-warning"> · {notLive} not live</span> : null}
        </>
      )}
    </Link>
  );
}
