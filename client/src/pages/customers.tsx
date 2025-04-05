import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { User } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { SiTelegram, SiDiscord } from "react-icons/si";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, User as UserIcon, Ticket, BellOff, CheckCircle, CircleDollarSign, Trash2, Ban, Check, AlertTriangle, X, Loader2 } from "lucide-react";
import { useState } from "react";
import { Search } from "@/components/ui/search";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiRequest } from "@/lib/queryClient";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { 
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";

// Category summary type
interface CategorySummary {
  categoryId: number;
  categoryName: string;
  count: number;
}

// Ticket statistics type
interface TicketStats {
  total: number;
  open: number;
  closed: number;
  paid: number;
  deleted: number;
}

// Enhanced user with additional information
interface UserWithStats extends User {
  displayName: string;
  ticketStats: TicketStats;
  categorySummary: CategorySummary[];
}

export default function Customers() {
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [expandedUsers, setExpandedUsers] = useState<number[]>([]);
  const [banReason, setBanReason] = useState<string>("");
  const [userToBan, setUserToBan] = useState<number | null>(null);
  
  const { toast } = useToast();
  
  const { data: users, isLoading } = useQuery<UserWithStats[]>({
    queryKey: ["/api/users"],
  });
  
  // Ban user mutation
  const banUserMutation = useMutation({
    mutationFn: ({ userId, banReason }: { userId: number; banReason: string }) => {
      return apiRequest("POST", "/api/ban-user", { 
        userId, 
        banReason,
        bannedBy: "Dashboard" 
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/banned-users"] });
      toast({
        title: "User banned",
        description: "The user has been banned successfully.",
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: "Failed to ban user. Please try again later.",
        variant: "destructive",
      });
      console.error("Failed to ban user:", error);
    },
  });
  
  // Unban user mutation
  const unbanUserMutation = useMutation({
    mutationFn: (userId: number) => {
      return apiRequest("POST", "/api/unban-user", { userId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
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
  
  // Handle ban user
  const handleBanUser = () => {
    if (userToBan) {
      banUserMutation.mutate({ 
        userId: userToBan, 
        banReason: banReason || "No reason provided" 
      });
      setUserToBan(null);
      setBanReason("");
    }
  };
  
  // Handle unban user
  const handleUnbanUser = (userId: number) => {
    unbanUserMutation.mutate(userId);
  };
  
  // Handle toggling user expansion
  const toggleUserExpanded = (userId: number) => {
    if (expandedUsers.includes(userId)) {
      setExpandedUsers(expandedUsers.filter(id => id !== userId));
    } else {
      setExpandedUsers([...expandedUsers, userId]);
    }
  };
  
  // Filter users based on search query
  const filteredUsers = users?.filter(user => {
    if (!searchQuery.trim()) return true;
    
    const query = searchQuery.toLowerCase();
    const searchableFields = [
      user.displayName.toLowerCase(),
      user.username.toLowerCase(),
      user.telegramUsername?.toLowerCase() || "",
      user.telegramName?.toLowerCase() || "",
      user.telegramId || "",
      user.discordId || ""
    ];
    
    return searchableFields.some(field => field.includes(query));
  });
  
  // Clear search
  const handleClearSearch = () => {
    setSearchQuery("");
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-4">
        <div className="h-8 w-32 bg-gray-200 rounded animate-pulse"></div>
        <div className="h-10 w-full bg-gray-200 rounded animate-pulse"></div>
        <div className="h-[600px] bg-gray-200 rounded animate-pulse"></div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h1 className="text-3xl font-bold">Customers</h1>
        <Search
          placeholder="Search customers..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onClear={handleClearSearch}
          className="w-full md:w-[300px]"
        />
      </div>
      
      {/* Results count */}
      <div className="text-sm text-muted-foreground">
        Showing {filteredUsers?.length || 0} customer{filteredUsers?.length !== 1 ? 's' : ''}
        {searchQuery && <span> matching "{searchQuery}"</span>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserIcon className="h-5 w-5" />
            <span>Customer Database</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="detailed" className="w-full">
            <TabsList>
              <TabsTrigger value="detailed">Detailed View</TabsTrigger>
              <TabsTrigger value="compact">Compact View</TabsTrigger>
            </TabsList>
            
            <TabsContent value="detailed" className="mt-4">
              <ScrollArea className="h-[600px]">
                <div className="space-y-4">
                  {filteredUsers?.length === 0 ? (
                    <div className="text-center p-8 text-muted-foreground">
                      No customers found matching your criteria
                    </div>
                  ) : (
                    filteredUsers?.map(user => (
                      <Collapsible 
                        key={user.id}
                        open={expandedUsers.includes(user.id)}
                        onOpenChange={() => toggleUserExpanded(user.id)}
                        className="border rounded-lg overflow-hidden"
                      >
                        <div className="p-4 bg-card">
                          <CollapsibleTrigger asChild>
                            <Button variant="ghost" className="w-full flex justify-between items-center p-0 h-auto hover:bg-transparent">
                              <div className="flex items-center gap-2 text-left">
                                <span className="font-medium">{user.displayName}</span>
                                {user.telegramUsername && user.telegramUsername !== user.displayName && (
                                  <span className="text-sm text-muted-foreground">(@{user.telegramUsername})</span>
                                )}
                                {user.isBanned && (
                                  <Badge variant="destructive">
                                    Banned
                                  </Badge>
                                )}
                                <Badge variant="outline" className="flex items-center gap-1">
                                  <Ticket className="h-3 w-3" />
                                  <span>{user.ticketStats.total} Ticket{user.ticketStats.total !== 1 ? 's' : ''}</span>
                                </Badge>
                                {user.ticketStats.paid > 0 && (
                                  <Badge variant="secondary" className="flex items-center gap-1">
                                    <CircleDollarSign className="h-3 w-3" />
                                    <span>{user.ticketStats.paid} Paid</span>
                                  </Badge>
                                )}
                                {user.ticketStats.open > 0 && (
                                  <Badge variant="default" className="flex items-center gap-1 bg-green-600">
                                    <span>{user.ticketStats.open} Active</span>
                                  </Badge>
                                )}
                              </div>
                              {expandedUsers.includes(user.id) ? 
                                <ChevronDown className="h-4 w-4" /> : 
                                <ChevronRight className="h-4 w-4" />
                              }
                            </Button>
                          </CollapsibleTrigger>
                        </div>
                        
                        <CollapsibleContent>
                          <div className="p-4 border-t space-y-4">
                            {/* User details section */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <Card className="overflow-hidden shadow-none border">
                                <CardHeader className="p-3 bg-muted/50">
                                  <CardTitle className="text-base">User Details</CardTitle>
                                </CardHeader>
                                <CardContent className="p-3 space-y-2">
                                  <div className="grid grid-cols-1 gap-1">
                                    <div className="flex justify-between">
                                      <span className="text-sm font-medium">User ID:</span>
                                      <span className="text-sm">{user.id}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-sm font-medium">Username:</span>
                                      <span className="text-sm">{user.username}</span>
                                    </div>
                                    {user.telegramName && (
                                      <div className="flex justify-between">
                                        <span className="text-sm font-medium">Telegram Name:</span>
                                        <span className="text-sm">{user.telegramName}</span>
                                      </div>
                                    )}
                                    {user.telegramUsername && (
                                      <div className="flex justify-between">
                                        <span className="text-sm font-medium">Telegram Username:</span>
                                        <span className="text-sm">@{user.telegramUsername}</span>
                                      </div>
                                    )}
                                    {user.telegramId && (
                                      <div className="flex justify-between">
                                        <span className="text-sm font-medium">Telegram ID:</span>
                                        <span className="text-sm">{user.telegramId}</span>
                                      </div>
                                    )}
                                    {user.discordId && (
                                      <div className="flex justify-between">
                                        <span className="text-sm font-medium">Discord ID:</span>
                                        <span className="text-sm">{user.discordId}</span>
                                      </div>
                                    )}
                                  </div>
                                  
                                  <div className="flex items-center gap-2 pt-2">
                                    {user.telegramId && (
                                      <div className="flex items-center gap-1 text-sm text-muted-foreground bg-muted px-2 py-1 rounded">
                                        <SiTelegram className="h-4 w-4" />
                                        <span>Telegram</span>
                                      </div>
                                    )}
                                    {user.discordId && (
                                      <div className="flex items-center gap-1 text-sm text-muted-foreground bg-muted px-2 py-1 rounded">
                                        <SiDiscord className="h-4 w-4" />
                                        <span>Discord</span>
                                      </div>
                                    )}
                                  </div>
                                </CardContent>
                              </Card>
                              
                              {/* Ticket statistics */}
                              <Card className="overflow-hidden shadow-none border">
                                <CardHeader className="p-3 bg-muted/50">
                                  <CardTitle className="text-base">Ticket Statistics</CardTitle>
                                </CardHeader>
                                <CardContent className="p-3">
                                  <div className="grid grid-cols-2 gap-2">
                                    <div className="flex items-center gap-2 p-2 rounded border">
                                      <Ticket className="h-4 w-4 text-primary" />
                                      <div>
                                        <div className="text-sm font-medium">Total</div>
                                        <div className="text-lg">{user.ticketStats.total}</div>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2 p-2 rounded border">
                                      <BellOff className="h-4 w-4 text-green-500" />
                                      <div>
                                        <div className="text-sm font-medium">Open</div>
                                        <div className="text-lg">{user.ticketStats.open}</div>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2 p-2 rounded border">
                                      <CheckCircle className="h-4 w-4 text-blue-500" />
                                      <div>
                                        <div className="text-sm font-medium">Closed</div>
                                        <div className="text-lg">{user.ticketStats.closed}</div>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2 p-2 rounded border">
                                      <CircleDollarSign className="h-4 w-4 text-yellow-500" />
                                      <div>
                                        <div className="text-sm font-medium">Paid</div>
                                        <div className="text-lg">{user.ticketStats.paid}</div>
                                      </div>
                                    </div>
                                    {user.ticketStats.deleted > 0 && (
                                      <div className="flex items-center gap-2 p-2 rounded border">
                                        <Trash2 className="h-4 w-4 text-red-500" />
                                        <div>
                                          <div className="text-sm font-medium">Deleted</div>
                                          <div className="text-lg">{user.ticketStats.deleted}</div>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </CardContent>
                              </Card>
                            </div>
                            
                            {/* Category breakdown section */}
                            {user.categorySummary.length > 0 && (
                              <div>
                                <Separator className="my-2" />
                                <h3 className="text-sm font-medium mb-2">Category Breakdown</h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                                  {user.categorySummary.map(category => (
                                    <div key={category.categoryId} className="flex justify-between items-center p-2 border rounded">
                                      <span className="text-sm">{category.categoryName || `Category #${category.categoryId}`}</span>
                                      <Badge variant="outline">{category.count} ticket{category.count !== 1 ? 's' : ''}</Badge>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            
                            {/* User actions card */}
                            <div>
                              <Separator className="my-2" />
                              <Card className="overflow-hidden shadow-none border">
                                <CardHeader className="p-3 bg-muted/50">
                                  <CardTitle className="text-base">User Actions</CardTitle>
                                </CardHeader>
                                <CardContent className="p-3">
                                  <div className="flex flex-wrap gap-2">
                                    {user.isBanned ? (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex items-center gap-2"
                                        onClick={() => handleUnbanUser(user.id)}
                                        disabled={unbanUserMutation.isPending}
                                      >
                                        {unbanUserMutation.isPending ? (
                                          <>
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            <span>Unbanning...</span>
                                          </>
                                        ) : (
                                          <>
                                            <Check className="h-4 w-4" />
                                            <span>Unban User</span>
                                          </>
                                        )}
                                      </Button>
                                    ) : (
                                      <AlertDialog>
                                        <AlertDialogTrigger asChild>
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            className="flex items-center gap-2 text-destructive border-destructive hover:bg-destructive hover:text-white"
                                          >
                                            <Ban className="h-4 w-4" />
                                            <span>Ban User</span>
                                          </Button>
                                        </AlertDialogTrigger>
                                        <AlertDialogContent>
                                          <AlertDialogHeader>
                                            <AlertDialogTitle>Ban {user.displayName}</AlertDialogTitle>
                                            <AlertDialogDescription>
                                              This will prevent the user from creating new tickets or sending messages.
                                              You can unban the user later if needed.
                                            </AlertDialogDescription>
                                          </AlertDialogHeader>
                                          <div className="py-4">
                                            <label htmlFor="banReason" className="text-sm font-medium block mb-2">
                                              Ban Reason (optional)
                                            </label>
                                            <Input
                                              id="banReason"
                                              placeholder="Enter reason for banning..."
                                              value={banReason}
                                              onChange={(e) => setBanReason(e.target.value)}
                                            />
                                          </div>
                                          <AlertDialogFooter>
                                            <AlertDialogCancel onClick={() => setBanReason("")}>Cancel</AlertDialogCancel>
                                            <AlertDialogAction
                                              className="bg-destructive hover:bg-destructive/90"
                                              onClick={() => {
                                                setUserToBan(user.id);
                                                handleBanUser();
                                              }}
                                              disabled={banUserMutation.isPending}
                                            >
                                              {banUserMutation.isPending ? (
                                                <>
                                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                                  <span>Banning...</span>
                                                </>
                                              ) : (
                                                <span>Ban User</span>
                                              )}
                                            </AlertDialogAction>
                                          </AlertDialogFooter>
                                        </AlertDialogContent>
                                      </AlertDialog>
                                    )}
                                  </div>
                                </CardContent>
                              </Card>
                            </div>
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    ))
                  )}
                </div>
              </ScrollArea>
            </TabsContent>
            
            <TabsContent value="compact" className="mt-4">
              <ScrollArea className="h-[600px]">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredUsers?.length === 0 ? (
                    <div className="text-center p-8 text-muted-foreground col-span-full">
                      No customers found matching your criteria
                    </div>
                  ) : (
                    filteredUsers?.map(user => (
                      <Card key={user.id} className="overflow-hidden">
                        <CardHeader className="p-3">
                          <CardTitle className="text-base flex items-center justify-between">
                            <div className="flex items-center gap-2 truncate">
                              <span className="truncate">{user.displayName}</span>
                              {user.isBanned && (
                                <Badge variant="destructive" className="shrink-0">
                                  Banned
                                </Badge>
                              )}
                            </div>
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="p-3 pt-0">
                          <div className="flex items-center gap-2 mb-2">
                            {user.telegramId && (
                              <Badge variant="outline" className="flex items-center gap-1">
                                <SiTelegram className="h-3 w-3" />
                              </Badge>
                            )}
                            {user.discordId && (
                              <Badge variant="outline" className="flex items-center gap-1">
                                <SiDiscord className="h-3 w-3" />
                              </Badge>
                            )}
                            {user.ticketStats.total > 0 && (
                              <Badge variant="secondary">
                                {user.ticketStats.total} Ticket{user.ticketStats.total !== 1 ? 's' : ''}
                              </Badge>
                            )}
                            {user.ticketStats.open > 0 && (
                              <Badge variant="default" className="bg-green-600">
                                {user.ticketStats.open} Active
                              </Badge>
                            )}
                          </div>
                          
                          <div className="flex gap-2 mb-2">
                            <Button 
                              variant="outline" 
                              size="sm" 
                              className="flex-1"
                              onClick={() => toggleUserExpanded(user.id)}
                            >
                              {expandedUsers.includes(user.id) ? "Hide Details" : "View Details"}
                            </Button>
                            
                            {user.isBanned ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="flex items-center gap-1"
                                onClick={() => handleUnbanUser(user.id)}
                                disabled={unbanUserMutation.isPending}
                              >
                                {unbanUserMutation.isPending ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Check className="h-4 w-4" />
                                )}
                              </Button>
                            ) : (
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="flex items-center gap-1 text-destructive"
                                  >
                                    <Ban className="h-4 w-4" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>Ban {user.displayName}</AlertDialogTitle>
                                    <AlertDialogDescription>
                                      This will prevent the user from creating new tickets or sending messages.
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <div className="py-4">
                                    <label htmlFor="banReasonCompact" className="text-sm font-medium block mb-2">
                                      Ban Reason (optional)
                                    </label>
                                    <Input
                                      id="banReasonCompact"
                                      placeholder="Enter reason for banning..."
                                      value={banReason}
                                      onChange={(e) => setBanReason(e.target.value)}
                                    />
                                  </div>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel onClick={() => setBanReason("")}>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      className="bg-destructive hover:bg-destructive/90"
                                      onClick={() => {
                                        setUserToBan(user.id);
                                        handleBanUser();
                                      }}
                                    >
                                      Ban User
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            )}
                          </div>
                          
                          {expandedUsers.includes(user.id) && (
                            <div className="mt-3 pt-3 border-t space-y-2 text-sm">
                              {user.telegramName && (
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Name:</span>
                                  <span>{user.telegramName}</span>
                                </div>
                              )}
                              {user.telegramUsername && (
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Username:</span>
                                  <span>@{user.telegramUsername}</span>
                                </div>
                              )}
                              <div className="flex justify-between">
                                <span className="text-muted-foreground">ID:</span>
                                <span className="font-mono text-xs">{user.telegramId || user.discordId}</span>
                              </div>
                              
                              <div className="grid grid-cols-4 gap-1 mt-2 pt-2 border-t">
                                <div className="text-center">
                                  <div className="text-xs text-muted-foreground">Total</div>
                                  <div className="font-medium">{user.ticketStats.total}</div>
                                </div>
                                <div className="text-center">
                                  <div className="text-xs text-muted-foreground">Open</div>
                                  <div className="font-medium">{user.ticketStats.open}</div>
                                </div>
                                <div className="text-center">
                                  <div className="text-xs text-muted-foreground">Closed</div>
                                  <div className="font-medium">{user.ticketStats.closed}</div>
                                </div>
                                <div className="text-center">
                                  <div className="text-xs text-muted-foreground">Paid</div>
                                  <div className="font-medium">{user.ticketStats.paid}</div>
                                </div>
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))
                  )}
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}