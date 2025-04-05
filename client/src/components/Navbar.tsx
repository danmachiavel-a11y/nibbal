import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { LayoutDashboard, Settings, BarChart, Users, Archive, Ban } from "lucide-react";

export function Navbar() {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/customers", label: "Customers", icon: Users },
    { href: "/transcripts", label: "Transcripts", icon: Archive },
    { href: "/stats", label: "Stats", icon: BarChart },
    { href: "/banned-users", label: "Banned Users", icon: Ban },
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <nav className="border-b">
      <div className="max-w-screen-xl mx-auto px-4">
        <div className="flex h-14 items-center space-x-4">
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
      </div>
    </nav>
  );
}