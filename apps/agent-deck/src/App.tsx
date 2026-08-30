import { Switch, Route } from "wouter";
import { useEffect } from "react";
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

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/oauth/callback" component={OAuthCallback} />
      <Route path="/playbook-patches" component={PlaybookPatchesPage} />
      <Route path="/feedback-signals" component={FeedbackSignalsPage} />
      <Route path="/mcp-test" component={McpTestPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  useEffect(() => {
    void bootstrapDashboardSession();
  }, []);

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
