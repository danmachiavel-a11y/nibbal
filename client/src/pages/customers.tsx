import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { User } from "@shared/schema";
import { Badge } from "@/components/ui/badge";

export default function Customers() {
  const { data: users, isLoading } = useQuery<User[]>({
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
                    <div className="font-medium">
                      User #{user.id}
                      {user.isBanned && (
                        <Badge variant="destructive" className="ml-2">
                          Banned
                        </Badge>
                      )}
                    </div>
                    {user.discordId && (
                      <div className="text-sm text-muted-foreground">
                        Discord: {user.discordId}
                      </div>
                    )}
                    {user.telegramId && (
                      <div className="text-sm text-muted-foreground">
                        Telegram: {user.telegramId}
                      </div>
                    )}
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
