import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Ticket, Message } from "@shared/schema";
import { Badge } from "@/components/ui/badge";

interface TicketWithMessages extends Ticket {
  messages: Message[];
}

export default function Transcripts() {
  const { data: closedTickets, isLoading } = useQuery<TicketWithMessages[]>({
    queryKey: ["/api/tickets/closed"],
  });

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 w-32 bg-gray-200 rounded"></div>
        <div className="h-64 bg-gray-200 rounded"></div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-8">
      <h1 className="text-3xl font-bold">Ticket Transcripts</h1>

      <Card>
        <CardHeader>
          <CardTitle>Closed Tickets</CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[600px]">
            <div className="space-y-4">
              {closedTickets?.map(ticket => (
                <div
                  key={ticket.id}
                  className="p-4 border rounded-lg space-y-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <div className="font-medium">Ticket #{ticket.id}</div>
                      <div className="text-sm text-muted-foreground">
                        Status: {ticket.status}
                      </div>
                      {ticket.amount && (
                        <Badge variant="outline" className="font-mono">
                          ${ticket.amount}
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    {ticket.messages.map((message, index) => (
                      <div
                        key={index}
                        className="text-sm p-2 rounded bg-muted/50"
                      >
                        <div className="font-medium">
                          {message.platform === "discord" ? "Discord" : "Telegram"}
                        </div>
                        <div>{message.content}</div>
                        <div className="text-xs text-muted-foreground">
                          {new Date(message.timestamp).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
