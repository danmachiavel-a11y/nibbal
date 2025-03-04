import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Settings } from "lucide-react";
import type { Category, Ticket } from "@shared/schema";

export default function Dashboard() {
  const { data: categories } = useQuery<Category[]>({
    queryKey: ["/api/categories"]
  });

  if (!categories) {
    return <div>Loading...</div>;
  }

  return (
    <div className="container mx-auto p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Ticket Dashboard</h1>
        <Link href="/settings">
          <Button variant="outline">
            <Settings className="w-4 h-4 mr-2" />
            Settings
          </Button>
        </Link>
      </div>

      <Tabs defaultValue={categories[0]?.id.toString()}>
        <TabsList>
          {categories.map(category => (
            <TabsTrigger key={category.id} value={category.id.toString()}>
              {category.name}
            </TabsTrigger>
          ))}
        </TabsList>

        {categories.map(category => (
          <TabsContent key={category.id} value={category.id.toString()}>
            <TicketList categoryId={category.id} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function TicketList({ categoryId }: { categoryId: number }) {
  const { data: tickets } = useQuery<Ticket[]>({
    queryKey: ["/api/tickets", categoryId],
    queryFn: async () => {
      const res = await fetch(`/api/tickets?categoryId=${categoryId}`);
      return res.json();
    }
  });

  if (!tickets) {
    return <div>Loading tickets...</div>;
  }

  return (
    <ScrollArea className="h-[600px]">
      <div className="space-y-4">
        {tickets.map(ticket => (
          <Card key={ticket.id}>
            <CardHeader>
              <CardTitle className="text-lg">
                Ticket #{ticket.id}
                <span className={`ml-2 text-sm ${
                  ticket.status === "open" ? "text-green-500" :
                  ticket.status === "claimed" ? "text-blue-500" :
                  "text-gray-500"
                }`}>
                  {ticket.status}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div>Status: {ticket.status}</div>
                {ticket.amount && <div>Amount: ${ticket.amount}</div>}
                {ticket.claimedBy && <div>Claimed by: {ticket.claimedBy}</div>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </ScrollArea>
  );
}
