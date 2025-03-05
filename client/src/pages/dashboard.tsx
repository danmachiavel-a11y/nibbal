import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Category, Ticket } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { MessagesSquare, User, Clock, AlertCircle } from "lucide-react";
import { Link } from "wouter";
import { Settings } from "lucide-react";


export default function Dashboard() {
  const { data: categories } = useQuery<Category[]>({
    queryKey: ["/api/categories"]
  });

  const { data: tickets } = useQuery<Ticket[]>({
    queryKey: ["/api/tickets"],
  });

  if (!categories || !tickets) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Loading...</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-4 w-[100px] bg-muted rounded"></div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const activeTickets = tickets.filter(t => t.status !== "closed" && t.status !== "deleted");
  const unclaimedTickets = tickets.filter(t => t.status === "open");
  const averageResponseTime = "< 5 min"; // TODO: Calculate from actual data

  return (
    <div className="container mx-auto p-6 space-y-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Ticket Dashboard</h1>
        <Link href="/settings">
          <Button variant="outline">
            <Settings className="w-4 h-4 mr-2" />
            Settings
          </Button>
        </Link>
      </div>
      {/* Overview Statistics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Tickets</CardTitle>
            <MessagesSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeTickets.length}</div>
            <p className="text-xs text-muted-foreground">
              Across {categories.length} categories
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Unclaimed Tickets</CardTitle>
            <User className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{unclaimedTickets.length}</div>
            <p className="text-xs text-muted-foreground">
              Waiting for agent response
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg. Response Time</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{averageResponseTime}</div>
            <p className="text-xs text-muted-foreground">
              For first agent response
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Priority Tickets</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">0</div>
            <p className="text-xs text-muted-foreground">
              Require immediate attention
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Active Tickets */}
      <Card>
        <CardHeader>
          <CardTitle>Active Tickets</CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[600px]">
            <div className="space-y-4">
              {activeTickets.map(ticket => {
                const category = categories.find(c => c.id === ticket.categoryId);
                return (
                  <div
                    key={ticket.id}
                    className="flex items-center justify-between p-4 border rounded-lg"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">Ticket #{ticket.id}</span>
                        <Badge variant={
                          ticket.status === "open" ? "default" :
                          ticket.status === "claimed" ? "secondary" :
                          "outline"
                        }>
                          {ticket.status}
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {category?.name || "Unknown Category"}
                      </div>
                      {ticket.claimedBy && (
                        <div className="text-sm text-muted-foreground">
                          Claimed by: {ticket.claimedBy}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {ticket.amount && (
                        <Badge variant="outline" className="font-mono">
                          ${ticket.amount}
                        </Badge>
                      )}
                      <Button variant="outline" size="sm">
                        View Details
                      </Button>
                    </div>
                  </div>
                );
              })}

              {activeTickets.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  No active tickets
                </div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}