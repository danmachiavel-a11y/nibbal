import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, Calendar } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { format } from "date-fns";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

interface UserStats {
  totalEarnings: number;
  ticketCount: number;
  categoryStats: Array<{
    categoryId: number;
    categoryName: string;
    earnings: number;
    ticketCount: number;
  }>;
  periodStart: string;
  periodEnd: string;
}

interface WorkerStats {
  discordId: string;
  username: string;
  totalEarnings: number;
  ticketCount: number;
  periodStart: string;
  periodEnd: string;
}

type Period = 'week' | 'month' | 'all' | 'custom';

export default function Stats() {
  const discordId = "1273639721972531382"; // TODO: Get this from auth
  const [period, setPeriod] = useState<Period>('all');
  const [dateRange, setDateRange] = useState<{ from: Date; to: Date }>({
    from: new Date(),
    to: new Date()
  });
  const [isClearingStats, setIsClearingStats] = useState(false);

  // Force dates to the correct year (2025) for date range filtering
  // This ensures the date picker sends dates with the correct year
  const fixedDateRange = {
    from: new Date(dateRange.from),
    to: new Date(dateRange.to)
  };
  
  // Set to current system year (2025)
  if (fixedDateRange.from.getFullYear() !== 2025) {
    fixedDateRange.from.setFullYear(2025);
  }
  if (fixedDateRange.to.getFullYear() !== 2025) {
    fixedDateRange.to.setFullYear(2025);
  }
  
  // Debug information for date ranges - log to console
  if (period === 'custom') {
    console.log('Date range selected in UI:', {
      originalFrom: dateRange.from.toISOString(),
      originalTo: dateRange.to.toISOString(),
      correctedFrom: fixedDateRange.from.toISOString(),
      correctedTo: fixedDateRange.to.toISOString()
    });
  }

  const handleClearStats = async () => {
    setIsClearingStats(true);
    try {
      const response = await fetch('/api/earnings/clear-all', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      if (!response.ok) {
        throw new Error('Failed to clear statistics');
      }
      
      // Refresh the page to show updated stats
      window.location.reload();
    } catch (error) {
      console.error('Error clearing statistics:', error);
      alert('Failed to clear statistics. Please try again.');
    } finally {
      setIsClearingStats(false);
    }
  };
  
  // Construct query params with explicit debugging
  const queryParams = period === 'custom' 
    ? { 
        startDate: fixedDateRange.from.toISOString(), 
        endDate: fixedDateRange.to.toISOString() 
      }
    : { period };
    
  // Log the parameters we're actually using for API requests
  console.log('API request parameters:', queryParams);

  const { data: stats, isLoading } = useQuery<UserStats>({
    queryKey: [`/api/users/${discordId}/stats`, queryParams]
  });

  const { data: workerStats } = useQuery<WorkerStats[]>({
    queryKey: ["/api/workers/stats", queryParams]
  });

  const { data: overallStats } = useQuery<{
    totalPayments: number;
    totalAmount: number;
    workerStats: Array<{
      workerId: string;
      username: string | null;
      totalEarnings: number;
      totalTickets: number;
      lastPaymentDate: Date | null;
    }>;
    categoryStats: Array<{
      categoryId: number;
      categoryName: string;
      totalAmount: number;
      totalTickets: number;
    }>;
  }>({
    queryKey: ["/api/earnings/statistics"]
  });

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    // Show complete date with year always included 
    return format(date, 'MMM d, yyyy');
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-32 bg-gray-200 rounded"></div>
          <div className="h-40 bg-gray-200 rounded"></div>
          <div className="h-60 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6">
      <div className="mb-6">
        <Link href="/">
          <Button variant="ghost">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
        </Link>
      </div>

      <div className="mb-6">
        <div className="flex gap-2 flex-wrap items-center">
          <Button 
            variant={period === 'week' ? 'default' : 'outline'}
            onClick={() => setPeriod('week')}
          >
            This Week
          </Button>
          <Button 
            variant={period === 'month' ? 'default' : 'outline'}
            onClick={() => setPeriod('month')}
          >
            This Month
          </Button>
          <Button 
            variant={period === 'all' ? 'default' : 'outline'}
            onClick={() => setPeriod('all')}
          >
            All Time
          </Button>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant={period === 'custom' ? 'default' : 'outline'}
                className={cn(
                  "justify-start text-left font-normal",
                  !dateRange && "text-muted-foreground"
                )}
              >
                <Calendar className="mr-2 h-4 w-4" />
                {period === 'custom' ? (
                  <>
                    {/* Display the fixed date range with 2025 year */}
                    {format(fixedDateRange.from, "LLL dd, yyyy")} -{" "}
                    {format(fixedDateRange.to, "LLL dd, yyyy")}
                  </>
                ) : (
                  "Pick a date range"
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <CalendarComponent
                initialFocus
                mode="range"
                defaultMonth={fixedDateRange.from}
                selected={{
                  from: fixedDateRange.from,
                  to: fixedDateRange.to,
                }}
                onSelect={(range) => {
                  if (range?.from && range?.to) {
                    // Create new date objects with corrected year
                    const correctedFrom = new Date(range.from);
                    const correctedTo = new Date(range.to);
                    
                    // Force the year to 2025 for both dates
                    correctedFrom.setFullYear(2025);
                    correctedTo.setFullYear(2025);
                    
                    setDateRange({ 
                      from: correctedFrom, 
                      to: correctedTo 
                    });
                    setPeriod('custom');
                  }
                }}
                numberOfMonths={2}
              />
            </PopoverContent>
          </Popover>
        </div>

        <p className="text-sm text-muted-foreground mt-2">
          {period === 'custom' ? (
            <>
              {/* Show the fixed date range with 2025 year */}
              Showing data from {format(fixedDateRange.from, "MMM d, yyyy")} to {format(fixedDateRange.to, "MMM d, yyyy")}
            </>
          ) : stats ? (
            <>
              Showing data from {formatDate(stats.periodStart)} to {formatDate(stats.periodEnd)}
            </>
          ) : null}
          <span className="ml-2 text-xs">(Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone})</span>
        </p>
      </div>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle>Overall Statistics</CardTitle>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button 
                    variant="destructive" 
                    size="sm"
                    disabled={isClearingStats}
                  >
                    {isClearingStats ? "Clearing..." : "Clear All Stats"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear All Statistics</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete all earnings data, worker statistics, and reset all ticket amounts to zero. 
                      This action cannot be undone. Are you sure you want to continue?
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction 
                      onClick={handleClearStats}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Yes, Clear All Stats
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-primary/10 rounded-lg">
                <p className="text-sm font-medium text-muted-foreground">Total Earnings</p>
                <p className="text-2xl font-bold">${overallStats?.totalAmount || 0}</p>
              </div>
              <div className="p-4 bg-primary/10 rounded-lg">
                <p className="text-sm font-medium text-muted-foreground">Tickets Completed</p>
                <p className="text-2xl font-bold">{overallStats?.totalPayments || 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Worker Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {workerStats?.map(worker => (
                <div key={worker.discordId} className="border rounded-lg p-4">
                  <h3 className="font-medium mb-2">
                    Worker: {worker.username} 
                    <span className="text-sm text-muted-foreground ml-2">({worker.discordId})</span>
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Total Earnings</p>
                      <p className="text-lg font-medium">${worker.totalEarnings}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Tickets Completed</p>
                      <p className="text-lg font-medium">{worker.ticketCount}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Earnings by Category</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {stats?.categoryStats.map(stat => (
                <div key={stat.categoryId} className="border rounded-lg p-4">
                  <h3 className="font-medium mb-2">{stat.categoryName}</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Earnings</p>
                      <p className="text-lg font-medium">${stat.earnings}</p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Tickets</p>
                      <p className="text-lg font-medium">{stat.ticketCount}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}