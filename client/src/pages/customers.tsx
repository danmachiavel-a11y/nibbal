import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { User } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { SiTelegram, SiDiscord } from "react-icons/si";

interface UserWithStats extends User {
  paidTicketCount: number;
}

export default function Customers() {
  const { data: users, isLoading } = useQuery<UserWithStats[]>({
    queryKey: ["/api/users"],
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
      <h1 className="text-3xl font-bold">Customers</h1>

      <Card>
        <CardHeader>
          <CardTitle>Customer List</CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[600px]">
            <div className="space-y-4">
              {users?.map(user => (
                <div
                  key={user.id}
                  className="flex items-center justify-between p-4 border rounded-lg"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">User #{user.id}</span>
                      {user.isBanned && (
                        <Badge variant="destructive">
                          Banned
                        </Badge>
                      )}
                      {user.paidTicketCount > 0 && (
                        <Badge variant="secondary">
                          {user.paidTicketCount} Paid Tickets
                        </Badge>
                      )}
                    </div>
                    {user.discordId && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <SiDiscord className="h-4 w-4" />
                        {user.discordId}
                      </div>
                    )}
                    {user.telegramId && (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <SiTelegram className="h-4 w-4" />
                          ID: {user.telegramId}
                        </div>
                        {user.telegramUsername && (
                          <div className="text-sm text-muted-foreground pl-6">
                            Username: @{user.telegramUsername}
                          </div>
                        )}
                        {user.telegramName && (
                          <div className="text-sm text-muted-foreground pl-6">
                            Name: {user.telegramName}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {!users?.length && (
                <div className="text-center py-8 text-muted-foreground">
                  No customers found
                </div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}