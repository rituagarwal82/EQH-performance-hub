import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // Sign-in is always required. The old app_settings.open_access build
    // switch is no longer consulted (security fix, 16 Nov 2026). Whether the
    // signed-in email may see data is decided on the server (owner_emails).
    const { data } = await supabase.auth.getUser();
    if (data.user) return { user: data.user };
    throw redirect({ to: "/auth" });
  },
  component: () => <Outlet />,
});
