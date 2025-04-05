import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import Dashboard from "@/pages/dashboard";
import Settings from "@/pages/settings";
import Stats from "@/pages/stats";
import Customers from "@/pages/customers";
import Transcripts from "@/pages/transcripts";
import BannedUsers from "@/pages/banned-users";
import NotFound from "@/pages/not-found";
import { Navbar } from "@/components/Navbar";

function Router() {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="max-w-screen-xl mx-auto p-4">
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/customers" component={Customers} />
          <Route path="/transcripts" component={Transcripts} />
          <Route path="/settings" component={Settings} />
          <Route path="/stats" component={Stats} />
          <Route path="/banned-users" component={BannedUsers} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router />
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;