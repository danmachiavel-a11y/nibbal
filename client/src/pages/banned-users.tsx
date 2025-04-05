import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface BannedUser {
  id: number;
  username: string;
  telegramId: string;
  telegramUsername: string;
  telegramName: string;
  banReason: string;
  bannedAt: string;
  bannedBy: string;
}

export default function BannedUsersPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const queryClient = useQueryClient();

  const { data: bannedUsers, isLoading } = useQuery<BannedUser[]>({
    queryKey: ["/api/banned-users"],
    refetchInterval: 30000, // Refetch every 30 seconds
  });

  const unbanMutation = useMutation({
    mutationFn: (userId: number) => {
      return apiRequest("/api/unban-user", "POST", { userId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/banned-users"] });
      toast({
        title: "User unbanned",
        description: "The user has been unbanned successfully.",
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: "Failed to unban user. Please try again later.",
        variant: "destructive",
      });
      console.error("Failed to unban user:", error);
    },
  });

  const handleUnban = (userId: number) => {
    unbanMutation.mutate(userId);
  };

  const filteredUsers = bannedUsers
    ? bannedUsers.filter(
        (user) =>
          user.username?.toLowerCase().includes(searchTerm.toLowerCase()) ||
          user.telegramUsername?.toLowerCase().includes(searchTerm.toLowerCase()) ||
          user.telegramId?.includes(searchTerm) ||
          user.telegramName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
          user.banReason?.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : [];

  const formatDate = (dateString: string | null) => {
    if (!dateString) return "Unknown";
    try {
      return new Date(dateString).toLocaleString();
    } catch (e) {
      return dateString;
    }
  };

  return (
    <div className="container mx-auto py-6">
      <Card>
        <CardHeader>
          <CardTitle>Banned Users</CardTitle>
          <CardDescription>
            Manage users who have been banned from using the bot
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center space-x-2 mb-4">
            <Input
              placeholder="Search by name, Telegram ID, or reason..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="max-w-md"
            />
          </div>

          {isLoading ? (
            <div className="flex justify-center items-center h-40">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : bannedUsers?.length === 0 ? (
            <div className="text-center p-6 text-muted-foreground">
              No banned users found.
            </div>
          ) : (
            <Table>
              <TableCaption>
                {filteredUsers.length} banned {filteredUsers.length === 1 ? "user" : "users"}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Telegram Info</TableHead>
                  <TableHead>Ban Reason</TableHead>
                  <TableHead>Banned At</TableHead>
                  <TableHead>Banned By</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUsers.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.username || "Unknown"}</TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <div>
                          <span className="font-medium">ID:</span> {user.telegramId || "Unknown"}
                        </div>
                        <div>
                          <span className="font-medium">Name:</span>{" "}
                          {user.telegramName || "Unknown"}
                        </div>
                        <div>
                          <span className="font-medium">Username:</span>{" "}
                          {user.telegramUsername ? `@${user.telegramUsername}` : "None"}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{user.banReason || "No reason provided"}</TableCell>
                    <TableCell>{formatDate(user.bannedAt)}</TableCell>
                    <TableCell>{user.bannedBy || "System"}</TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        onClick={() => handleUnban(user.id)}
                        disabled={unbanMutation.isPending}
                      >
                        {unbanMutation.isPending ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Unbanning...
                          </>
                        ) : (
                          "Unban"
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}