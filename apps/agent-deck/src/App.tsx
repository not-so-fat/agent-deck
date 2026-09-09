import { Switch, Route } from "wouter";
import { useEffect, useState } from "react";
import { queryClient } from "./lib/queryClient";
import { bootstrapDashboardSession } from "./lib/dashboard-bootstrap";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/home";
import NotFound from "@/pages/not-found";
import OAuthCallback from "@/components/oauth-callback";
import McpTestPage from "@/pages/mcp-test";
import PlaybookPatchesPage from "@/pages/playbook-patches";
import FeedbackSignalsPage from "@/pages/feedback-signals";
import AdminApprovePage from "@/pages/admin-approve";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/oauth/callback" component={OAuthCallback} />
      <Route path="/playbook-patches" component={PlaybookPatchesPage} />
      <Route path="/feedback-signals" component={FeedbackSignalsPage} />
      <Route path="/admin/approve" component={AdminApprovePage} />
      <Route path="/mcp-test" component={McpTestPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void bootstrapDashboardSession().finally(() => {
      if (!cancelled) {
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Wait for bootstrap cookie before any React Query fetch — otherwise first
  // paint races into GRANT_REQUIRED and sticks on Error Loading Data.
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0B1220] text-sm text-gray-300">
        Loading AgentDeck...
      </div>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
