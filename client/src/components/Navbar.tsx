import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { LayoutDashboard, Settings, BarChart, Users, Archive, Ban, AlertTriangle, Shield } from "lucide-react";
import { ThemeToggle } from "@/components/ui/theme-toggle";

export function Navbar() {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/customers", label: "Customers", icon: Users },
    { href: "/transcripts", label: "Transcripts", icon: Archive },
    { href: "/stats", label: "Stats", icon: BarChart },
    { href: "/banned-users", label: "Banned Users", icon: Ban },
    { href: "/crash-logs", label: "Crash Logs", icon: AlertTriangle },
    { href: "/admin-roles", label: "Admin Roles", icon: Shield },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <nav className="border-b">
      <div className="max-w-screen-xl mx-auto px-4">
        <div className="flex h-14 items-center justify-between">
          <div className="flex space-x-4">
            {navItems.map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href}>
                <div //Added div to wrap the link, preventing nested <a> tags.
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors cursor-pointer", //Added cursor-pointer for better UX
                    location === href
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </div>
              </Link>
            ))}
          </div>
          <div className="flex items-center space-x-2">
            <ThemeToggle />
          </div>
        </div>
      </div>
    </nav>
  );
}