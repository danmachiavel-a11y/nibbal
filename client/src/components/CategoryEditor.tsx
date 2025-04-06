import { useEffect } from 'react';
import { Form, FormField, FormItem, FormLabel, FormControl, FormDescription } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useForm } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Category } from "@shared/schema";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Info, RefreshCw } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

export async function refreshRoles(form: any, toast: any) {
  try {
    const res = await apiRequest("GET", "/api/discord/roles");
    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(`Failed to fetch Discord roles: ${errorData.message || res.statusText}`);
    }
    const roles = await res.json();
    form.setValue("discordRoles", roles);
  } catch (error: any) {
    toast({
      title: "Error",
      description: `Failed to load Discord roles: ${error.message}`,
      variant: "destructive"
    });
  }
}

export async function refreshCategories(form: any, toast: any) {
  try {
    const res = await apiRequest("GET", "/api/discord/categories");
    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(`Failed to fetch Discord categories: ${errorData.message || res.statusText}`);
    }
    const categories = await res.json();
    form.setValue("discordCategories", categories);
  } catch (error: any) {
    toast({
      title: "Error",
      description: `Failed to load Discord categories: ${error.message}`,
      variant: "destructive"
    });
  }
}

export function CategoryEditor({ category, categories }: { category: Category; categories: Category[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const form = useForm({
    defaultValues: {
      name: category.name,
      isSubmenu: category.isSubmenu,
      parentId: category.parentId,
      discordRoleId: category.discordRoleId || "",
      discordCategoryId: category.discordCategoryId || "",
      transcriptCategoryId: category.transcriptCategoryId || "",
      questions: Array.isArray(category.questions) ? category.questions.join('\n') : "",
      serviceSummary: category.serviceSummary || "",
      serviceImageUrl: category.serviceImageUrl || "",
      displayOrder: category.displayOrder || 0,
      newRow: category.newRow || false,
      isClosed: category.isClosed || false,
      discordCategories: [],
      discordRoles: []
    }
  });

  // Load Discord roles and categories
  useEffect(() => {
    const loadDiscordData = async () => {
      await Promise.all([
        refreshRoles(form, toast),
        refreshCategories(form, toast)
      ]);
    };
    
    loadDiscordData();
  }, []);

  const onSubmit = async (data: any) => {
    try {
      // Format questions as an array
      const questions = data.questions
        .split('\n')
        .filter((q: string) => q.trim())
        .map((q: string) => q.trim());

      // Convert displayOrder to number explicitly 
      const displayOrder = parseInt(data.displayOrder);
      
      // Prepare data for API
      const submitData = {
        name: data.name,
        isSubmenu: data.isSubmenu,
        parentId: data.parentId,
        discordRoleId: data.discordRoleId || "",
        discordCategoryId: data.discordCategoryId || "",
        transcriptCategoryId: data.transcriptCategoryId || "",
        questions,
        serviceSummary: data.serviceSummary,
        serviceImageUrl: data.serviceImageUrl,
        displayOrder: isNaN(displayOrder) ? 0 : displayOrder, // Default to 0 if NaN
        newRow: data.newRow,
        isClosed: data.isClosed
      };

      // Update the category
      const res = await apiRequest("PATCH", `/api/categories/${category.id}`, submitData);
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(`Failed to update category: ${errorData.message || res.statusText}`);
      }

      // Success notification
      toast({
        title: "Success",
        description: `Updated ${data.isSubmenu ? "submenu" : "category"}: ${data.name}`,
      });

      // Refresh categories list
      queryClient.invalidateQueries({ queryKey: ["/api/categories"] });
    } catch (error: any) {
      toast({
        title: "Error",
        description: `Failed to update category: ${error.message}`,
        variant: "destructive"
      });
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3 my-2">
        {/* Basic Details - First Row */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div className="md:col-span-2">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem className="mb-0">
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="displayOrder"
            render={({ field }) => (
              <FormItem className="mb-0">
                <FormLabel>Display Order</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    {...field}
                    onChange={(e) => field.onChange(parseInt(e.target.value))}
                  />
                </FormControl>
              </FormItem>
            )}
          />
          {!category.isSubmenu && (
            <div className="md:col-span-1">
              <FormField
                control={form.control}
                name="parentId"
                render={({ field }) => (
                  <FormItem className="mb-0">
                    <FormLabel>Parent Menu</FormLabel>
                    <FormControl>
                      <select
                        className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        value={field.value || ""}
                        onChange={(e) => field.onChange(e.target.value ? parseInt(e.target.value) : null)}
                      >
                        <option value="">Root (No Parent)</option>
                        {categories
                          ?.filter(cat => cat.isSubmenu && cat.id !== category.id)
                          .map(submenu => (
                            <option key={submenu.id} value={submenu.id}>{submenu.name}</option>
                          ))}
                      </select>
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
          )}
        </div>

        {/* Options Row */}
        <div className="flex flex-wrap md:flex-nowrap items-center gap-5">
          <FormField
            control={form.control}
            name="newRow"
            render={({ field }) => (
              <FormItem className="flex items-center gap-2.5">
                <FormControl>
                  <div className="relative flex items-center">
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={field.value}
                        onChange={field.onChange}
                        id={`newRowCheckbox-${category.id}`}
                        className="peer sr-only"
                      />
                      <div className="h-5 w-5 rounded border border-gray-300 bg-white peer-checked:bg-primary peer-checked:border-primary transition-colors"></div>
                      {field.value && (
                        <Check className="h-3.5 w-3.5 text-white absolute top-[3px] left-[3px]" />
                      )}
                    </div>
                  </div>
                </FormControl>
                <FormLabel htmlFor={`newRowCheckbox-${category.id}`} className="m-0 font-medium cursor-pointer select-none">
                  Start New Row
                </FormLabel>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="isClosed"
            render={({ field }) => (
              <FormItem className="flex items-center gap-2.5">
                <FormControl>
                  <div className="relative flex items-center">
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={field.value}
                        onChange={field.onChange}
                        id={`isClosedCheckbox-${category.id}`}
                        className="peer sr-only"
                      />
                      <div className="h-5 w-5 rounded border border-gray-300 bg-white peer-checked:bg-primary peer-checked:border-primary transition-colors"></div>
                      {field.value && (
                        <Check className="h-3.5 w-3.5 text-white absolute top-[3px] left-[3px]" />
                      )}
                    </div>
                  </div>
                </FormControl>
                <FormLabel htmlFor={`isClosedCheckbox-${category.id}`} className="m-0 font-medium cursor-pointer select-none">
                  Service Closed
                </FormLabel>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger className="ml-0.5">
                      <Info className="h-4 w-4 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>When closed, users will see a message saying</p>
                      <p>"This service is currently closed. Try again later."</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </FormItem>
            )}
          />
        </div>

        {/* Discord settings */}
        {!category.isSubmenu && (
          <>
            {/* Discord Section - Grid */}
            <div className="bg-muted/30 p-3 rounded-md border border-border/50">
              <h4 className="text-sm font-medium mb-2">Discord Configuration</h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* Discord Role */}
                <FormField
                  control={form.control}
                  name="discordRoleId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Discord Role</FormLabel>
                      <FormControl>
                        <select
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                          value={field.value || ""}
                          onChange={(e) => field.onChange(e.target.value)}
                        >
                          <option value="">Select a role</option>
                          {form.getValues("discordRoles")?.map((role: any) => (
                            <option key={role.id} value={role.id}>{role.name}</option>
                          ))}
                        </select>
                      </FormControl>
                      <p className="text-[10px] text-muted-foreground mt-1">Role pinged for new tickets</p>
                    </FormItem>
                  )}
                />

                {/* Active Tickets Category */}
                <FormField
                  control={form.control}
                  name="discordCategoryId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Active Tickets Category</FormLabel>
                      <FormControl>
                        <select
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                          value={field.value || ""}
                          onChange={(e) => field.onChange(e.target.value)}
                        >
                          <option value="">Select a category</option>
                          {form.getValues("discordCategories")?.map((category: any) => (
                            <option key={category.id} value={category.id}>{category.name}</option>
                          ))}
                        </select>
                      </FormControl>
                      <p className="text-[10px] text-muted-foreground mt-1">Where new ticket channels are created</p>
                    </FormItem>
                  )}
                />

                {/* Transcripts Category */}
                <FormField
                  control={form.control}
                  name="transcriptCategoryId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Transcripts Category</FormLabel>
                      <FormControl>
                        <select
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                          value={field.value || ""}
                          onChange={(e) => field.onChange(e.target.value)}
                        >
                          <option value="">Select a category</option>
                          {form.getValues("discordCategories")?.map((category: any) => (
                            <option key={category.id} value={category.id}>{category.name}</option>
                          ))}
                        </select>
                      </FormControl>
                      <p className="text-[10px] text-muted-foreground mt-1">Where closed tickets are moved</p>
                    </FormItem>
                  )}
                />
              </div>
              <Button 
                type="button" 
                variant="ghost" 
                size="sm"
                onClick={() => Promise.all([
                  refreshRoles(form, toast),
                  refreshCategories(form, toast)
                ])}
                className="mt-2 text-xs h-7 px-2 flex items-center gap-1"
              >
                <RefreshCw className="h-3 w-3" />
                <span>Refresh Discord Data</span>
              </Button>
            </div>

            {/* Content Configuration Section - Collapsible */}
            <div className="mt-3">
              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="service-details">
                  <AccordionTrigger className="py-2 hover:no-underline text-sm font-medium">
                    Service Details
                  </AccordionTrigger>
                  <AccordionContent className="pt-2">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="serviceSummary"
                        render={({ field }) => (
                          <FormItem className="mb-3">
                            <FormLabel className="text-xs">Service Summary</FormLabel>
                            <FormDescription className="text-[10px] mt-0">
                              Brief description shown to users. Markdown supported.
                            </FormDescription>
                            <FormControl>
                              <Textarea
                                {...field}
                                rows={3}
                                className="text-sm"
                                value={field.value || ''}
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      
                      <FormField
                        control={form.control}
                        name="serviceImageUrl"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Service Image URL</FormLabel>
                            <FormDescription className="text-[10px] mt-0">
                              Optional: Image URL for service description
                            </FormDescription>
                            <FormControl>
                              <Input {...field} value={field.value || ''} className="text-sm" />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </div>
                  </AccordionContent>
                </AccordionItem>
                
                <AccordionItem value="questions">
                  <AccordionTrigger className="py-2 hover:no-underline text-sm font-medium">
                    Questions ({ Array.isArray(category.questions) ? category.questions.length : 0 })
                  </AccordionTrigger>
                  <AccordionContent className="pt-2">
                    <FormField
                      control={form.control}
                      name="questions"
                      render={({ field }) => (
                        <FormItem>
                          <FormDescription className="text-xs mt-0 mb-1">
                            One question per line. These will be asked when a user selects this category.
                          </FormDescription>
                          <FormControl>
                            <Textarea
                              {...field}
                              rows={5}
                              className="text-sm"
                              placeholder="Enter your questions here, one per line."
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </>
        )}

        <div className="flex justify-end mt-6">
          <Button type="submit" className="min-w-24">Save Changes</Button>
        </div>
      </form>
    </Form>
  );
}