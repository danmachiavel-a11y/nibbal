import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Ticket, Message } from "@shared/schema";
import { Badge } from "@/components/ui/badge";
import { useState, useMemo } from "react";
import { Search } from "@/components/ui/search";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronDown, ChevronRight, Search as SearchIcon, Tag, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { apiRequest } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";

interface TicketWithMessages extends Ticket {
  messages: Message[];
}

export default function Transcripts() {
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedTicket, setSelectedTicket] = useState<number | null>(null);
  const [openTickets, setOpenTickets] = useState<number[]>([]);
  const [ticketToDelete, setTicketToDelete] = useState<number | null>(null);
  
  const queryClient = useQueryClient();
  
  const { data: closedTickets, isLoading } = useQuery<TicketWithMessages[]>({
    queryKey: ["/api/tickets/closed"],
  });
  
  // Delete transcript mutation
  const deleteTranscriptMutation = useMutation({
    // Fix the TypeScript issues with proper typing
    mutationFn: async (transcriptId: number) => {
      return fetch(`/api/transcripts/${transcriptId}`, { 
        method: 'DELETE' 
      }).then(res => res.json());
    },
    onSuccess: () => {
      // Invalidate and refetch tickets
      queryClient.invalidateQueries({ queryKey: ["/api/tickets/closed"] });
      toast({
        title: "Success",
        description: `Transcript #${ticketToDelete} has been deleted`,
        variant: "default",
      });
      setTicketToDelete(null);
    },
    onError: (error) => {
      console.error("Error deleting transcript:", error);
      toast({
        title: "Error",
        description: "Could not delete transcript. Please try again.",
        variant: "destructive",
      });
    }
  });

  // Get unique categories from tickets
  const categories = useMemo(() => {
    return [...new Set(closedTickets?.map(ticket => ticket.categoryId))];
  }, [closedTickets]);

  // Filter tickets based on selected category and search query
  const filteredTickets = useMemo(() => {
    let tickets = closedTickets || [];
    
    // Apply category filter
    if (selectedCategory !== "all") {
      tickets = tickets.filter(ticket => ticket.categoryId?.toString() === selectedCategory);
    }
    
    // Apply search filter if query exists
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      tickets = tickets.filter(ticket => {
        // Search in ticket ID and status
        if (ticket.id.toString().includes(query) || 
            ticket.status.toLowerCase().includes(query)) {
          return true;
        }
        
        // Search in messages
        return ticket.messages.some(message => 
          message.content.toLowerCase().includes(query) ||
          // Safely check username property
          ((message as any).username?.toLowerCase()?.includes(query) || false) ||
          message.platform.toLowerCase().includes(query)
        );
      });
    }
    
    return tickets;
  }, [closedTickets, selectedCategory, searchQuery]);

  const handleClearSearch = () => {
    setSearchQuery("");
  };

  const toggleTicket = (ticketId: number) => {
    if (openTickets.includes(ticketId)) {
      setOpenTickets(openTickets.filter(id => id !== ticketId));
    } else {
      setOpenTickets([...openTickets, ticketId]);
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-4">
        <div className="flex justify-between items-center">
          <div className="h-8 w-32 bg-gray-200 rounded animate-pulse"></div>
          <div className="h-10 w-40 bg-gray-200 rounded animate-pulse"></div>
        </div>
        <div className="h-10 w-full bg-gray-200 rounded animate-pulse"></div>
        <div className="h-[600px] bg-gray-200 rounded animate-pulse"></div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-8">
      {/* Delete confirmation dialog */}
      <AlertDialog open={ticketToDelete !== null} onOpenChange={(open) => !open && setTicketToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Transcript</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete transcript #{ticketToDelete}? This action cannot be undone.
              All messages and data related to this transcript will be permanently removed from the database.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => {
                if (ticketToDelete) {
                  deleteTranscriptMutation.mutate(ticketToDelete);
                }
              }}
              disabled={deleteTranscriptMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteTranscriptMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      
      {/* Header with title, category filter */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <h1 className="text-3xl font-bold">Ticket Transcripts</h1>
        <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
          <Select
            value={selectedCategory}
            onValueChange={setSelectedCategory}
          >
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Select category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories?.map(categoryId => (
                <SelectItem key={categoryId} value={categoryId?.toString() ?? ""}>
                  Category #{categoryId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          
          <Search
            placeholder="Search transcripts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onClear={handleClearSearch}
            className="w-full sm:w-[250px]"
          />
        </div>
      </div>

      {/* Results count */}
      <div className="text-sm text-muted-foreground">
        Showing {filteredTickets.length} ticket{filteredTickets.length !== 1 ? 's' : ''}
        {searchQuery && <span> matching "{searchQuery}"</span>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SearchIcon className="h-5 w-5" />
            <span>Transcript Browser</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="list" className="w-full">
            <TabsList>
              <TabsTrigger value="list">List View</TabsTrigger>
              <TabsTrigger value="compact">Compact View</TabsTrigger>
            </TabsList>
            
            <TabsContent value="list" className="mt-4">
              <ScrollArea className="h-[600px]">
                <div className="space-y-4">
                  {filteredTickets.length === 0 ? (
                    <div className="text-center p-8 text-muted-foreground">
                      No tickets found matching your criteria
                    </div>
                  ) : (
                    filteredTickets.map(ticket => (
                      <Collapsible 
                        key={ticket.id}
                        open={openTickets.includes(ticket.id)}
                        onOpenChange={() => toggleTicket(ticket.id)}
                        className="border rounded-lg overflow-hidden"
                      >
                        <div className="p-4 bg-card">
                          <CollapsibleTrigger asChild>
                            <Button variant="ghost" className="w-full flex justify-between items-center p-0 h-auto hover:bg-transparent">
                              <div className="flex items-center gap-2 text-left">
                                <div className="font-medium">Ticket #{ticket.id}</div>
                                <Badge variant="outline">
                                  {ticket.status}
                                </Badge>
                                {ticket.amount && ticket.amount > 0 && (
                                  <Badge variant="outline" className="font-mono">
                                    ${ticket.amount}
                                  </Badge>
                                )}
                                <Badge variant="secondary" className="flex items-center gap-1">
                                  <Tag className="h-3 w-3" />
                                  <span>Category #{ticket.categoryId}</span>
                                </Badge>
                                <Badge variant="outline" className="ml-2">
                                  {ticket.messages.length} message{ticket.messages.length !== 1 ? 's' : ''}
                                </Badge>
                              </div>
                              {openTickets.includes(ticket.id) ? 
                                <ChevronDown className="h-4 w-4" /> : 
                                <ChevronRight className="h-4 w-4" />
                              }
                            </Button>
                          </CollapsibleTrigger>
                        </div>
                        
                        <CollapsibleContent>
                          <div className="p-4 space-y-2 border-t bg-card/50">
                            <div className="flex justify-end mb-4">
                              <Button 
                                variant="destructive" 
                                size="sm" 
                                className="flex items-center gap-1"
                                onClick={() => setTicketToDelete(ticket.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                                Delete Transcript
                              </Button>
                            </div>
                            {ticket.messages.map((message, index) => (
                              <div
                                key={index}
                                className="text-sm p-3 rounded bg-muted/50"
                              >
                                <div className="flex justify-between items-start">
                                  <div className="font-medium flex items-center gap-2">
                                    <Badge variant={message.platform === "discord" ? "default" : "secondary"} className="text-xs">
                                      {message.platform === "discord" ? "Discord" : "Telegram"}
                                    </Badge>
                                    {/* Use safer way to access username property */}
                                    <span>{(message as any).username || "Unknown"}</span>
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {new Date(message.timestamp).toLocaleString()}
                                  </div>
                                </div>
                                <div className="mt-2 whitespace-pre-wrap">{message.content}</div>
                              </div>
                            ))}
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
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {filteredTickets.length === 0 ? (
                    <div className="text-center p-8 text-muted-foreground col-span-2">
                      No tickets found matching your criteria
                    </div>
                  ) : (
                    filteredTickets.map(ticket => (
                      <Card key={ticket.id} className="overflow-hidden">
                        <CardHeader className="p-3">
                          <CardTitle className="text-base flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span>Ticket #{ticket.id}</span>
                              <Badge variant="outline" className="text-xs">
                                {ticket.status}
                              </Badge>
                            </div>
                            <Badge variant="secondary" className="text-xs">
                              Category #{ticket.categoryId}
                            </Badge>
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="p-3 pt-0">
                          <div className="text-sm text-muted-foreground mb-2">
                            {ticket.messages.length} message{ticket.messages.length !== 1 ? 's' : ''}
                          </div>
                          <div className="flex gap-2 mb-2">
                            <Button 
                              variant="outline" 
                              size="sm" 
                              className="flex-1"
                              onClick={() => toggleTicket(ticket.id)}
                            >
                              {openTickets.includes(ticket.id) ? "Hide Messages" : "View Messages"}
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              className="flex items-center"
                              onClick={(e) => {
                                e.stopPropagation();
                                setTicketToDelete(ticket.id);
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          
                          {openTickets.includes(ticket.id) && (
                            <ScrollArea className="h-[200px] mt-3 p-2 border rounded-md">
                              <div className="space-y-2">
                                {ticket.messages.map((message, index) => (
                                  <div key={index} className="text-xs p-2 border-b last:border-0">
                                    <div className="flex items-center justify-between">
                                      <Badge variant="outline" className="text-[10px]">
                                        {message.platform}
                                      </Badge>
                                      <span className="text-[10px] text-muted-foreground">
                                        {new Date(message.timestamp).toLocaleTimeString()}
                                      </span>
                                    </div>
                                    <div className="mt-1 line-clamp-2">{message.content}</div>
                                  </div>
                                ))}
                              </div>
                            </ScrollArea>
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