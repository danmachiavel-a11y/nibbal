import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { useState } from "react";

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

type Period = 'week' | 'month' | 'all';

export default function Stats() {
  // Get the Discord user ID from the authenticated user
  const discordId = "1273639721972531382"; // TODO: Get this from auth
  const [period, setPeriod] = useState<Period>('all');

  const { data: stats, isLoading } = useQuery<UserStats>({
    queryKey: [`/api/users/${discordId}/stats`, period]
  });

  const { data: workerStats } = useQuery<WorkerStats[]>({
    queryKey: ["/api/workers/stats", period]
  });

  const formatDate = (dateStr: string) => {
    return format(new Date(dateStr), 'MMM d, yyyy');
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
        <div className="flex gap-2">
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
        </div>
        {period !== 'all' && stats && (
          <p className="text-sm text-muted-foreground mt-2">
            Showing data from {formatDate(stats.periodStart)} to {formatDate(stats.periodEnd)}
          </p>
        )}
      </div>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Overall Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-primary/10 rounded-lg">
                <p className="text-sm font-medium text-muted-foreground">Total Earnings</p>
                <p className="text-2xl font-bold">${stats?.totalEarnings || 0}</p>
              </div>
              <div className="p-4 bg-primary/10 rounded-lg">
                <p className="text-sm font-medium text-muted-foreground">Tickets Completed</p>
                <p className="text-2xl font-bold">{stats?.ticketCount || 0}</p>
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
                  <h3 className="font-medium mb-2">Worker: {worker.username}</h3>
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