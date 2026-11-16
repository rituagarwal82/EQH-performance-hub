import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Sign in to the Energy Queens Hub performance engine with a one-time code sent to your email.",
      },
      { property: "og:title", content: "Sign in — EQH Performance Engine" },
      {
        property: "og:description",
        content: "One-time code sign-in for the Energy Queens Hub performance engine.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const go = () =>
      void navigate({ to: "/", search: { range: "last7", compare: true }, replace: true });
    void supabase.auth.getUser().then(({ data }) => {
      if (data.user) go();
    });
    // The emailed link returns here with a session attached a moment later.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) go();
    });
    return () => sub.subscription.unsubscribe();
  }, [navigate]);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const { error: sendError } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${window.location.origin}/auth`,
      },
    });
    setBusy(false);
    if (sendError) {
      setError(
        sendError.message.toLowerCase().includes("signups not allowed")
          ? "That email address is not on the access list."
          : sendError.message,
      );
      return;
    }
    setStage("code");
    setMessage(
      "Email sent. Open it and click the sign-in link — that is all you need to do. If the email also shows a six-digit code, you can type it below instead.",
    );
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: code.trim(),
      type: "email",
    });
    setBusy(false);
    if (verifyError) {
      setError("That code did not work. Check it, or send a new one.");
      return;
    }
    void navigate({ to: "/", search: { range: "last7", compare: true }, replace: true });
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">EQH Performance Engine</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          We email you a sign-in link. Click it and you are in. No password.
        </p>
      </header>

      {stage === "email" ? (
        <form onSubmit={sendCode} className="flex flex-col gap-3">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="email">
            Email address
          </label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
          <Button type="submit" disabled={busy || !email}>
            {busy ? "Sending…" : "Email me a sign-in link"}
          </Button>
        </form>
      ) : (
        <form onSubmit={verify} className="flex flex-col gap-3">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="code">
            Sent to {email}. Click the link in that email to sign in — or type the
            six-digit code here if the email shows one.
          </label>
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            className="tabular-nums tracking-widest"
          />
          <Button type="submit" disabled={busy || code.length < 6}>
            {busy ? "Checking…" : "Sign in"}
          </Button>
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => {
              setStage("email");
              setCode("");
              setMessage(null);
            }}
          >
            Use a different email, or send a new code
          </button>
        </form>
      )}

      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </main>
  );
}
