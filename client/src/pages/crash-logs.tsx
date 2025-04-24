import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useQuery } from '@tanstack/react-query';

interface CrashLog {
  timestamp: string;
  source: string;
  memory: string;
  uptime: string;
  error: string;
  rawLog: string;
}

export default function CrashLogs() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['/api/system/crash-logs'],
    queryFn: async () => {
      const response = await axios.get('/api/system/crash-logs');
      return response.data;
    },
  });

  const categorizeError = (errorText: string): string => {
    errorText = errorText.toLowerCase();
    if (errorText.includes('image') || errorText.includes('buffer') || errorText.includes('attachment')) {
      return 'Media Processing';
    } else if (errorText.includes('telegram') || errorText.includes('bot')) {
      return 'Telegram Bot';
    } else if (errorText.includes('discord')) {
      return 'Discord Bot';
    } else if (errorText.includes('database') || errorText.includes('sql')) {
      return 'Database';
    }
    return 'Other';
  };

  const formatTimestamp = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return timestamp; // Fallback to the original string if parsing fails
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-8">
        <h1 className="text-3xl font-bold mb-6">System Crash Logs</h1>
        <div className="text-center py-12">Loading crash logs...</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="container mx-auto p-8">
        <h1 className="text-3xl font-bold mb-6">System Crash Logs</h1>
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            Failed to load crash logs: {error instanceof Error ? error.message : 'Unknown error'}
          </AlertDescription>
        </Alert>
        <Button onClick={() => refetch()} className="mt-4">Retry</Button>
      </div>
    );
  }

  const logs = data?.logs || [];
  
  if (logs.length === 0) {
    return (
      <div className="container mx-auto p-8">
        <h1 className="text-3xl font-bold mb-6">System Crash Logs</h1>
        <Alert>
          <AlertTitle>No Crash Logs Found</AlertTitle>
          <AlertDescription>
            The system has not recorded any crashes. This is a good thing!
          </AlertDescription>
        </Alert>
        <Button onClick={() => refetch()} className="mt-4">Refresh</Button>
      </div>
    );
  }
  
  // Group logs by category for the categorized view
  const categories: Record<string, CrashLog[]> = {};
  logs.forEach((log: CrashLog) => {
    const category = categorizeError(log.error);
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push(log);
  });

  return (
    <div className="container mx-auto p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">System Crash Logs</h1>
        <Button onClick={() => refetch()}>Refresh</Button>
      </div>

      <Card className="mb-8">
        <CardHeader>
          <CardTitle>Crash Log Summary</CardTitle>
          <CardDescription>Found {logs.length} crash logs in the system</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            {Object.entries(categories).map(([category, logs]) => (
              <div key={category} className="flex flex-col items-center p-4 border rounded-lg shadow-sm">
                <span className="text-lg font-bold">{logs.length}</span>
                <Badge variant="outline">{category}</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="all">
        <TabsList className="mb-4">
          <TabsTrigger value="all">All Logs</TabsTrigger>
          <TabsTrigger value="categorized">Categorized</TabsTrigger>
        </TabsList>
        
        <TabsContent value="all">
          <Accordion type="single" collapsible className="w-full">
            {logs.map((log: CrashLog, index: number) => (
              <AccordionItem key={index} value={`item-${index}`}>
                <AccordionTrigger>
                  <div className="flex flex-col md:flex-row md:items-center md:gap-4 text-left">
                    <span className="font-medium">{formatTimestamp(log.timestamp)}</span>
                    <Badge variant="outline">{categorizeError(log.error)}</Badge>
                    <span className="text-sm opacity-70 truncate max-w-md">
                      {log.error.substring(0, 100)}{log.error.length > 100 ? '...' : ''}
                    </span>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="bg-muted p-4 rounded mb-2">
                    <div className="grid grid-cols-3 gap-4 mb-4">
                      <div>
                        <span className="font-semibold block">Source:</span>
                        {log.source}
                      </div>
                      <div>
                        <span className="font-semibold block">Memory:</span>
                        {log.memory}
                      </div>
                      <div>
                        <span className="font-semibold block">Uptime:</span>
                        {log.uptime}
                      </div>
                    </div>
                    <div>
                      <span className="font-semibold block mb-2">Error:</span>
                      <ScrollArea className="h-[200px] rounded border p-4 bg-background">
                        <pre className="whitespace-pre-wrap break-words text-sm">
                          {log.error}
                        </pre>
                      </ScrollArea>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </TabsContent>
        
        <TabsContent value="categorized">
          <div className="space-y-6">
            {Object.entries(categories).map(([category, categoryLogs]) => (
              <Card key={category}>
                <CardHeader>
                  <CardTitle>{category} Errors ({categoryLogs.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <Accordion type="single" collapsible className="w-full">
                    {categoryLogs.map((log: CrashLog, index: number) => (
                      <AccordionItem key={index} value={`${category}-${index}`}>
                        <AccordionTrigger>
                          <div className="flex flex-col md:flex-row md:items-center md:gap-4 text-left">
                            <span className="font-medium">{formatTimestamp(log.timestamp)}</span>
                            <span className="text-sm opacity-70 truncate max-w-md">
                              {log.error.substring(0, 100)}{log.error.length > 100 ? '...' : ''}
                            </span>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="bg-muted p-4 rounded mb-2">
                            <div className="grid grid-cols-3 gap-4 mb-4">
                              <div>
                                <span className="font-semibold block">Source:</span>
                                {log.source}
                              </div>
                              <div>
                                <span className="font-semibold block">Memory:</span>
                                {log.memory}
                              </div>
                              <div>
                                <span className="font-semibold block">Uptime:</span>
                                {log.uptime}
                              </div>
                            </div>
                            <div>
                              <span className="font-semibold block mb-2">Error:</span>
                              <ScrollArea className="h-[200px] rounded border p-4 bg-background">
                                <pre className="whitespace-pre-wrap break-words text-sm">
                                  {log.error}
                                </pre>
                              </ScrollArea>
                            </div>
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}