import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Category, Ticket, User } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { MessagesSquare, MessageSquare, User as UserIcon, Clock, AlertCircle, ClipboardList, Search as SearchIcon, ChevronDown, ChevronRight, CircleDollarSign, Tag, SlidersHorizontal, PanelRight, Calendar } from "lucide-react";
import { Link } from "wouter";
import { Settings } from "lucide-react";
import { useState, useMemo } from "react";
import { Search } from "@/components/ui/search";
import { SiTelegram, SiDiscord } from "react-icons/si";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";

// Enhanced ticket type with user information
interface EnhancedTicket extends Ticket {
  category: Category | null;
  user: User | null;
  displayName: string;
  platform: "telegram" | "discord" | "unknown";
  formattedDate: string;
}

export default function Dashboard() {
  // State for filtering and viewing
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [expandedTickets, setExpandedTickets] = useState<number[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null);
  
  // Fetch data
  const { data: categories, isLoading: loadingCategories } = useQuery<Category[]>({
    queryKey: ["/api/categories"]
  });

  const { data: tickets, isLoading: loadingTickets } = useQuery<Ticket[]>({
    queryKey: ["/api/tickets"],
  });
  
  const { data: users, isLoading: loadingUsers } = useQuery<User[]>({
    queryKey: ["/api/users"],
  });
  
  const isLoading = loadingCategories || loadingTickets || loadingUsers;

  // Handle toggling ticket expansion
  const toggleTicketExpanded = (ticketId: number) => {
    if (expandedTickets.includes(ticketId)) {
      setExpandedTickets(expandedTickets.filter(id => id !== ticketId));
    } else {
      setExpandedTickets([...expandedTickets, ticketId]);
    }
  };
  
  // Clear search
  const handleClearSearch = () => {
    setSearchQuery("");
  };
  
  // Reset all filters
  const resetFilters = () => {
    setSearchQuery("");
    setStatusFilter("all");
    setCategoryFilter(null);
  };

  // Process tickets with enhanced information
  const enhancedTickets = useMemo(() => {
    if (!tickets || !categories || !users) return [];
    
    return tickets.map(ticket => {
      const category = categories.find(c => c.id === ticket.categoryId) || null;
      const user = users.find(u => u.id === ticket.userId) || null;
      
      let displayName = `Unknown User`;
      let platform: "telegram" | "discord" | "unknown" = "unknown";
      
      if (user) {
        if (user.telegramUsername) {
          displayName = `@${user.telegramUsername}`;
          platform = "telegram";
        } else if (user.telegramName) {
          displayName = user.telegramName;
          platform = "telegram";
        } else if (user.discordId) {
          displayName = user.username || user.discordId;
          platform = "discord";
        } else {
          displayName = user.username;
        }
      }
      
      // Format the date nicely if available
      const formattedDate = ticket.completedAt 
        ? format(new Date(ticket.completedAt), 'MMM d, yyyy h:mm a')
        : "";
      
      return {
        ...ticket,
        category,
        user,
        displayName,
        platform,
        formattedDate
      };
    });
  }, [tickets, categories, users]);
  
  // Filter and sort active tickets
  const activeTickets = useMemo(() => {
    if (!enhancedTickets) return [];
    
    // First filter by active status
    let filtered = enhancedTickets.filter(t => 
      t.status !== "closed" && t.status !== "deleted"
    );
    
    // Then apply status filter if not 'all'
    if (statusFilter !== "all") {
      filtered = filtered.filter(t => t.status === statusFilter);
    }
    
    // Apply category filter if selected
    if (categoryFilter) {
      filtered = filtered.filter(t => t.categoryId === categoryFilter);
    }
    
    // Apply search query across multiple fields
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(ticket => {
        const searchableFields = [
          ticket.displayName.toLowerCase(),
          `Ticket #${ticket.id}`,
          ticket.category?.name?.toLowerCase() || "",
          ticket.claimedBy?.toLowerCase() || "",
          ticket.status.toLowerCase()
        ];
        
        return searchableFields.some(field => field.includes(query));
      });
    }
    
    // Sort by newest first (assuming ID is sequential)
    return filtered.sort((a, b) => b.id - a.id);
  }, [enhancedTickets, searchQuery, statusFilter, categoryFilter]);
  
  const unclaimedTickets = useMemo(() => {
    return enhancedTickets.filter(t => t.status === "open");
  }, [enhancedTickets]);
  
  const averageResponseTime = "< 5 min"; // TODO: Calculate from actual data

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-32 bg-gray-200 rounded"></div>
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
          <div className="h-[600px] bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
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
              Across {categories?.length || 0} categories
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Unclaimed Tickets</CardTitle>
            <UserIcon className="h-4 w-4 text-muted-foreground" />
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
        <CardHeader className="space-y-0">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4">
            <CardTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5" />
              <span>Active Tickets</span>
            </CardTitle>
            <Search
              placeholder="Search tickets..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onClear={handleClearSearch}
              className="w-full md:w-[300px]"
            />
          </div>
          
          {/* Filters */}
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Filters:</span>
            </div>
            
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-[120px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="claimed">Claimed</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
              </SelectContent>
            </Select>
            
            <Select 
              value={categoryFilter?.toString() || "all"} 
              onValueChange={(value) => setCategoryFilter(value === "all" ? null : parseInt(value))}
            >
              <SelectTrigger className="h-8 w-[150px]">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories?.map(category => (
                  <SelectItem key={category.id} value={category.id.toString()}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            <Button 
              variant="outline" 
              size="sm" 
              onClick={resetFilters}
              className="h-8"
            >
              Reset Filters
            </Button>
            
            {/* Results count */}
            <div className="ml-auto text-sm text-muted-foreground">
              Showing {activeTickets.length} ticket{activeTickets.length !== 1 ? 's' : ''}
              {searchQuery && <span> matching "{searchQuery}"</span>}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="detailed" className="w-full">
            <TabsList>
              <TabsTrigger value="detailed">
                <PanelRight className="h-4 w-4 mr-2" />
                Detailed View
              </TabsTrigger>
              <TabsTrigger value="compact">
                <Tag className="h-4 w-4 mr-2" />
                Compact View
              </TabsTrigger>
            </TabsList>
            
            <TabsContent value="detailed" className="mt-4">
              <ScrollArea className="h-[600px]">
                <div className="space-y-4">
                  {activeTickets.length === 0 ? (
                    <div className="text-center p-8 text-muted-foreground">
                      No active tickets found matching your criteria
                    </div>
                  ) : (
                    activeTickets.map(ticket => (
                      <Collapsible 
                        key={ticket.id}
                        open={expandedTickets.includes(ticket.id)}
                        onOpenChange={() => toggleTicketExpanded(ticket.id)}
                        className="border rounded-lg overflow-hidden"
                      >
                        <div className="p-4 bg-card">
                          <CollapsibleTrigger asChild>
                            <Button variant="ghost" className="w-full flex justify-between items-center p-0 h-auto hover:bg-transparent">
                              <div className="flex items-center gap-2 text-left">
                                <span className="font-medium">Ticket #{ticket.id}</span>
                                <Badge variant={
                                  ticket.status === "open" ? "default" :
                                  ticket.status === "claimed" ? "secondary" :
                                  ticket.status === "paid" ? "outline" :
                                  "outline"
                                }>
                                  {ticket.status}
                                </Badge>
                                
                                {ticket.category && (
                                  <Badge variant="outline" className="bg-muted/50">
                                    {ticket.category.name}
                                  </Badge>
                                )}
                                
                                {ticket.amount && (
                                  <Badge variant="outline" className="font-mono flex items-center gap-1">
                                    <CircleDollarSign className="h-3 w-3" />
                                    ${ticket.amount}
                                  </Badge>
                                )}
                                
                                {ticket.platform === "telegram" && (
                                  <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">
                                    <SiTelegram className="h-3 w-3 mr-1" />
                                    Telegram
                                  </Badge>
                                )}
                                
                                {ticket.platform === "discord" && (
                                  <Badge className="bg-indigo-500/10 text-indigo-500 border-indigo-500/20">
                                    <SiDiscord className="h-3 w-3 mr-1" />
                                    Discord
                                  </Badge>
                                )}
                              </div>
                              {expandedTickets.includes(ticket.id) ? 
                                <ChevronDown className="h-4 w-4" /> : 
                                <ChevronRight className="h-4 w-4" />
                              }
                            </Button>
                          </CollapsibleTrigger>
                        </div>
                        
                        <CollapsibleContent>
                          <div className="p-4 border-t space-y-4">
                            {/* Ticket and User Information */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <Card className="overflow-hidden shadow-none border">
                                <CardHeader className="p-3 bg-muted/50">
                                  <CardTitle className="text-base">Ticket Details</CardTitle>
                                </CardHeader>
                                <CardContent className="p-3 space-y-2">
                                  <div className="grid grid-cols-1 gap-1">
                                    <div className="flex justify-between">
                                      <span className="text-sm font-medium">Ticket ID:</span>
                                      <span className="text-sm">{ticket.id}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-sm font-medium">Status:</span>
                                      <span className="text-sm capitalize">{ticket.status}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-sm font-medium">Category:</span>
                                      <span className="text-sm">{ticket.category?.name || "Unknown"}</span>
                                    </div>
                                    {ticket.amount !== null && (
                                      <div className="flex justify-between">
                                        <span className="text-sm font-medium">Amount:</span>
                                        <span className="text-sm font-mono">${ticket.amount}</span>
                                      </div>
                                    )}
                                    {ticket.claimedBy && (
                                      <div className="flex justify-between">
                                        <span className="text-sm font-medium">Claimed By:</span>
                                        <span className="text-sm">{ticket.claimedBy}</span>
                                      </div>
                                    )}
                                    {ticket.formattedDate && (
                                      <div className="flex justify-between">
                                        <span className="text-sm font-medium">Completed:</span>
                                        <span className="text-sm">{ticket.formattedDate}</span>
                                      </div>
                                    )}
                                    {ticket.discordChannelId && (
                                      <div className="flex justify-between">
                                        <span className="text-sm font-medium">Discord Channel:</span>
                                        <span className="text-sm font-mono text-xs truncate max-w-[150px]">
                                          {ticket.discordChannelId}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                  
                                  <div className="flex justify-between items-center pt-2">
                                    <Link href={`/transcripts/${ticket.id}`}>
                                      <Button variant="outline" size="sm">
                                        View Transcript
                                      </Button>
                                    </Link>
                                    
                                    <div className="flex items-center gap-2">
                                      <Badge variant={
                                        ticket.status === "open" ? "default" :
                                        ticket.status === "claimed" ? "secondary" :
                                        ticket.status === "paid" ? "outline" :
                                        "outline"
                                      } className="capitalize">
                                        {ticket.status}
                                      </Badge>
                                      
                                      {ticket.completedAt && (
                                        <Badge variant="outline" className="flex items-center gap-1">
                                          <Calendar className="h-3 w-3" />
                                          <span>Completed</span>
                                        </Badge>
                                      )}
                                    </div>
                                  </div>
                                </CardContent>
                              </Card>
                              
                              {/* User Information Card */}
                              <Card className="overflow-hidden shadow-none border">
                                <CardHeader className="p-3 bg-muted/50">
                                  <CardTitle className="text-base">Customer Information</CardTitle>
                                </CardHeader>
                                <CardContent className="p-3 space-y-2">
                                  {ticket.user ? (
                                    <>
                                      <div className="grid grid-cols-1 gap-1">
                                        <div className="flex justify-between">
                                          <span className="text-sm font-medium">Name:</span>
                                          <span className="text-sm">{ticket.displayName}</span>
                                        </div>
                                        <div className="flex justify-between">
                                          <span className="text-sm font-medium">User ID:</span>
                                          <span className="text-sm">{ticket.user.id}</span>
                                        </div>
                                        {ticket.user.telegramUsername && (
                                          <div className="flex justify-between">
                                            <span className="text-sm font-medium">Telegram:</span>
                                            <span className="text-sm">@{ticket.user.telegramUsername}</span>
                                          </div>
                                        )}
                                        {ticket.user.telegramName && !ticket.user.telegramUsername && (
                                          <div className="flex justify-between">
                                            <span className="text-sm font-medium">Telegram Name:</span>
                                            <span className="text-sm">{ticket.user.telegramName}</span>
                                          </div>
                                        )}
                                        {ticket.user.telegramId && (
                                          <div className="flex justify-between">
                                            <span className="text-sm font-medium">Telegram ID:</span>
                                            <span className="text-sm font-mono text-xs">{ticket.user.telegramId}</span>
                                          </div>
                                        )}
                                        {ticket.user.discordId && (
                                          <div className="flex justify-between">
                                            <span className="text-sm font-medium">Discord ID:</span>
                                            <span className="text-sm font-mono text-xs">{ticket.user.discordId}</span>
                                          </div>
                                        )}
                                        {ticket.user.isBanned && (
                                          <div className="flex justify-between text-red-500">
                                            <span className="text-sm font-medium">Status:</span>
                                            <span className="text-sm">BANNED</span>
                                          </div>
                                        )}
                                      </div>
                                      
                                      <div className="flex items-center gap-2 pt-2">
                                        {ticket.user.telegramId && (
                                          <div className="flex items-center gap-1 text-sm text-muted-foreground bg-muted px-2 py-1 rounded">
                                            <SiTelegram className="h-4 w-4" />
                                            <span>Telegram</span>
                                          </div>
                                        )}
                                        {ticket.user.discordId && (
                                          <div className="flex items-center gap-1 text-sm text-muted-foreground bg-muted px-2 py-1 rounded">
                                            <SiDiscord className="h-4 w-4" />
                                            <span>Discord</span>
                                          </div>
                                        )}
                                        
                                        <Link href={`/customers?user=${ticket.user.id}`}>
                                          <Button variant="outline" size="sm" className="ml-auto">
                                            View Customer
                                          </Button>
                                        </Link>
                                      </div>
                                    </>
                                  ) : (
                                    <div className="text-center py-4 text-muted-foreground">
                                      No customer information available
                                    </div>
                                  )}
                                </CardContent>
                              </Card>
                            </div>
                            
                            {/* Question Answers Section (if available) */}
                            {ticket.answers && ticket.answers.length > 0 && (
                              <div>
                                <h3 className="text-sm font-medium mb-2">Customer Responses</h3>
                                <div className="space-y-2">
                                  {ticket.answers.map((answer, index) => (
                                    <div key={index} className="p-2 border rounded text-sm">
                                      {answer}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
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
                  {activeTickets.length === 0 ? (
                    <div className="text-center p-8 text-muted-foreground col-span-full">
                      No active tickets found matching your criteria
                    </div>
                  ) : (
                    activeTickets.map(ticket => (
                      <Card key={ticket.id} className="overflow-hidden">
                        <CardHeader className="p-3">
                          <CardTitle className="text-base flex items-center justify-between">
                            <div className="flex items-center gap-2 truncate">
                              <span className="truncate">Ticket #{ticket.id}</span>
                              
                              <Badge variant={
                                ticket.status === "open" ? "default" :
                                ticket.status === "claimed" ? "secondary" :
                                "outline"
                              } className="capitalize shrink-0">
                                {ticket.status}
                              </Badge>
                            </div>
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="p-3 pt-0">
                          <div className="flex items-center gap-2 mb-2">
                            {ticket.platform === "telegram" && (
                              <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">
                                <SiTelegram className="h-3 w-3 mr-1" />
                                Telegram
                              </Badge>
                            )}
                            
                            {ticket.platform === "discord" && (
                              <Badge className="bg-indigo-500/10 text-indigo-500 border-indigo-500/20">
                                <SiDiscord className="h-3 w-3 mr-1" />
                                Discord
                              </Badge>
                            )}
                            
                            {ticket.category && (
                              <Badge variant="outline" className="bg-muted/50">
                                {ticket.category.name}
                              </Badge>
                            )}
                            
                            {ticket.amount && (
                              <Badge variant="outline" className="font-mono">
                                ${ticket.amount}
                              </Badge>
                            )}
                          </div>
                          
                          <div className="flex items-center justify-between text-sm mb-3">
                            <span className="text-muted-foreground truncate max-w-[200px]">
                              {ticket.displayName}
                            </span>
                            {ticket.claimedBy && (
                              <span className="text-xs bg-muted px-2 py-1 rounded">
                                by {ticket.claimedBy}
                              </span>
                            )}
                          </div>
                          
                          <div className="flex items-center gap-2">
                            <Button 
                              variant="outline" 
                              size="sm" 
                              className="w-full"
                              onClick={() => toggleTicketExpanded(ticket.id)}
                            >
                              {expandedTickets.includes(ticket.id) ? "Hide Details" : "View Details"}
                            </Button>
                            
                            <Link href={`/transcripts/${ticket.id}`}>
                              <Button size="sm" variant="secondary">
                                <MessagesSquare className="h-4 w-4" />
                              </Button>
                            </Link>
                          </div>
                          
                          {expandedTickets.includes(ticket.id) && (
                            <div className="mt-3 pt-3 border-t space-y-2 text-sm">
                              {ticket.user && (
                                <>
                                  {ticket.user.telegramUsername && (
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">Username:</span>
                                      <span>@{ticket.user.telegramUsername}</span>
                                    </div>
                                  )}
                                  {ticket.user.telegramName && !ticket.user.telegramUsername && (
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">Name:</span>
                                      <span>{ticket.user.telegramName}</span>
                                    </div>
                                  )}
                                  <div className="flex justify-between">
                                    <span className="text-muted-foreground">ID:</span>
                                    <span className="font-mono text-xs">{ticket.user.telegramId || ticket.user.discordId}</span>
                                  </div>
                                </>
                              )}
                              
                              {ticket.claimedBy && (
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Claimed By:</span>
                                  <span>{ticket.claimedBy}</span>
                                </div>
                              )}
                              
                              {ticket.discordChannelId && (
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Channel:</span>
                                  <span className="font-mono text-xs truncate max-w-[150px]">{ticket.discordChannelId}</span>
                                </div>
                              )}
                              
                              {ticket.formattedDate && (
                                <div className="flex justify-between">
                                  <span className="text-muted-foreground">Completed:</span>
                                  <span>{ticket.formattedDate}</span>
                                </div>
                              )}
                              
                              <Link href={`/customers?user=${ticket.user?.id}`} className="block mt-2">
                                <Button variant="outline" size="sm" className="w-full">
                                  <UserIcon className="h-3 w-3 mr-2" />
                                  Customer Profile
                                </Button>
                              </Link>
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