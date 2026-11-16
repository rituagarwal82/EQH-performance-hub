import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { getAccessMode } from "@/lib/access.functions";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user) return { user: data.user };

    // Temporary build switch: when app_settings.open_access = 'true' the app
    // loads without signing in. When it is off, this call is rejected and we
    // fall through to the normal sign-in screen.
    try {
      const mode = await getAccessMode();
      if (mode.open) return { user: null };
    } catch {
      // locked — fall through
    }
    throw redirect({ to: "/auth" });
  },
  component: () => <Outlet />,
});
