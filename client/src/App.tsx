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
import CrashLogs from "@/pages/crash-logs";
import NotFound from "@/pages/not-found";
import { Navbar } from "@/components/Navbar";
import { useEffect, useState } from "react";

function Router() {
  // Theme handling (moved here for better SSR compatibility)
  const [mounted, setMounted] = useState(false);

  // This effect runs once after component mounts to avoid hydration mismatch
  useEffect(() => {
    // Check if theme is stored in localStorage
    const storedTheme = localStorage.getItem("theme") as "light" | "dark" | null;
    
    if (storedTheme === "dark") {
      document.documentElement.classList.add("dark");
    } else if (storedTheme === "light") {
      document.documentElement.classList.remove("dark");
    } else {
      // Check system preference
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (prefersDark) {
        document.documentElement.classList.add("dark");
      }
    }
    setMounted(true);
  }, []);

  // To avoid flash of incorrect theme, only render after mounted
  if (!mounted) {
    return <div className="min-h-screen bg-background"></div>;
  }

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
          <Route path="/crash-logs" component={CrashLogs} />
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